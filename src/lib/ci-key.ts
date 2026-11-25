import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnCapture, withSsh, type SshOptions } from './ssh.ts';
import { API_KEY_SECRET, SSH_KEY_SECRET, type GithubRepo } from './ci-workflow.ts';
import { createApiKey, deleteApiKey, deleteApiKeysLabelled } from './velastack-api.ts';

/**
 * A deploy key for CI: a keypair of its own, the public half on the server and
 * the private half in the repository's secrets.
 *
 * Three things here reach outside this machine's project directory — a key is
 * generated, a server's `authorized_keys` grows a line, a GitHub secret is
 * written — so each is a function handed in. The order, the confirmation, and
 * what is cleaned up and reported when a step fails are decided in
 * `setupCiKey`, and tested with stand-ins; the real ones are at the bottom.
 */

export interface CiKeyInput {
	appId: string;
	/** SSH destination production is bound to. */
	server: string;
	repo: GithubRepo;
	/** Skip the confirmation. */
	yes: boolean;
	/** Whether a confirmation can be shown at all. */
	interactive: boolean;
	/**
	 * Also issue a velastack.dev API key for CI and store it as a secret. Set
	 * for a linked project when this machine is logged in.
	 */
	apiKey?: { label: string };
}

export interface GeneratedKey {
	/** Directory holding both halves, removed when the setup ends either way. */
	dir: string;
	privateKeyPath: string;
	/** The one-line public key, comment included. */
	publicKey: string;
}

export interface CiKeyEffects {
	/** Fails, saying what to do, when `gh` is missing or not signed in. */
	checkGh: (repo: GithubRepo) => Promise<void>;
	generateKey: (comment: string) => Promise<GeneratedKey>;
	/** Append the public key to the server's `authorized_keys`, unless it is there. */
	installPublicKey: (server: string, publicKey: string) => Promise<'added' | 'present'>;
	/** Store the private key file's contents as a repository secret, without printing it. */
	setSecret: (repo: GithubRepo, name: string, privateKeyPath: string) => Promise<void>;
	removeDir: (dir: string) => void;
	/** Issue a new velastack.dev API key with this label. */
	mintApiKey: (label: string) => Promise<{ id: string; key: string }>;
	/** Store a value as a repository secret, without printing it. */
	setSecretValue: (repo: GithubRepo, name: string, value: string) => Promise<void>;
	revokeApiKey: (id: string) => Promise<void>;
	/** Revoke earlier keys with this label, which the new one replaces. */
	revokeOtherApiKeys: (label: string, keepId: string) => Promise<void>;
	/** Print exactly what is about to happen. Called whether or not a question follows. */
	showPlan: (plan: string[]) => void;
	/** Ask whether to go ahead with the plan just shown. */
	confirm: () => Promise<boolean>;
}

export type CiKeyOutcome =
	| { status: 'declined' }
	| {
			status: 'done';
			comment: string;
			installed: 'added' | 'present';
			/** Whether a velastack.dev API key was issued and stored too. */
			apiKey: boolean;
	  };

/** How a CI key shows on velastack.dev/api-keys. One per repository. */
export function ciApiKeyLabel(repo: GithubRepo): string {
	return `CI - ${repo.owner}/${repo.repo}`;
}

export function ciKeyComment(appId: string): string {
	return `vela-ci ${appId}`;
}

/** Exactly what will happen, in order, for the confirmation and for `--yes` runs alike. */
export function ciKeyPlan(
	input: Pick<CiKeyInput, 'appId' | 'server' | 'repo' | 'apiKey'>
): string[] {
	const repo = `${input.repo.owner}/${input.repo.repo}`;
	const apiKey = input.apiKey
		? [
				`Issue a velastack.dev API key labelled "${input.apiKey.label}" (it acts as your account, like the key \`vela login\` stores) and revoke any earlier key with that label`,
				`Store it as the ${API_KEY_SECRET} secret of github.com/${repo}, replacing a secret of that name if there is one`
			]
		: [];
	return [
		`Generate a new ed25519 keypair in a temporary directory (ssh-keygen, comment "${ciKeyComment(input.appId)}", no passphrase)`,
		`Append its public key to ~/.ssh/authorized_keys on ${input.server}`,
		`Store its private key as the ${SSH_KEY_SECRET} secret of github.com/${repo} (gh secret set), replacing a secret of that name if there is one`,
		'Delete the temporary keypair from this machine',
		...apiKey
	];
}

