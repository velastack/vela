import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import type PocketBase from 'pocketbase';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { withPocketbase } from '../../lib/pocketbase.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { FIXTURE_PREFIX } from '../../lib/constants.ts';
import { reportResult } from '../../lib/result-report.ts';

export function getFixtureFiles(
	cwd: string
): Array<{ collectionName: string; fixturePath: string }> {
	const fixturesDir = path.join(cwd, 'data', 'fixtures');
	if (!fs.existsSync(fixturesDir)) return [];
	return fs
		.readdirSync(fixturesDir)
		.filter((file) => file.endsWith('.json'))
		.map((file) => path.join(fixturesDir, file))
		.sort((a, b) => a.localeCompare(b))
		.map((fixturePath) => {
			const file = path.basename(fixturePath);
			const nameWithoutExt = file.replace(/\.json$/i, '');
			const collectionName = nameWithoutExt.replace(/^\d+[-_]?/, '');
			return { collectionName, fixturePath };
		});
}

export async function loadFixtures(pb: PocketBase, workspaceRootDir: string): Promise<string[]> {
	const fixtureFiles = getFixtureFiles(workspaceRootDir);
	if (fixtureFiles.length === 0) return [];

	const loaded: string[] = [];
	for (const { collectionName, fixturePath } of fixtureFiles) {
		const shortName = collectionName.slice(0, 6);
		const existing = await pb.collection(collectionName).getFullList({
			filter: `id ~ "${FIXTURE_PREFIX}${shortName}%"`,
			fields: 'id'
		});
		if (existing.length > 0) {
			throw new Error(
				`${collectionName} collection already has fixture records. ` +
					'Run `vela fixtures reset` to clear and reload, or `vela fixtures clear` first.'
			);
		}

		const items = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Array<
			Record<string, unknown>
		>;
		for (const fixture of items) {
			await pb.collection(collectionName).create(fixture);
		}
		loaded.push(`${path.relative(workspaceRootDir, fixturePath)} (${items.length} records)`);
	}
	return loaded;
}

export const load = new Command('load')
	.description('load fixtures into the database')
	.configureHelp(helpConfig)
	.action(() =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();
			let loaded: string[] = [];
			await withPocketbase(workspaceRootDir, async (pb) => {
				loaded = await loadFixtures(pb, workspaceRootDir);
			});

			if (loaded.length === 0) {
				reportResult({
					summary: 'No fixture files found in data/fixtures.',
					nextSteps: ['Run `vela fixtures generate` to create fixture files first.']
				});
				return;
			}

			reportResult({
				summary: `Loaded ${loaded.length} fixture file(s) into the database.`,
				recordsLoaded: loaded,
				nextSteps: [
					'Run `vela dev` to see the fixture data in the app.',
					'Run `vela fixtures clear` to remove the loaded fixture records.'
				]
			});
		}, 'Failed to load fixtures.')
	);
