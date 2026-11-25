import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { addSshOptions, sshOptionsFrom } from '../../lib/ssh-options.ts';
import { spawnCapture } from '../../lib/ssh.ts';
import { isInteractive } from '../../lib/providers.ts';
import { findWorkspaceRoot, hasBackend } from '../../lib/workspace.ts';
import {
	API_KEY_SECRET,
	checkPrerequisites,
	gatherProjectFacts,
	renderDeployWorkflow,
	SSH_KEY_SECRET,
	WORKFLOW_PATH,
	writeWorkflow,
	type GithubRepo,
	type Prerequisite,
	type ProjectFacts,
	type WriteOutcome
} from '../../lib/ci-workflow.ts';
import { readApiKey } from '../../lib/config.ts';
import {
	ciApiKeyLabel,
	manualKeySteps,
	realCiKeyEffects,
	setupCiKey,
	type CiKeyEffects,
	type CiKeyOutcome
} from '../../lib/ci-key.ts';

export interface EnableCiFlags {
	branch?: string;
	apiKeySecret?: boolean;
	/** `--no-api-key`: the workflow does not pass one, and none is issued. */
	apiKey?: boolean;
	previews?: boolean;
	force?: boolean;
	setupKey?: boolean;
	yes?: boolean;
	identity?: string;
	sshPort?: string;
	acceptHostKeys?: boolean;
}

export interface EnableCiResult {
	workflowFile: string;
	workflow: WriteOutcome;
	branch: string;
	prerequisites: Prerequisite[];
	key: CiKeyOutcome | { status: 'skipped' };
	facts: ProjectFacts;
	/** Where the workflow's velastack.dev API key stands. */
	apiKey: ApiKeyState;
	/** An existing workflow was kept, and it does not pass the API key the project needs. */
	workflowIgnoresApiKey: boolean;
}

/**
 * - `none`: the workflow passes no key (not linked, or `--no-api-key`).
 * - `stored`: issued and stored by this run.
 * - `present`: the repository already has the secret.
 * - `missing`: the workflow passes the secret and the repository does not have it.
 * - `unknown`: could not tell (no `gh`, no repository).
 */
export type ApiKeyState = 'none' | 'stored' | 'present' | 'missing' | 'unknown';

/**
 * CLI-only: it writes a workflow file and, when asked, sets up a deploy key.
 * Not a `@velastack/patterns` pattern — nothing in the app's source changes.
 *
 * Named `enable ci` rather than `generate workflow`, which already means a
 * background-job workflow.
 */
export const ci = addSshOptions(
	new Command('ci')
		.description(
			'deploy on push: write a GitHub Actions workflow for velastack/action and set up what it needs: a deploy key for the server and, for a linked project, a velastack.dev API key'
		)
		.option(
			'--branch <name>',
			'branch whose pushes deploy production — defaults to the one checked out, else main'
		)
		.option(
			'--api-key-secret',
			`pass the ${API_KEY_SECRET} repository secret to the action and set it yourself, rather than have one issued`
		)
		.option(
			'--no-api-key',
			`leave velastack.dev out of the workflow: no ${API_KEY_SECRET}, deploys are not recorded, and a velastack.app hostname is only kept, never given`
		)
		.option(
			'--previews',
			`also deploy a preview of every pull request and remove it on close (needs the ${API_KEY_SECRET} secret)`
		)
		.option('--force', 'overwrite an existing .github/workflows/deploy.yml')
		.option(
			'--setup-key',
			`only set up the secrets and leave an existing workflow as it is: the deploy key (${SSH_KEY_SECRET}) and, for a linked project, the API key (${API_KEY_SECRET})`
		)
		.option('-y, --yes', 'set up the secrets without asking')
		.configureHelp(helpConfig)
).action((raw: EnableCiFlags) =>
	runCommand(async () => {
		const root = findWorkspaceRoot();
		if (!root) {
			throw new Error('There is no package.json here or above, so there is no project to deploy.');
		}
		const result = await enableCi(root, raw, {
			interactive: isInteractive(),
			keyEffects: realCiKeyEffects(
				sshOptionsFrom(raw),
				{ showPlan, confirm: confirmPlan },
				readApiKey()
			),
			askSetupKey,
			loggedIn: readApiKey() !== null,
			secretExists
		});
		report(result, raw);
	}, 'Failed to set up CI.')
);

