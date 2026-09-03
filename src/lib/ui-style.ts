import type { SwitchStyleResult } from '@velastack/patterns';
import type { ResultReport } from './result-report.ts';

/**
 * Shapes a completed `vela ui style`. The re-added components are the part
 * worth reading twice: their local edits are gone, and `git diff` is where to
 * find them.
 */
export function uiStyleReport(result: SwitchStyleResult): ResultReport {
	const nextSteps = ['Run your dev server to see the new style.'];
	if (result.reinstalled.length > 0) {
		nextSteps.push(
			'Check `git diff src/lib/components/ui` for local edits the re-added components replaced.'
		);
	}
	nextSteps.push(...result.hints);
	nextSteps.push(
		'Run `vela ui base <color>` or `vela ui theme <accent>` to adjust the palette.',
		'Run `vela ui list` to see what the new style offers.'
	);
	return {
		summary: `Switched to the ${result.style} style.`,
		componentsAdded: result.reinstalled,
		filesModified: result.filesModified,
		packagesInstalled: result.packages,
		nextSteps
	};
}
