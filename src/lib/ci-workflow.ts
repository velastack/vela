import fs from 'node:fs';
import path from 'node:path';
import { readAppIdentity, readBinding } from './deploy-config.ts';
import { PROD_ENV } from './instance.ts';
import { readProjectConfig } from './project-config.ts';
import { spawnCapture } from './ssh.ts';

/**
 * The deploy-on-push workflow for `velastack/action`, and what it depends on.
 *
 * Everything the workflow needs to know is already in the repository: the
 * action reads the server and domain from the committed `.vela/project.json`
 * and defaults to the production target, so the file written here names
 * neither.
 */

export const WORKFLOW_PATH = '.github/workflows/deploy.yml';
export const SSH_KEY_SECRET = 'SSH_PRIVATE_KEY';
export const API_KEY_SECRET = 'VELA_API_KEY';

/** The action release this CLI writes workflows for. */
const ACTION_REF = 'velastack/action@v1';
const CHECKOUT_REF = 'actions/checkout@v6';

export interface WorkflowOptions {
	/** Branch whose pushes deploy production. */
	branch: string;
	/** The project has PocketBase, so the CLI on the runner wants superuser variables set. */
	backend: boolean;
	/** Pass `api-key`, rather than leaving it commented out. On for a linked project. */
	apiKeySecret?: boolean;
	/** Also deploy a preview of every pull request, and remove it on close. */
	previews?: boolean;
	/** The app's directory inside the repository, when it is not the root. */
	workingDirectory?: string;
	/** The server's SSH port, when it is not 22. */
	sshPort?: string;
}

/**
 * A value as a YAML scalar: quoted unless it is plainly safe bare. Words YAML
 * reads as something other than a string (`true`, `no`, `1.0`, `null`) are
 * quoted too, so a branch called `on` stays a branch.
 */
function yamlScalar(value: string): string {
	const bare =
		/^[A-Za-z_][A-Za-z0-9_./-]*$/.test(value) &&
		!/^(true|false|yes|no|on|off|null|y|n)$/i.test(value) &&
		!/^[0-9.]/.test(value);
	return bare ? value : JSON.stringify(value);
}

export function renderDeployWorkflow(options: WorkflowOptions): string {
	const { branch, backend, previews = false } = options;
	// Previews are named by velastack.dev, so they need the key.
	const apiKey = options.apiKeySecret === true || previews;
	const lines: string[] = [];
	const add = (...more: string[]) => lines.push(...more);

	add(
		'# Written by `vela enable ci`. Yours to edit; run it again with --force to start over.',
		'name: Deploy',
		'',
		'on:',
		`  # Every push to \`${branch}\` deploys production.`,
		'  push:',
		`    branches: [${yamlScalar(branch)}]`
	);
	if (previews) {
		add(
			'  # Every pull request gets a preview of its branch, removed when it closes.',
			'  pull_request:',
			'    types: [opened, synchronize, reopened, closed]'
		);
	}
	add('  workflow_dispatch:', '', 'permissions:', '  contents: read');
	if (previews) add('  # For the comment that carries the preview URL.', '  pull-requests: write');
	add(
		'',
		'# Two pushes to the same branch queue instead of deploying over each other.',
		'concurrency:',
		previews
			? '  group: vela-${{ github.head_ref || github.ref_name }}'
			: '  group: deploy-production',
		'  cancel-in-progress: false',
		'',
		'jobs:',
		'  deploy:'
	);
	if (previews) {
		add(
			'    # A pull request from a fork has no access to the secrets, so there is',
			'    # nothing it could deploy with.',
			"    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository"
		);
	}
	add(
		'    runs-on: ubuntu-latest',
		'    timeout-minutes: 20',
		'    steps:',
		`      - uses: ${CHECKOUT_REF}`,
		'',
		'      # Which server, and which domain, come from the committed',
		'      # .vela/project.json. The target defaults to production, which is the',
		previews
			? '      # `prod` entry there; a pull request deploys `preview:<branch>` instead.'
			: '      # `prod` entry there.',
		`      - uses: ${ACTION_REF}`,
		'        with:',
		`          ssh-key: \${{ secrets.${SSH_KEY_SECRET} }}`
	);
	if (options.sshPort) add(`          ssh-port: ${yamlScalar(options.sshPort)}`);
	if (options.workingDirectory) {
		add(`          working-directory: ${yamlScalar(options.workingDirectory)}`);
	}
	if (apiKey) {
		add(
			previews
				? '          # Records each deploy on velastack.dev, and gives previews their hostname.'
				: '          # Records each deploy on velastack.dev, which is also where a',
			...(previews ? [] : ['          # velastack.app hostname comes from.']),
			`          api-key: \${{ secrets.${API_KEY_SECRET} }}`
		);
	} else {
		add(
			'          # To record deploys on velastack.dev (and get a velastack.app hostname):',
			'          # `vela link`, then run `vela enable ci --force` again, which issues a',
			`          # key and stores it as the ${API_KEY_SECRET} secret.`,
			`          # api-key: \${{ secrets.${API_KEY_SECRET} }}`
		);
	}
	if (backend) {
		add(
			'        env:',
			'          # Placeholders, not credentials. vela wants a PocketBase superuser',
			'          # named before it deploys, and logs in with these to the throwaway',
			'          # database a build starts on the runner when the target has none yet',
			'          # (a first deploy, a new preview). A build against the deployed',
			'          # database uses the real ones, which stay on the server.',
			'          POCKETBASE_SUPERUSER_EMAIL: ci@example.com',
			'          POCKETBASE_SUPERUSER_PASSWORD: ci-build-only-password',
			"          # The app's own environment lives on the server (`vela env import",
			'          # <file> -t production`), not here. Only what the *build* reads has',
			'          # to be on the runner too, e.g.:',
			'          # PUBLIC_SITE_URL: https://example.com'
		);
	} else {
		add(
			"        # The app's own environment lives on the server (`vela env import",
			'        # <file> -t production`), not here. Only what the *build* reads has to',
			'        # be on the runner too:',
			'        # env:',
			'        #   PUBLIC_SITE_URL: https://example.com'
		);
	}
	return lines.join('\n') + '\n';
}

