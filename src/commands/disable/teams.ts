import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand, runDisable } from './_shared.ts';

export const teams = new Command('teams')
	.description('disable teams')
	.option('-y, --yes', 'skip confirmation prompt')
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action((opts, cmd) =>
		runCommand(
			() =>
				runDisable(
					{
						slug: 'disable-teams',
						confirmMessage:
							'Disable teams? Drops teams, team_memberships, team_invites, and team_invite_links collections and removes team routes. app-sidebar and +layout.server.ts must be reverted manually.',
						report: {
							summary: 'Disabled teams.',
							nextSteps: [
								'Manually revert the Teams nav item in app-sidebar and any team context loading in +layout.server.ts.'
							],
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