export async function setupCiKey(input: CiKeyInput, effects: CiKeyEffects): Promise<CiKeyOutcome> {
	if (!input.yes && !input.interactive) {
		throw new Error(
			'--setup-key changes a server and a GitHub repository, and there is no terminal to confirm on. Pass --yes to go ahead.'
		);
	}

	// Before anything is created: a key on the server with nowhere to put its
	// other half is worse than no key.
	await effects.checkGh(input.repo);

	// Shown with `--yes` too: skipping the question is not skipping the record
	// of what was done to a server and a repository.
	effects.showPlan(ciKeyPlan(input));
	if (!input.yes && !(await effects.confirm())) return { status: 'declined' };

	const comment = ciKeyComment(input.appId);
	const key = await effects.generateKey(comment);
	try {
		const installed = await effects.installPublicKey(input.server, key.publicKey);
		try {
			await effects.setSecret(input.repo, SSH_KEY_SECRET, key.privateKeyPath);
		} catch (error) {
			// The server now trusts a key whose private half is about to be
			// deleted. It can do no harm, but it should not be left unexplained.
			throw new Error(
				`The public key was added to ${input.server}, but storing the private key as the ${SSH_KEY_SECRET} secret failed:\n\n` +
					`${error instanceof Error ? error.message : String(error)}\n\n` +
					`The keypair has been deleted from this machine, so that line in ~/.ssh/authorized_keys on ${input.server} ` +
					`(it ends in "${comment}") opens nothing and can be removed. Fix the problem above and run the command again.`,
				{ cause: error }
			);
		}
		const apiKey = input.apiKey
			? await storeCiApiKey(input.repo, input.apiKey.label, effects)
			: false;
		return { status: 'done', comment, installed, apiKey };
	} finally {
		effects.removeDir(key.dir);
	}
}

/**
 * A key of its own for CI, never the one in `~/.vela`: `vela login` replaces
 * that one, and CI would stop being able to deploy the day someone logged in
 * again. The secret is stored before the keys it replaces are revoked, and a
 * key that could not be stored is revoked rather than left unused.
 */
async function storeCiApiKey(
	repo: GithubRepo,
	label: string,
	effects: CiKeyEffects
): Promise<boolean> {
	const minted = await effects.mintApiKey(label);
	try {
		await effects.setSecretValue(repo, API_KEY_SECRET, minted.key);
	} catch (error) {
		await effects.revokeApiKey(minted.id).catch(() => {});
		throw new Error(
			`The deploy key is set up, but storing the velastack.dev API key as the ${API_KEY_SECRET} secret failed:\n\n` +
				`${error instanceof Error ? error.message : String(error)}\n\n` +
				'The new API key has been revoked. Fix the problem above and run the command again.',
			{ cause: error }
		);
	}
	// The old ones only stop working; nothing is lost if this fails.
	await effects.revokeOtherApiKeys(label, minted.id).catch(() => {});
	return true;
}

/** The same steps for someone doing them by hand. */
export function manualKeySteps(facts: {
	appId?: string;
	server?: string;
	repo?: GithubRepo;
}): string[] {
	const comment = ciKeyComment(facts.appId ?? '<app>');
	const server = facts.server ?? '<user@server>';
	const repo = facts.repo ? ` -R ${facts.repo.owner}/${facts.repo.repo}` : '';
	return [
		`ssh-keygen -t ed25519 -N '' -C '${comment}' -f vela-ci-key`,
		`ssh-copy-id -i vela-ci-key.pub ${server}`,
		`gh secret set ${SSH_KEY_SECRET}${repo} < vela-ci-key`,
		'rm vela-ci-key vela-ci-key.pub'
	];
}

// --- the real side effects ---------------------------------------------------

