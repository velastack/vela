import type { InstallComponentsResult } from '@velastack/patterns';
import type { ResultReport } from './result-report.ts';

/**
 * What shadcn-svelte 1.6 offers, for `--help` and the next-steps text. The
 * commands validate against the project's installed shadcn-svelte, so a newer
 * one can accept more than is listed here.
 */
export const STYLES = ['nova', 'vega', 'maia', 'lyra', 'mira', 'luma', 'sera', 'rhea'];
export const BASE_COLORS = ['neutral', 'stone', 'zinc', 'mauve', 'olive', 'mist', 'taupe'];
export const THEMES = [
	...BASE_COLORS,
	'amber',
	'blue',
	'cyan',
	'emerald',
	'fuchsia',
	'green',
	'indigo',
	'lime',
	'orange',
	'pink',
	'purple',
	'red',
	'rose',
	'sky',
	'teal',
	'violet',
	'yellow'
];

const NEXT_STEPS = [
	"Import a component with: import { Button } from '$lib/components/ui/button';",
	'Tweak styling in src/lib/components/ui/<component>/*.svelte.',
	`Run \`vela ui base <color>\` to change the palette (${BASE_COLORS.join(', ')}), or \`vela ui list\` to see what else is available.`
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