export interface EnableCiDeps {
	interactive: boolean;
	keyEffects: CiKeyEffects;
	/** Offer the key setup when `--setup-key` was not passed. */
	askSetupKey: () => Promise<boolean>;
	/** Whether the project has a PocketBase backend; read from disk when unset. */
	backend?: boolean;
	/** Whether this machine has a velastack.dev API key to issue another with. */
	loggedIn?: boolean;
	/** Whether the repository has a secret of this name; null when it cannot be told. */
	secretExists?: (repo: GithubRepo, name: string) => Promise<boolean | null>;
}

/**
 * The whole command, with every outside effect handed in. Returns what
 * happened rather than printing it, so a test can read the outcome.
 */
export async function enableCi(
	workspaceRootDir: string,
	flags: EnableCiFlags,
	deps: EnableCiDeps
): Promise<EnableCiResult> {
	const facts = await gatherProjectFacts(workspaceRootDir);
	const branch = flags.branch?.trim() || facts.branch || 'main';

	// The workflow belongs to the repository; the app may live below its root.
	const repoRoot = facts.gitRoot ?? workspaceRootDir;
	const workingDirectory = path.relative(repoRoot, workspaceRootDir).split(path.sep).join('/');
	const workflowFile = path.join(repoRoot, WORKFLOW_PATH);

	// A linked project deploys with a key unless told not to: velastack.dev is
	// where its deploys are recorded and its velastack.app hostname comes from.
	const passApiKey =
		flags.apiKey !== false &&
		(facts.linked || flags.apiKeySecret === true || flags.previews === true);
	// Issued here unless the user said they bring their own.
	const issueApiKey = passApiKey && facts.linked && !flags.apiKeySecret && deps.loggedIn === true;

	const content = renderDeployWorkflow({
		branch,
		backend: deps.backend ?? hasBackend(workspaceRootDir),
		apiKeySecret: passApiKey,
		previews: flags.previews,
		workingDirectory:
			workingDirectory && !workingDirectory.startsWith('..') ? workingDirectory : '',
		sshPort: flags.sshPort
	});
	// Everything `--setup-key` needs is checked before the workflow is written,
	// so a run that cannot finish does not leave half of itself behind.
	const prerequisites = checkPrerequisites(facts);
	const canSetUpKey = Boolean(facts.server && facts.appId && facts.github);
	if (flags.setupKey) {
		if (!canSetUpKey) {
			const missing = prerequisites
				.filter((check) => !check.done && check.id !== 'lockfile')
				.map((check) => `  ${check.detail}`);
			throw new Error(
				`--setup-key needs a server to add the key to and a GitHub repository to store it in.\n\n${missing.join('\n')}`
			);
		}
		if (!flags.yes && !deps.interactive) {
			throw new Error(
				`--setup-key changes a server and a GitHub repository, and there is no terminal to confirm on. Pass ${pc.cyan('--yes')} to go ahead.`
			);
		}
		await deps.keyEffects.checkGh(facts.github!);
	}

	const workflow = writeWorkflow(workflowFile, content, flags.force === true);
	if (workflow === 'kept' && !flags.setupKey) {
		throw new Error(
			`${WORKFLOW_PATH} already exists and differs from what this would write.\n\n` +
				`Pass ${pc.cyan('--force')} to overwrite it. To only set up the deploy key and leave the workflow as it is, pass ${pc.cyan('--setup-key')}.`
		);
	}

	// Setting the secrets up is the default: a workflow without them cannot
	// deploy. It still changes a server and a repository, so it wants a yes -
	// asked on a terminal, or given as `--yes`.
	let wantsKey = flags.setupKey === true || (canSetUpKey && flags.yes === true);
	if (!wantsKey && canSetUpKey && deps.interactive) {
		wantsKey = await deps.askSetupKey();
	}

	let key: EnableCiResult['key'] = { status: 'skipped' };
	if (wantsKey) {
		key = await setupCiKey(
			{
				appId: facts.appId!,
				server: facts.server!,
				repo: facts.github!,
				// The offer above was only a question about wanting one; the plan
				// still gets its own yes.
				yes: flags.yes === true,
				interactive: deps.interactive,
				apiKey: issueApiKey ? { label: ciApiKeyLabel(facts.github!) } : undefined
			},
			deps.keyEffects
		);
	}

	let apiKey: ApiKeyState = 'none';
	if (passApiKey) {
		if (key.status === 'done' && key.apiKey) apiKey = 'stored';
		else {
			const exists =
				facts.github && deps.secretExists
					? await deps.secretExists(facts.github, API_KEY_SECRET)
					: null;
			apiKey = exists === null ? 'unknown' : exists ? 'present' : 'missing';
		}
	}

	const workflowIgnoresApiKey =
		passApiKey &&
		workflow === 'kept' &&
		!/^\s+api-key:\s*\S/m.test(fs.readFileSync(workflowFile, 'utf8'));

	return {
		workflowFile,
		workflow,
		branch,
		prerequisites,
		key,
		facts,
		apiKey,
		workflowIgnoresApiKey
	};
}

