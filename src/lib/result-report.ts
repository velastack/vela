import * as p from '@clack/prompts';

/**
 * A file a pattern could not change, and what the user should do about it.
 *
 * Modifiers do best-effort surgery on files the project owns, so they meet
 * shapes they don't recognise — a renamed export, a different wrapper, a config
 * that isn't an object literal. When that happens they refuse to touch the file
 * and hand back a paste-ready snippet instead. That snippet is the whole point
 * of the failure path, so it gets printed, not counted.
 */
export interface ReportFailure {
	path: string;
	status: 'failed' | 'not-found';
	message?: string;
}

export interface ResultReport {
	summary: string;
	filesCreated?: string[];
	filesModified?: string[];
	filesDeleted?: string[];
	componentsAdded?: string[];
	packagesInstalled?: string[];
	collectionsAdded?: string[];
	recordsLoaded?: string[];
	recordsCleared?: string[];
	sections?: Array<{ label: string; items: string[] }>;
	failures?: ReportFailure[];
	nextSteps?: string[];
}

export function reportResult(report: ResultReport): void {
	const sections: Array<[string, string[] | undefined]> = [
		['Files created', report.filesCreated],
		['Files modified', report.filesModified],
		['Files deleted', report.filesDeleted],
		['UI components added', report.componentsAdded],
		['Packages installed', report.packagesInstalled],
		['Collections added', report.collectionsAdded],
		['Records loaded', report.recordsLoaded],
		['Records cleared', report.recordsCleared]
	];
	for (const extra of report.sections ?? []) {
		sections.push([extra.label, extra.items]);
	}

	const body: string[] = [];
	for (const [label, items] of sections) {
		if (!items || items.length === 0) continue;
		if (body.length > 0) body.push('');
		body.push(`${label}:`);
		for (const item of items) body.push(`- ${item}`);
	}

	const failures = report.failures ?? [];

	// Anything changed is still a success; the failures are reported separately
	// rather than folded into the summary, so a partial application reads as
	// exactly that.
	if (body.length > 0) {
		p.log.success(`${report.summary}\n\n${body.join('\n')}`);
	} else if (failures.length === 0) {
		p.log.success(report.summary);
	}

	for (const failure of failures) {
		const headline =
			failure.status === 'not-found'
				? `Could not find ${failure.path}`
				: `Could not update ${failure.path}`;
		p.log.warn(failure.message ? `${headline}\n\n${failure.message}` : headline);
	}

	if (report.nextSteps && report.nextSteps.length > 0) {
		p.note(report.nextSteps.map((s) => `- ${s}`).join('\n'), 'Next steps', {
			format: (line) => line
		});
	}
}
