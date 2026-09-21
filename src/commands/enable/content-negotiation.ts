import process from 'node:process';
import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';
import { findWorkspaceRoot, hasDependency } from '../../lib/workspace.ts';

export const contentNegotiation = new Command('content-negotiation')
	.description('enable content negotiation (sveltekit-negotiate)')
	.allowUnknownOption(true)
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((_opts, cmd) =>
		runCommand(
			() =>
				runPattern(
					'enable-content-negotiation',
					cmd.args,
					// The demo page's loader imports `svelte-meta-tags`, which vela's
					// templates carry and a project vela did not create may not.
					{ metaTags: hasDependency(findWorkspaceRoot() ?? process.cwd(), 'svelte-meta-tags') },
					{
						summary: 'Enabled content negotiation.',
						nextSteps: [
							'Create `+page.json.ts` / `+page.xml.ts` siblings alongside your routes to serve JSON/XML representations.',
							'Visit a page with `Accept: application/json` to verify content negotiation is wired up.'
						],
						task: {
							title: 'Enabling content negotiation',
							success: 'Enabled content negotiation',
							error: 'Failed to enable content negotiation'
						}
					}
				),
			'Failed to enable content negotiation.'
		)
	);