/** Best effort: `gh` missing, signed out or without access reads as "cannot tell". */
async function secretExists(repo: GithubRepo, name: string): Promise<boolean | null> {
	try {
		const result = await spawnCapture('gh', [
			'secret',
			'list',
			'--repo',
			`${repo.owner}/${repo.repo}`,
			'--json',
			'name'
		]);
		if (result.exitCode !== 0) return null;
		return (JSON.parse(result.stdout) as Array<{ name: string }>).some(
			(secret) => secret.name === name
		);
	} catch {
		return null;
	}
}

async function askSetupKey(): Promise<boolean> {
	const answer = await p.confirm({
		message: `Set up the secrets the workflow deploys with now? (the exact steps are shown before anything changes)`,
		initialValue: true
	});
	if (p.isCancel(answer)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return answer;
}

function showPlan(plan: string[]): void {
	p.note(
		plan.map((step, index) => `${index + 1}. ${step}`).join('\n'),
		'Setting up what CI deploys with',
		{
			format: (line) => line
		}
	);
}

async function confirmPlan(): Promise<boolean> {
	const answer = await p.confirm({ message: 'Go ahead?', initialValue: false });
	if (p.isCancel(answer)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return answer;
}

function report(result: EnableCiResult, flags: EnableCiFlags): void {
	const relative = path.relative(process.cwd(), result.workflowFile) || result.workflowFile;
	switch (result.workflow) {
		case 'created':
			p.log.success(
				`Wrote ${pc.cyan(relative)}: pushes to ${pc.cyan(result.branch)} deploy production`
			);
			break;
		case 'overwritten':
			p.log.success(
				`Overwrote ${pc.cyan(relative)}: pushes to ${pc.cyan(result.branch)} deploy production`
			);
			break;
		case 'unchanged':
			p.log.info(`${pc.cyan(relative)} is already what this would write.`);
			break;
		case 'kept':
			p.log.warn(
				`${pc.cyan(relative)} exists and was left as it is. Pass ${pc.cyan('--force')} to overwrite it.`
			);
			break;
	}

	if (result.workflowIgnoresApiKey) {
		p.log.warn(
			`${pc.cyan(relative)} does not pass ${API_KEY_SECRET} to the action, so CI deploys are not recorded on velastack.dev.\n` +
				`Add ${pc.cyan(`api-key: \${{ secrets.${API_KEY_SECRET} }}`)} under the action's ${pc.cyan('with:')}, or pass ${pc.cyan('--force')} to rewrite the file.`
		);
	}

	p.log.message(
		[
			'Before the first run:',
			...result.prerequisites.map(
				(check) => `  ${check.done ? pc.green('done ') : pc.yellow('to do')}  ${check.detail}`
			),
			keyLine(result),
			...apiKeyLines(result, flags)
		].join('\n')
	);

	if (result.key.status === 'done') {
		const repo = `${result.facts.github!.owner}/${result.facts.github!.repo}`;
		p.log.success(
			`Deploy key set up: ${result.key.installed === 'added' ? 'added to' : 'already on'} ${result.facts.server}, ` +
				`stored as ${SSH_KEY_SECRET} on ${repo}. The keypair is no longer on this machine.`
		);
		if (result.key.apiKey) {
			p.log.success(
				`API key issued: "${ciApiKeyLabel(result.facts.github!)}" on velastack.dev/api-keys, stored as ${API_KEY_SECRET} on ${repo}.`
			);
		}
		p.log.message(
			pc.dim(
				`Running this again makes a new key and leaves the old line on the server; lines ending in "${result.key.comment}" that CI no longer uses can be removed from ~/.ssh/authorized_keys.`
			)
		);
	} else {
		if (result.key.status === 'declined') p.log.info('No deploy key was set up.');
		p.note(
			[
				...manualKeySteps({
					appId: result.facts.appId,
					server: result.facts.server,
					repo: result.facts.github
				}),
				'',
				`Or let vela do the same: ${pc.cyan('vela enable ci --setup-key')}`
			].join('\n'),
			'To give the workflow a deploy key',
			{ format: (line) => line }
		);
	}

	p.note(
		nextSteps(result, flags)
			.map((step) => `- ${step}`)
			.join('\n'),
		'Next steps',
		{ format: (line) => line }
	);
}

function keyLine(result: EnableCiResult): string {
	return result.key.status === 'done'
		? `  ${pc.green('done ')}  ${SSH_KEY_SECRET} repository secret holds a deploy key the server accepts`
		: `  ${pc.yellow('to do')}  ${SSH_KEY_SECRET} repository secret: a private key the server accepts (steps below)`;
}

/** The checklist line for the API key; nothing when the workflow passes none. */
export function apiKeyLines(
	result: Pick<EnableCiResult, 'apiKey' | 'facts'>,
	flags: Pick<EnableCiFlags, 'apiKeySecret'>
): string[] {
	const repo = result.facts.github
		? ` -R ${result.facts.github.owner}/${result.facts.github.repo}`
		: '';
	const byHand = `create a key at https://velastack.dev/api-keys/new and \`gh secret set ${API_KEY_SECRET}${repo}\``;
	switch (result.apiKey) {
		case 'none':
			return [];
		case 'stored':
			return [
				`  ${pc.green('done ')}  ${API_KEY_SECRET} repository secret holds an API key issued for this repository`
			];
		case 'present':
			return [`  ${pc.green('done ')}  ${API_KEY_SECRET} repository secret is set`];
		case 'unknown':
			return [
				`  ${pc.yellow('check')}  ${API_KEY_SECRET} repository secret: could not see whether it is set. Without it deploys are not recorded on velastack.dev and a velastack.app hostname is not given: ${byHand}`
			];
		case 'missing':
			return [
				`  ${pc.yellow('to do')}  ${API_KEY_SECRET} repository secret is not set, so deploys would not be recorded on velastack.dev and no velastack.app hostname given: ` +
					(flags.apiKeySecret
						? byHand
						: `\`vela login\`, then \`vela enable ci --setup-key\` issues and stores one (or ${byHand})`)
			];
	}
}

export function nextSteps(
	result: Pick<EnableCiResult, 'branch' | 'facts'>,
	flags: Pick<EnableCiFlags, 'apiKeySecret' | 'previews'>
): string[] {
	const steps: string[] = [];
	if (flags.previews) steps.push('Previews need the project linked: `vela link`.');
	steps.push(
		`Commit ${WORKFLOW_PATH} and .vela/project.json, then push \`${result.branch}\` to GitHub to run the first deploy.`,
		"The app's environment lives on the server, not in GitHub secrets: `vela env import <file> -t production` (or `vela env set <NAME> -t production`).",
		"Anything the build itself reads at build time has to be on the runner too: add it under the action step's `env` in the workflow."
	);
	return steps;
}
