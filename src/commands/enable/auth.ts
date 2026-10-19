import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';

export const auth = new Command('auth')
	.description('enable authentication (email/password + OAuth scaffold)')
	.option(
		'--remote',
		'generate the auth forms with SvelteKit remote functions instead of form actions and superforms'
	)
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((options: { remote?: boolean }, cmd) =>
		runCommand(
			() =>
				// Same pages and flows either way; `--remote` picks the variant whose
				// forms post to `form.remote.ts` files, like `generate form --remote`.
				runPattern(
					options.remote ? 'enable-auth-remote' : 'enable-auth',
					cmd.args,
					{},
					{
						summary: options.remote
							? 'Enabled authentication with remote functions.'
							: 'Enabled authentication.',
						nextSteps: [
							'Run `vela dev` and visit /login to try the new sign-in flow.',
							'Customize sign-in copy and providers in src/routes/(public)/(auth)/.',
							'Add OAuth providers in the PocketBase admin UI.'
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