export interface GithubRepo {
	owner: string;
	repo: string;
}

/** `owner/repo` out of a GitHub remote URL, in any of the forms git writes. */
export function parseGithubRemote(url: string): GithubRepo | null {
	const match = url
		.trim()
		.match(
			/^(?:git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/|https?:\/\/(?:[^@/]+@)?github\.com\/|git:\/\/github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/
		);
	return match ? { owner: match[1]!, repo: match[2]! } : null;
}

export interface ProjectFacts {
	/** `package-lock.json`, `pnpm-lock.yaml`, another manager's, or none. */
	lockfiles: string[];
	/** Server production is bound to in `.vela/project.json`. */
	server?: string;
	appId?: string;
	/** Root of the git repository, when the project is in one. */
	gitRoot?: string;
	/** Whether `.vela/project.json` is tracked by git. */
	projectFileTracked: boolean;
	github?: GithubRepo;
	/** Linked to a velastack.dev project, which is what an API key is for. */
	linked: boolean;
	/** Remote URLs that are not GitHub's, for the message. */
	otherRemotes: string[];
	/** Branch checked out, when there is one. */
	branch?: string;
}

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

async function git(cwd: string, args: string[]): Promise<string | null> {
	try {
		const result = await spawnCapture('git', args, { cwd });
		return result.exitCode === 0 ? result.stdout.trim() : null;
	} catch {
		// No git on this machine reads the same as no repository.
		return null;
	}
}

/** Read everything the checks and the workflow need, changing nothing. */
export async function gatherProjectFacts(workspaceRootDir: string): Promise<ProjectFacts> {
	const lockfiles = LOCKFILES.filter((name) => fs.existsSync(path.join(workspaceRootDir, name)));
	const facts: ProjectFacts = {
		lockfiles,
		server: readBinding(workspaceRootDir, PROD_ENV)?.server,
		// Read, never minted: a project that has not deployed must not be left
		// with an id for having asked about CI.
		appId: readAppIdentity(workspaceRootDir)?.appId,
		projectFileTracked: false,
		linked: readProjectConfig(workspaceRootDir) !== null,
		otherRemotes: []
	};

	const gitRoot = await git(workspaceRootDir, ['rev-parse', '--show-toplevel']);
	if (!gitRoot) return facts;
	facts.gitRoot = gitRoot;
	// Works on a branch with no commits yet, where `rev-parse HEAD` does not.
	facts.branch =
		(await git(workspaceRootDir, ['symbolic-ref', '--short', '-q', 'HEAD'])) || undefined;
	facts.projectFileTracked =
		(await git(workspaceRootDir, ['ls-files', '--error-unmatch', '.vela/project.json'])) !== null;

	const names = ((await git(workspaceRootDir, ['remote'])) ?? '').split('\n').filter(Boolean);
	// `origin` first: it is where a push goes, so it is the repository whose
	// Actions would run.
	names.sort((a, b) => Number(b === 'origin') - Number(a === 'origin'));
	for (const name of names) {
		const url = await git(workspaceRootDir, ['remote', 'get-url', name]);
		if (!url) continue;
		const parsed = parseGithubRemote(url);
		if (parsed) facts.github ??= parsed;
		else facts.otherRemotes.push(url);
	}
	return facts;
}

export interface Prerequisite {
	id: 'lockfile' | 'target' | 'project-file' | 'github';
	done: boolean;
	/** What is there, or what to do. */
	detail: string;
}

/** What the workflow needs before its first run, each either there or to do. */
export function checkPrerequisites(facts: ProjectFacts): Prerequisite[] {
	const checks: Prerequisite[] = [];

	const foreign = facts.lockfiles.find(
		(name) => name !== 'package-lock.json' && name !== 'pnpm-lock.yaml'
	);
	if (facts.lockfiles.includes('package-lock.json')) {
		checks.push({
			id: 'lockfile',
			done: true,
			detail: facts.lockfiles.includes('pnpm-lock.yaml')
				? 'package-lock.json: the action installs with `npm ci` (it prefers npm when a pnpm-lock.yaml is there too)'
				: 'package-lock.json: the action installs with `npm ci`'
		});
	} else if (facts.lockfiles.includes('pnpm-lock.yaml')) {
		checks.push({
			id: 'lockfile',
			done: true,
			detail: 'pnpm-lock.yaml: the action installs with `pnpm install --frozen-lockfile`'
		});
	} else if (foreign) {
		checks.push({
			id: 'lockfile',
			done: false,
			detail:
				`The only lockfile is ${foreign}, and the action installs with npm or pnpm. ` +
				'Commit a package-lock.json (`npm install --package-lock-only`) or a pnpm-lock.yaml, ' +
				'or install dependencies in a step of your own and set `install: false` on the action.'
		});
	} else {
		checks.push({
			id: 'lockfile',
			done: false,
			detail:
				'No lockfile. The action installs from a package-lock.json (`npm ci`) or a pnpm-lock.yaml: run `npm install` and commit the lockfile.'
		});
	}

	checks.push(
		facts.server
			? {
					id: 'target',
					done: true,
					detail: `production runs on ${facts.server} (.vela/project.json)`
				}
			: {
					id: 'target',
					done: false,
					detail:
						'No server is recorded for production. Deploy once from this machine first: `vela deploy --server <user@host> --domain <example.com>`'
				}
	);

	if (facts.server || facts.appId) {
		checks.push(
			facts.projectFileTracked
				? { id: 'project-file', done: true, detail: '.vela/project.json is in git' }
				: {
						id: 'project-file',
						done: false,
						detail:
							'.vela/project.json is not in git, and the action refuses to deploy without it: `git add .vela/project.json` and commit.'
					}
		);
	}

	if (!facts.gitRoot) {
		checks.push({
			id: 'github',
			done: false,
			detail:
				'Not a git repository. `git init`, create a repository on GitHub, then `git remote add origin git@github.com:<owner>/<repo>.git`.'
		});
	} else if (!facts.github) {
		checks.push({
			id: 'github',
			done: false,
			detail: facts.otherRemotes.length
				? `No GitHub remote (found ${facts.otherRemotes[0]}). The workflow only runs on GitHub: \`git remote add github git@github.com:<owner>/<repo>.git\`.`
				: 'No GitHub remote. Create a repository on GitHub, then `git remote add origin git@github.com:<owner>/<repo>.git`.'
		});
	} else {
		checks.push({
			id: 'github',
			done: true,
			detail: `GitHub repository ${facts.github.owner}/${facts.github.repo}`
		});
	}

	return checks;
}

export type WriteOutcome = 'created' | 'overwritten' | 'unchanged' | 'kept';

/**
 * Write the workflow, never over one that is already there unless told to:
 * a workflow is a file people edit, and this command is safe to run twice.
 */
export function writeWorkflow(file: string, content: string, force: boolean): WriteOutcome {
	if (fs.existsSync(file)) {
		if (fs.readFileSync(file, 'utf8') === content) return 'unchanged';
		if (!force) return 'kept';
		fs.writeFileSync(file, content);
		return 'overwritten';
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return 'created';
}
