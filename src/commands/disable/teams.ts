import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand, runDisable } from './_shared.ts';

export const teams = new Command('teams')
	.description('disable teams')
	.option('-y, --yes', 'skip confirmation prompt')
	.allowUnknownOption(true)
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((opts, cmd) =>
		runCommand(
			() =>
				runDisable(
					{
						slug: 'disable-teams',
						confirmMessage:
							'Disable teams? Drops the teams, team_users, team_memberships, team_invites, and team_invite_links collections, removes team routes, and reverts the team switcher, nav item, layout props and loader.',
						report: {
							summary: 'Disabled teams.',
							task: {
								title: 'Disabling teams',
								success: 'Disabled teams',
								error: 'Failed to disable teams'
							}
						}
					},
					opts,
					cmd.args
				),
			'Failed to disable teams.'
		)
	);
