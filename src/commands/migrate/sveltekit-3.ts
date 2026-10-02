import path from 'node:path';
import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { findWorkspaceRoot } from '../../lib/workspace.ts';
import {
	MIGRATION_TASKS_FILE,
	runKit3Migration,
	type Kit3MigrationResult
} from '../../lib/kit3-migrate.ts';
import { reportResult } from '../../lib/result-report.ts';

interface Options {
	install: boolean;
	force?: boolean;
	skipSv?: boolean;
	cwd?: string;
}

export const sveltekit3 = new Command('sveltekit-3')
	.description('upgrade a SvelteKit 2 project to SvelteKit 3 (sv migrate, then the vela steps)')
	.option('--cwd <path>', 'the project to migrate (default: the current project)')
	.option('--no-install', 'skip installing dependencies')
	.option('--force', 'run even when the git working tree has uncommitted changes')
	.option('--skip-sv', 'only run the vela steps (sv has already been run)')
	.configureHelp(helpConfig)
	.action((options: Options) =>
		runCommand(async () => {
			const root = options.cwd ? path.resolve(options.cwd) : (findWorkspaceRoot() ?? process.cwd());
			p.intro(pc.bgCyan(pc.black(' vela migrate sveltekit-3 ')));
			const result = await runKit3Migration(root, {
				install: options.install,
				force: options.force,
				skipSv: options.skipSv
			});
			printReport(root, result);
		}, 'Failed to migrate to SvelteKit 3.')
	);

export function printReport(root: string, result: Kit3MigrationResult): void {
	const changed = result.fixups.filter((f) => f.changed);
	const sections: Array<{ label: string; items: string[] }> = [];
	if (result.sv.cleared.length > 0) {
		sections.push({ label: 'Build output removed first', items: result.sv.cleared });
	}
	for (const fixup of changed) sections.push({ label: fixup.name, items: fixup.details });

	const summary =
		result.mode === 'repair'
			? changed.length > 0
				? 'Already on SvelteKit 3; brought the vela setup up to date.'
				: 'Already on SvelteKit 3; nothing left to change.'
			: `Migrated ${path.basename(root)} to SvelteKit 3.`;
	reportResult({ summary, sections });

	const tasks = result.tasks;
	if (tasks && (tasks.sections.length > 0 || tasks.markerComments > 0)) {
		const lines = tasks.sections.map(
			(s) =>
				`- ${s.title}${s.files.length ? ` (${s.files.length} file${s.files.length === 1 ? '' : 's'})` : ''}`
		);
		lines.push(
			'',
			`${tasks.filesToReview} file(s) to review, ${tasks.markerComments} \`@migration-task\` comment(s) in the code.`
		);
		p.note(lines.join('\n'), `${MIGRATION_TASKS_FILE}`, { format: (line) => line });
	}

	if (result.followUps.length > 0) {
		p.note(result.followUps.map((item) => `- ${item}`).join('\n'), 'VelaStack follow-ups', {
			format: (line) => line
		});
	}

	const nextSteps: string[] = [];
	if (tasks && (tasks.sections.length > 0 || result.followUps.length > 0)) {
		nextSteps.push(`Work through ${MIGRATION_TASKS_FILE}, then delete it.`);
	}
	if (tasks?.markerComments) {
		nextSteps.push('Search the code for `@migration-task` and resolve each comment.');
	}
	if (result.installed === null) {
		nextSteps.push(
			'Install dependencies (`npm install`), then format what changed (`npx prettier --write .`): sv could not format without node_modules.'
		);
	}
	if (result.installed === false) {
		nextSteps.push('The install failed: run it again and read its error (`npm install`).');
	}
	nextSteps.push('Run `npm run check`, `vela test:server` and `npm run build`.');
	nextSteps.push(...result.genericFollowUps);
	nextSteps.push('Review the diff and commit it.');
	p.note(nextSteps.map((s) => `- ${s}`).join('\n'), 'Next steps', { format: (line) => line });
}
