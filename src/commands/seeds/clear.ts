import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import type PocketBase from 'pocketbase';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { withPocketbase } from '../../lib/pocketbase.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { reportResult } from '../../lib/result-report.ts';
import { getSeedFiles } from './load.ts';

export async function clearSeeds(
	pb: PocketBase,
	workspaceRootDir: string,
	seedFiles: Array<{ collectionName: string; seedPath: string }>
): Promise<string[]> {
	const cleared: string[] = [];
	for (const { collectionName, seedPath } of seedFiles) {
		const seeds = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as Array<{ id: string }>;
		for (const { id } of seeds) {
			await pb.collection(collectionName).delete(id);
		}
		cleared.push(`${path.relative(workspaceRootDir, seedPath)} (${seeds.length} records)`);
	}
	return cleared;
}

export const clear = new Command('clear')
	.description('clear seeded records')
	.configureHelp(helpConfig)
	.action(() =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();
			const seedFiles = getSeedFiles(workspaceRootDir);

			if (seedFiles.length === 0) {
				reportResult({
					summary: 'No seed files found in data/seeds.',
					nextSteps: ['Run `vela seeds save` to create seed files from the current database.']
				});
				return;
			}

			let cleared: string[] = [];
			await withPocketbase(workspaceRootDir, async (pb) => {
				cleared = await clearSeeds(pb, workspaceRootDir, seedFiles);
			});

			if (cleared.length === 0) {
				reportResult({
					summary: 'No seeded records found to clear.',
					nextSteps: ['Run `vela seeds load` to load seed records into the database.']
				});
				return;
			}

			reportResult({
				summary: `Cleared ${cleared.length} seed file(s) worth of records.`,
				recordsCleared: cleared,
				nextSteps: ['Run `vela seeds load` to reload seeds from the files in data/seeds.']
			});
		}, 'Failed to clear seeds.')
	);
