import { Command, InvalidArgumentError } from 'commander';
import * as p from '@clack/prompts';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { withPocketbase } from '../../lib/pocketbase.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { reportResult } from '../../lib/result-report.ts';
import { clearFixtures } from './clear.ts';
import { loadFixtures } from './load.ts';
import { generateFixtureFiles, type GenerateFixturesResult } from './generate.ts';

function parseCount(value: string): number {
	const n = parseInt(value, 10);
	if (!Number.isFinite(n) || n <= 0 || n > 999) {
		throw new InvalidArgumentError('count must be between 1 and 999');
	}
	return n;
}

function parseSeed(value: string): number {
	const n = parseInt(value, 10);
	if (!Number.isFinite(n)) {
		throw new InvalidArgumentError('seed must be an integer');
	}
	return n;
}

export const regen = new Command('regen')
	.description('clear the database, regenerate fixture files, and reload them')
	.option('-c, --count <count>', 'number of records per collection', parseCount, 10)
	.option('-s, --seed <seed>', 'seed for deterministic output', parseSeed)
	.configureHelp(helpConfig)
	.action((opts: { count: number; seed?: number }) =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();
			let cleared: string[] = [];
			let result: GenerateFixturesResult = { writtenFiles: [], warnings: [] };
			let loaded: string[] = [];
			await withPocketbase(workspaceRootDir, async (pb) => {
				cleared = await clearFixtures(pb, workspaceRootDir);
				result = await generateFixtureFiles(pb, workspaceRootDir, {
					count: opts.count,
					seed: opts.seed
				});
				loaded = await loadFixtures(pb, workspaceRootDir);
			});

			for (const warning of result.warnings) p.log.warn(warning);

			reportResult({
				summary: `Regenerated fixtures (${loaded.length} collection(s) reloaded).`,
				filesCreated: result.writtenFiles,
				recordsCleared: cleared,
				recordsLoaded: loaded,
				nextSteps: [
					'Run `vela dev` to see the new fixture data in the app.',
					'Edit data/fixtures/*.json or tweak `-c/--count` and re-run to adjust the dataset.'
				]
			});
		}, 'Failed to regenerate fixtures.')
	);
