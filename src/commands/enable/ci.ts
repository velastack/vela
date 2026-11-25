import path from 'node:path';
import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { addSshOptions, sshOptionsFrom } from '../../lib/ssh-options.ts';
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
	type Prerequisite,
	type ProjectFacts,
	type WriteOutcome
} from '../../lib/ci-workflow.ts';
import {
	manualKeySteps,
	realCiKeyEffects,
	setupCiKey,
	type CiKeyEffects,
	type CiKeyOutcome
} from '../../lib/ci-key.ts';

export interface EnableCiFlags {
	branch?: string;
	apiKeySecret?: boolean;
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
}

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
			'deploy on push: write a GitHub Actions workflow for velastack/action, check what it needs, and optionally set up the deploy key'
		)
		.option(
			'--branch <name>',
			'branch whose pushes deploy production — defaults to the one checked out, else main'
		)
		.option(
			'--api-key-secret',
			`pass the ${API_KEY_SECRET} repository secret to the action, so deploys are recorded on velastack.dev`
		)
		.option(
			'--previews',
			`also deploy a preview of every pull request and remove it on close (needs the ${API_KEY_SECRET} secret)`
		)
		.option('--force', 'overwrite an existing .github/workflows/deploy.yml')
		.option(
			'--setup-key',
			`create a deploy key for CI: add its public half to the server and store its private half as the ${SSH_KEY_SECRET} secret with \`gh\``
		)
		.option('-y, --yes', 'with --setup-key, go ahead without asking')
		.configureHelp(helpConfig)
).action((raw: EnableCiFlags) =>
	runCommand(async () => {
		const root = findWorkspaceRoot();
		if (!root) {
			throw new Error('There is no package.json here or above, so there is no project to deploy.');
		}
		const result = await enableCi(root, raw, {
			interactive: isInteractive(),
			keyEffects: realCiKeyEffects(sshOptionsFrom(raw), { showPlan, confirm: confirmPlan }),
			askSetupKey
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

	const content = renderDeployWorkflow({
		branch,
		backend: deps.backend ?? hasBackend(workspaceRootDir),
		apiKeySecret: flags.apiKeySecret,
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

	let wantsKey = flags.setupKey === true;
	if (!wantsKey && canSetUpKey && deps.interactive && !flags.yes) {
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
				interactive: deps.interactive
			},
			deps.keyEffects
		);
	}

	return { workflowFile, workflow, branch, prerequisites, key, facts };
}

async function askSetupKey(): Promise<boolean> {
	const answer = await p.confirm({
		message: `Set up a deploy key for CI now? (a new SSH key: public half to the server, private half to the ${SSH_KEY_SECRET} GitHub secret)`,
		initialValue: false
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
		'Setting up the deploy key',
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

	p.log.message(
		[
			'Before the first run:',
			...result.prerequisites.map(
				(check) => `  ${check.done ? pc.green('done ') : pc.yellow('to do')}  ${check.detail}`
			),
			keyLine(result)
		].join('\n')
	);

	if (result.key.status === 'done') {
		const repo = `${result.facts.github!.owner}/${result.facts.github!.repo}`;
		p.log.success(
			`Deploy key set up: ${result.key.installed === 'added' ? 'added to' : 'already on'} ${result.facts.server}, ` +
				`stored as ${SSH_KEY_SECRET} on ${repo}. The keypair is no longer on this machine.`
		);
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

export function nextSteps(
	result: Pick<EnableCiResult, 'branch' | 'facts'>,
	flags: Pick<EnableCiFlags, 'apiKeySecret' | 'previews'>
): string[] {
	const steps: string[] = [];
	if (flags.apiKeySecret || flags.previews) {
		steps.push(
			`Create an API key at https://velastack.dev/api-keys/new and store it: \`gh secret set ${API_KEY_SECRET}\`.` +
				(flags.previews ? ' Previews also need the project linked: `vela link`.' : '')
		);
	}
	steps.push(
		`Commit ${WORKFLOW_PATH} and .vela/project.json, then push \`${result.branch}\` to GitHub to run the first deploy.`,
		"The app's environment lives on the server, not in GitHub secrets: `vela env import <file> -t production` (or `vela env set <NAME> -t production`).",
		"Anything the build itself reads at build time has to be on the runner too: add it under the action step's `env` in the workflow."
	);
	return steps;
}
