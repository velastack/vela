import path from 'node:path';
import * as p from '@clack/prompts';
import { bySlug, type Slug } from '@velastack/patterns';
import { withPocketbase } from './pocketbase.ts';
import { getWorkspace } from './workspace.ts';
import { reportResult, type ReportFailure } from './result-report.ts';

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

/**
 * What a pattern hands back for one file.
 *
 * A modifier that refuses to touch a file it doesn't recognise reports
 * `failed` / `not-found` plus a remediation snippet. Those entries are new
 * here: `writeResult` used to drop them, so a partial application was reported
 * as a clean success and the snippet was never seen. Partitioning on `status`
 * is what keeps a failure out of the "created"/"modified" lists.
 */
interface ResultFile {
	path: string;
	status?: 'success' | 'failed' | 'not-found';
	message?: string;
}

const isSuccess = (f: ResultFile) => (f.status ?? 'success') === 'success';

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

	const files: ResultFile[] = [...result.creates, ...result.modifies, ...result.deletes];
	const failures: ReportFailure[] = files
		.filter((f) => !isSuccess(f))
		.map((f) => ({
			path: rel(f.path),
			status: f.status === 'not-found' ? 'not-found' : 'failed',
			message: f.message
		}));

	const created = result.creates.filter(isSuccess);
	const modified = result.modifies.filter(isSuccess);
	const deleted = result.deletes.filter(isSuccess);

	const totalChanges =
		created.length +
		modified.length +
		deleted.length +
		result.components.length +
		result.packages.length +
		result.collections.length;

	// A run that only produced failures still has something to say.
	if (totalChanges === 0 && failures.length === 0) {
		p.log.info(`${pattern.title ?? slug} produced no changes.`);
		return;
	}

	reportResult({
		summary: report.summary ?? `Applied ${pattern.title ?? slug}.`,
		filesCreated: created.map((f: { path: string }) => rel(f.path)),
		filesModified: modified.map((f: { path: string }) => rel(f.path)),
		filesDeleted: deleted.map((f: { path: string }) => rel(f.path)),
		componentsAdded: result.components,
		packagesInstalled: result.packages,
		collectionsAdded: result.collections.map((c: { name: string }) => c.name),
		failures,
		// Next steps assume the pattern applied; when part of it didn't, the
		// remediation snippets above are the actual next step.
		nextSteps: failures.length > 0 ? undefined : report.nextSteps
	});
}
