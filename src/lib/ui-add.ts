import type { InstallComponentsResult } from '@velastack/patterns';
import type { ResultReport } from './result-report.ts';

const NEXT_STEPS = [
	"Import a component with: import { Button } from '$lib/components/ui/button';",
	'Tweak styling in src/lib/components/ui/<component>/*.svelte.',
	'Run `vela ui base <color>` to change the palette (slate, gray, zinc, stone, neutral).'
];

/**
 * Shapes the report for `vela ui add`. The installer says what it wrote and
 * what it left alone; a component that was already there is neither a change
 * nor a failure, so it gets its own section instead of inflating "added".
 */
export function uiAddReport(requested: string[], outcome: InstallComponentsResult): ResultReport {
	const { installed, skipped, packages } = outcome;
	const report: ResultReport = {
		summary:
			installed.length > 0
				? `Added ${installed.length} UI component(s).`
				: `All ${new Set(requested).size} requested component(s) are already present.`,
		componentsAdded: installed,
		packagesInstalled: packages,
		nextSteps: [...NEXT_STEPS]
	};
	if (skipped.length > 0) {
		report.sections = [{ label: 'Already present (pass --overwrite to replace)', items: skipped }];
		report.nextSteps!.push(
			`Re-add an existing component with: vela ui add --overwrite ${skipped[0]}`
		);
	}
	return report;
}
