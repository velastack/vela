import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';

export const teams = new Command('teams')
	.description('enable team / multi-tenant support')
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action((_opts, cmd) =>
		runCommand(
			() =>
				runPattern(
					'enable-teams',
					cmd.args,
					{},
					{
						summary: 'Enabled teams.',
						nextSteps: [
							'Run `vela dev` and visit /account/teams to create a team and invite members.',
							'Scope your queries by `team_id` when reading or writing tenant data.',
							'Customize the team settings pages in src/routes/(app)/account/teams/.'
						],
						task: {
							title: 'Enabling teams',
							success: 'Enabled teams',
							error: 'Failed to enable teams'
						}
					}
				),
			'Failed to enable teams.'
		)
	);
