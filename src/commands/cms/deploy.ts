import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { requireApiKey } from '../../lib/config.ts';
import { PROJECT_ID_RE } from '../../lib/link-on-create.ts';
import { readProjectConfig } from '../../lib/project-config.ts';
import { findWorkspaceRoot } from '../../lib/workspace.ts';
import {
	getSiteDeploy,
	startSiteDeploy,
	type SiteDeployRun,
	type SiteDeployState
} from '../../lib/velastack-api.ts';

const POLL_INTERVAL = 5_000;
/** The dashboard gives up on a build after this long, so a poll never outlives the run. */
const POLL_TIMEOUT = 30 * 60_000;

const inFlight = (run: SiteDeployRun | null | undefined) =>
	run?.status === 'pending' || run?.status === 'building';

/**
 * The admin bar's "Deploy Site…" from a terminal. A site velastack.dev hosts
 * is a prebuilt copy of a template, so what editors publish reaches visitors
 * only once the site is built again with that content. Nothing is built or
 * uploaded from here: velastack.dev runs the build and answers with its state.
 */
export const deploy = new Command('deploy')
	.description('rebuild the hosted site with the latest published content')
	.option(
		'--project <id>',
		'velastack.dev project whose site to rebuild, instead of the linked one'
	)
	.option('--no-wait', 'return once the build has started instead of waiting for it')
	.configureHelp(helpConfig)
	.action((options: { project?: string; wait: boolean }) =>
		runCommand(async () => {
			const projectId = resolveProjectId(options.project);
			const apiKey = requireApiKey();

			let state = await getSiteDeploy(apiKey, projectId).catch(rewordMissingRoute);
			if (!state.available) {
				throw new Error(
					'This project has no hosted site to rebuild.\n\n' +
						`A site deployed with ${pc.cyan('vela deploy')} is updated by deploying again.`
				);
			}
			const url = state.site?.url ?? '';

			if (inFlight(state.latest)) {
				p.log.info(`A deploy of ${pc.cyan(url)} is already in progress.`);
			} else {
				state = await startSiteDeploy(apiKey, projectId);
			}

			if (!options.wait) {
				p.log.success(
					`Build started for ${pc.cyan(url)} (deployment ${pc.dim(state.latest?.id ?? '')}).\n` +
						'It goes live when the build finishes.'
				);
				return;
			}

			const spinner = p.spinner();
			spinner.start(`Building ${url}`);
			let latest: SiteDeployRun | null | undefined;
			try {
				latest = await waitForRun(apiKey, projectId, state.latest?.id);
			} catch (error) {
				spinner.stop(`Could not follow the build of ${url}.`);
				throw error;
			}

			if (!latest) {
				spinner.stop(`Still building ${url}.`);
				p.log.warn(
					`The build has not finished after ${Math.round(POLL_TIMEOUT / 60_000)} minutes.\n` +
						'It goes live on its own if it does; the deployments page on velastack.dev shows how it ends.'
				);
				return;
			}
			if (latest.status === 'failed') {
				spinner.stop(`Deploy of ${url} failed.`);
				throw new Error(latest.error || 'the build did not finish');
			}
			spinner.stop(`Deployed ${pc.cyan(url)}`);
		}, 'Failed to deploy the site.')
	);

/** `--project` when given, else the link `vela link` recorded for this checkout. */
function resolveProjectId(explicit: string | undefined): string {
	if (explicit !== undefined) {
		if (!PROJECT_ID_RE.test(explicit)) {
			throw new Error(`${explicit} is not a velastack.dev project id.`);
		}
		return explicit;
	}
	const root = findWorkspaceRoot(process.cwd());
	const link = root ? readProjectConfig(root) : null;
	if (!link) {
		throw new Error(
			'This project is not linked to velastack.dev.\n\n' +
				`Run ${pc.cyan('vela link')}, or pass ${pc.cyan('--project <id>')}.`
		);
	}
	return link.projectId;
}

/** A dashboard from before this route answers 404, which reads as "no such project" otherwise. */
function rewordMissingRoute(error: unknown): never {
	if (error instanceof Error && /\(404\)/.test(error.message)) {
		throw new Error('velastack.dev does not support site deploys from the CLI yet.');
	}
	throw error;
}

/**
 * The run once it has ended, or null when it is still going at the deadline.
 * Follows the run by id: a deploy started elsewhere in the meantime is not the
 * one this command is reporting on.
 */
async function waitForRun(
	apiKey: string,
	projectId: string,
	runId: string | undefined
): Promise<SiteDeployRun | null> {
	const deadline = Date.now() + POLL_TIMEOUT;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
		const state: SiteDeployState = await getSiteDeploy(apiKey, projectId);
		const latest = state.latest;
		if (!latest || (runId && latest.id !== runId)) continue;
		if (!inFlight(latest)) return latest;
	}
	return null;
}
