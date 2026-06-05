import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';

export const contentNegotiation = new Command('content-negotiation')
	.description('enable content negotiation (sveltekit-negotiate)')
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action((_opts, cmd) =>
		runCommand(
			() =>
				runPattern(
					'enable-content-negotiation',
					cmd.args,
					{},
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
