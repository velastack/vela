import path from 'node:path';
import * as p from '@clack/prompts';
import { bySlug, type Slug } from '@velastack/patterns';
import { withPocketbase } from './pocketbase.ts';
import { getWorkspace } from './workspace.ts';
import { reportResult } from './result-report.ts';

export interface PatternReport {
	summary?: string;
	nextSteps?: string[];
	task: {
		title: string;
		success: string;
		error: string;
	};
}

function toRelative(root: string, filePath: string): string {
	return path.isAbsolute(filePath) ? path.relative(root, filePath) : filePath;
}

export async function runPattern(
	slug: Slug,
	argv: string[],
	input: Record<string, unknown>,
	report: PatternReport
): Promise<void> {
	const pattern = bySlug[slug];
	if (!pattern) {
		throw new Error(`Unknown pattern: ${slug}`);
	}

	const { workspaceRootDir, features } = await getWorkspace();

	const log = p.taskLog({ title: report.task.title });

	let result;
	try {
		result = await pattern.generate({
			argv,
			env: 'runtime',
			root: workspaceRootDir,
			features,
			input,
			// Patterns no longer read the schema themselves: @velastack/pocketbase-codegen
			// takes an injected client, and only the CLI knows how to reach (or spawn)
			// a PocketBase for this workspace.
			getCollections: async () => {
				const { getCollections } = await import('@velastack/pocketbase-codegen');
				let collections: Awaited<ReturnType<typeof getCollections>> = [];
				await withPocketbase(workspaceRootDir, async (pb) => {
					collections = await getCollections(pb);
				});
				return collections;
			},
			logger: { info: (message: string) => log.message(message) }
		});
		log.success(report.task.success);
	} catch (e) {
		log.error(report.task.error);
		throw e;
	}

	const rel = (f: string) => toRelative(workspaceRootDir, f);
	const totalChanges =
		result.creates.length +
		result.modifies.length +
		result.deletes.length +
		result.components.length +
		result.packages.length +
		result.collections.length;

	if (totalChanges === 0) {
		p.log.info(`${pattern.title ?? slug} produced no changes.`);
		return;
	}

	reportResult({
		summary: report.summary ?? `Applied ${pattern.title ?? slug}.`,
		filesCreated: result.creates.map((f: { path: string }) => rel(f.path)),
		filesModified: result.modifies.map((f: { path: string }) => rel(f.path)),
		filesDeleted: result.deletes.map((f: { path: string }) => rel(f.path)),
		componentsAdded: result.components,
		packagesInstalled: result.packages,
		collectionsAdded: result.collections.map((c: { name: string }) => c.name),
		nextSteps: report.nextSteps
	});
}
