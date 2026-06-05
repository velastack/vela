import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';

export const auth = new Command('auth')
	.description('enable authentication (email/password + OAuth scaffold)')
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action((_opts, cmd) =>
		runCommand(
			() =>
				runPattern(
					'enable-auth',
					cmd.args,
					{},
					{
						summary: 'Enabled authentication.',
						nextSteps: [
							'Run `vela dev` and visit /login to try the new sign-in flow.',
							'Customize sign-in copy and providers in src/routes/(public)/(auth)/.',
							'Add OAuth providers via `vela oauth` (coming soon) or in the PocketBase admin UI.'
						],
						task: {
							title: 'Enabling auth',
							success: 'Enabled auth',
							error: 'Failed to enable auth'
						}
					}
				),
			'Failed to enable auth.'
		)
	);