/**
 * Appends one line, once. Runs as the user the SSH destination logs in as —
 * deliberately without the `sudo` the deploy scripts use, because the key has
 * to be in *that* user's file to let CI in as them.
 */
export const INSTALL_KEY_SCRIPT = `key="$1"
umask 077
mkdir -p "$HOME/.ssh"
file="$HOME/.ssh/authorized_keys"
touch "$file"
if grep -qxF -- "$key" "$file"; then echo PRESENT; exit 0; fi
# A file that does not end in a newline would get the key glued to its last line.
if [ -s "$file" ] && [ -n "$(tail -c 1 "$file")" ]; then printf '\\n' >> "$file"; fi
printf '%s\\n' "$key" >> "$file"
echo ADDED`;

export function realCiKeyEffects(
	sshOptions: SshOptions,
	ui: Pick<CiKeyEffects, 'showPlan' | 'confirm'>,
	/** The key this machine is logged in with, which issues and revokes the CI one. */
	accountKey: string | null = null
): CiKeyEffects {
	const account = (): string => {
		if (!accountKey) throw new Error('Not logged in to velastack.dev. Run `vela login`.');
		return accountKey;
	};
	const ghSecretSet = async (repo: GithubRepo, name: string, value: string): Promise<void> => {
		// On stdin, so the value is never an argument (visible in `ps`) and never
		// echoed; gh encrypts it for the repository before it leaves this machine.
		const result = await spawnCapture(
			'gh',
			['secret', 'set', name, '--repo', `${repo.owner}/${repo.repo}`],
			{ stdin: value }
		);
		if (result.exitCode !== 0) {
			throw new Error(result.stderr.trim() || `gh secret set exited with ${result.exitCode}.`);
		}
	};
	return {
		...ui,
		mintApiKey: (label) => createApiKey(account(), label),
		setSecretValue: ghSecretSet,
		revokeApiKey: (id) => deleteApiKey(account(), id),
		async revokeOtherApiKeys(label, keepId) {
			await deleteApiKeysLabelled(account(), label, keepId);
		},
		async checkGh(repo) {
			let version;
			try {
				version = await spawnCapture('gh', ['--version']);
			} catch {
				version = null;
			}
			if (!version || version.exitCode !== 0) {
				throw new Error(
					'--setup-key stores the key with the GitHub CLI, and `gh` is not installed.\n\n' +
						'Install it from https://cli.github.com and run `gh auth login`, or leave --setup-key off and follow the manual steps.'
				);
			}
			const auth = await spawnCapture('gh', ['auth', 'status', '--hostname', 'github.com']);
			if (auth.exitCode !== 0) {
				throw new Error(
					'--setup-key stores the key with the GitHub CLI, and `gh` is not signed in to github.com.\n\n' +
						`Run \`gh auth login\` with an account that can change the secrets of ${repo.owner}/${repo.repo}.`
				);
			}
		},
		async generateKey(comment) {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-ci-key-'));
			const privateKeyPath = path.join(dir, 'id_ed25519');
			try {
				const result = await spawnCapture('ssh-keygen', [
					'-q',
					'-t',
					'ed25519',
					'-N',
					'',
					'-C',
					comment,
					'-f',
					privateKeyPath
				]);
				if (result.exitCode !== 0) {
					throw new Error(`ssh-keygen failed.\n\n${result.stderr.trim()}`);
				}
				const publicKey = fs.readFileSync(`${privateKeyPath}.pub`, 'utf8').trim();
				return { dir, privateKeyPath, publicKey };
			} catch (error) {
				fs.rmSync(dir, { recursive: true, force: true });
				throw error;
			}
		},
		async installPublicKey(server, publicKey) {
			return await withSsh(server, sshOptions, async (session) => {
				const result = await session.script(INSTALL_KEY_SCRIPT, { args: [publicKey] });
				return result.stdout.includes('PRESENT') ? 'present' : 'added';
			});
		},
		async setSecret(repo, name, privateKeyPath) {
			await ghSecretSet(repo, name, fs.readFileSync(privateKeyPath, 'utf8'));
		},
		removeDir(dir) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	};
}
