import * as p from '@clack/prompts';

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

	if (body.length > 0) {
		p.log.success(`${report.summary}\n\n${body.join('\n')}`);
	} else {
		p.log.success(report.summary);
	}

	if (report.nextSteps && report.nextSteps.length > 0) {
		p.note(report.nextSteps.map((s) => `- ${s}`).join('\n'), 'Next steps', {
			format: (line) => line
		});
	}
}
