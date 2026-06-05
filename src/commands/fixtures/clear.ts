import path from 'node:path';
import { Command } from 'commander';
import type PocketBase from 'pocketbase';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { withPocketbase } from '../../lib/pocketbase.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { dependencyOrder } from '../../lib/collections.ts';
import { FIXTURE_PREFIX } from '../../lib/constants.ts';
import { reportResult } from '../../lib/result-report.ts';
import { getFixtureFiles } from './load.ts';

export async function clearFixtures(pb: PocketBase, workspaceRootDir: string): Promise<string[]> {
	const fixturePathByName = new Map(
		getFixtureFiles(workspaceRootDir).map((f) => [f.collectionName, f.fixturePath])
	);

	const cleared: string[] = [];
	const fullList = await pb.collections.getFullList();
	const collections = fullList.map((c) => ({
		id: c.id,
		name: c.name,
		fields: c.fields.map((f) => ({
			type: f.type,
			collectionId: (f as { collectionId?: string }).collectionId
		}))
	}));

	const { names } = dependencyOrder(collections);
	const reversed = [...names].reverse();

	for (const collectionName of reversed) {
		const shortName = collectionName.slice(0, 6);
		const records = await pb.collection(collectionName).getFullList({
			filter: `id ~ "${FIXTURE_PREFIX}${shortName}%"`,
			fields: 'id'
		});

		if (records.length === 0) continue;

		for (const { id } of records) {
			await pb.collection(collectionName).delete(id);
		}
		const fixturePath = fixturePathByName.get(collectionName);
		const label = fixturePath ? path.relative(workspaceRootDir, fixturePath) : collectionName;
		cleared.push(`${label} (${records.length} records)`);
	}

	return cleared;
}

export const clear = new Command('clear')
	.description('clear loaded fixtures')
	.configureHelp(helpConfig)
	.action(() =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();
			let cleared: string[] = [];
			await withPocketbase(workspaceRootDir, async (pb) => {
				cleared = await clearFixtures(pb, workspaceRootDir);
			});

			if (cleared.length === 0) {
				reportResult({
					summary: 'No fixtures to clear.',
					nextSteps: [
						'Run `vela fixtures generate` to create fixture files.',
						'Run `vela fixtures load` to load them into the database.'
					]
				});
				return;
			}

			reportResult({
				summary: `Cleared ${cleared.length} fixture collection(s) from the database.`,
				recordsCleared: cleared,
				nextSteps: [
					'Run `vela fixtures load` to reload the existing fixture files.',
					'Run `vela fixtures generate --force` to regenerate fixture files from scratch.'
				]
			});
		}, 'Failed to clear fixtures.')
	);
