import process from 'node:process';
import * as p from '@clack/prompts';
import type { Slug } from '@velastack/patterns';
import { runCommand } from '../../lib/run.ts';
import { runPattern, type PatternReport } from '../../lib/pattern-runner.ts';

export interface DisableOptions {
	slug: Slug;
	confirmMessage: string;
	report: PatternReport;
}

export async function runDisable(
	opts: DisableOptions,
	flags: { yes?: boolean },
	cmdArgs: string[]
): Promise<void> {
	if (!flags.yes) {
		const ok = await p.confirm({
			message: opts.confirmMessage,
			initialValue: false
		});
		if (p.isCancel(ok) || !ok) {
			p.cancel('Operation cancelled.');
			process.exit(0);
		}
	}
	await runPattern(opts.slug, cmdArgs, { destructive: true }, opts.report);
}

export { runCommand };
