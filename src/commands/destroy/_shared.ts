import process from 'node:process';
import * as p from '@clack/prompts';
import type { Slug } from '@velastack/patterns';
import { runCommand } from '../../lib/run.ts';
import { runPattern, type PatternReport } from '../../lib/pattern-runner.ts';

export async function runDestroy(
	slug: Slug,
	model: string,
	confirmMessage: string,
	report: PatternReport,
	flags: { yes?: boolean; route?: string }
): Promise<void> {
	if (!flags.yes) {
		const ok = await p.confirm({ message: confirmMessage, initialValue: false });
		if (p.isCancel(ok) || !ok) {
			p.cancel('Operation cancelled.');
			process.exit(0);
		}
	}
	await runPattern(slug, [model], { destructive: true, route: flags.route }, report);
}

export { runCommand };
