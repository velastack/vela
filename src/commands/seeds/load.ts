import { Command } from 'commander';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { addTargetOptions, withTarget } from '../../lib/server-command.ts';
import { requireRemoteDatabase, withRemotePocketbase } from '../../lib/remote-pocketbase.ts';
import { withPocketbase } from '../../lib/pocketbase.ts';
import { hasBackend } from '../../lib/workspace.ts';
import {
	hasSuperuserCredentials,
	missingBackendMessage,
	missingCredentialsMessage
} from '../../lib/backend-gate.ts';
import { reportResult } from '../../lib/result-report.ts';
import {
	getSeedFiles,
	loadSeeds,
	summarizeSeedLoad,
	type DataFile,
	type SeedLoadResult
} from '../../lib/data.ts';

/**
 * Loads into whichever copy of the app `-t` names, and `local` unless told
 * otherwise: seeds are written and tried here first. `vela deploy` loads them
 * into the copy it deploys, so naming a deployed target is for the times
 * between deploys, or after a load that a deploy reported as failed.
 *
 * Either way only what is missing is created, so there is nothing to force.
 */
export const load = addTargetOptions(
	new Command('load')
		.description('load seeds into the database, creating the records not already there')
		.configureHelp(helpConfig),
	'local'
).action((raw: unknown) =>
	runCommand(
		() =>
			withTarget(
				raw,
				{
					local: async (ctx) => {
						if (!hasBackend(ctx.workspaceRootDir)) {
							throw new Error(missingBackendMessage('vela seeds load'));
						}
						const seedFiles = requireSeedFiles(ctx.workspaceRootDir);
						if (!seedFiles) return;

						// From `.env`, or exported in the shell or by CI: the program has
						// already read the file into this process without overriding it.
						if (!hasSuperuserCredentials()) throw new Error(missingCredentialsMessage());

						let loaded: SeedLoadResult[] = [];
						await withPocketbase(
							ctx.workspaceRootDir,
							async (pb) => {
								loaded = await loadSeeds(pb, ctx.workspaceRootDir, seedFiles);
							},
							undefined,
							// The app's hooks apply to a seed as to any other write, as
							// they do on a deployed copy and under `vela dev`.
							{ hooks: true }
						);

						report(loaded, [
							'Run `vela dev` to see the seeded data in the app.',
							'Run `vela seeds clear` to remove the seeded records.'
						]);
					},
					remote: async (ctx) => {
						const seedFiles = requireSeedFiles(ctx.workspaceRootDir);
						if (!seedFiles) return;
						await requireRemoteDatabase(ctx.session, ctx.instance);

						const loaded = await withRemotePocketbase(ctx.session, ctx.instance, (pb) =>
							loadSeeds(pb, ctx.workspaceRootDir, seedFiles)
						);

						report(
							loaded,
							[],
							` ${pc.dim('→')} ${pc.cyan(ctx.targetName)} ${pc.dim(`(${ctx.server})`)}`
						);
					}
				},
				{ label: 'seeds load' }
			),
		'Failed to load seeds.'
	)
);

/** The seed files, or nothing after saying there are none. */
function requireSeedFiles(workspaceRootDir: string): DataFile[] | null {
	const seedFiles = getSeedFiles(workspaceRootDir);
	if (seedFiles.length > 0) return seedFiles;
	reportResult({
		summary: 'No seed files found in data/seeds.',
		nextSteps: ['Run `vela seeds save` to snapshot the current database contents as seeds.']
	});
	return null;
}

function report(loaded: SeedLoadResult[], nextSteps: string[], where = ''): void {
	reportResult({
		summary: summarizeSeedLoad(loaded) + where,
		recordsLoaded: loaded.map((result) => result.label),
		nextSteps
	});
}
