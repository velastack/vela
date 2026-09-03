import type { ListComponentsResult } from '@velastack/patterns';
import type { ResultReport } from './result-report.ts';

/**
 * Shapes `vela ui list`: what the project has, what vela can copy in, and what
 * the configured style's registry offers. Blocks, hooks and fonts stay out of
 * the last section; `vela ui add` takes them, but the list is about
 * components. A registry that could not be read drops the section and says so
 * through `registryUnavailable`, which the command prints as a warning.
 */
export function uiListReport(result: ListComponentsResult): ResultReport {
	const installed = new Set(result.installed);
	const registryUi = result.registry
		.filter((item) => item.type === 'registry:ui')
		.map((item) => item.name)
		.sort();

	const sections: ResultReport['sections'] = [
		{ label: `Installed (${result.installed.length})`, items: result.installed },
		{
			label: 'Vela components',
			items: result.custom.map((name) => (installed.has(name) ? `${name} (installed)` : name))
		}
	];
	if (!result.registryUnavailable) {
		sections.push({
			label: `shadcn-svelte ${result.style} (${registryUi.length})`,
			items: registryUi
		});
	}

	return {
		summary: `UI components for the ${result.style} style.`,
		sections,
		nextSteps: [
			'Add one with: vela ui add <component>',
			'Switch styles with `vela ui style <name>`, or the palette with `vela ui base <color>`.'
		]
	};
}
