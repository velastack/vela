import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand, runDisable } from './_shared.ts';

export const whatsapp = new Command('whatsapp')
	.description('disable WhatsApp sign-in')
	.option('-y, --yes', 'skip confirmation prompt')
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((opts, cmd) =>
		runCommand(
			() =>
				runDisable(
					{
						slug: 'disable-whatsapp',
						confirmMessage:
							'Disable WhatsApp sign-in? Turns it off in PocketBase, removes the code page and puts the stock login and signup pages back. The phone fields on users and the optional email stay, since they hold user data.',
						report: {
							summary: 'Disabled WhatsApp sign-in.',
							nextSteps: [
								'Users who signed up with a phone number can no longer log in until they have an email and password.',
								'The phone and phoneVerified fields stay on users, and email stays optional; remove them in the PocketBase dashboard if you no longer need them.',
								'The sender variables stay on your deploy targets: remove the WHATSAPP_* ones with `vela env unset`, and VELASTACK_API_KEY too if nothing else uses it.'
							],
							task: {
								title: 'Disabling WhatsApp sign-in',
								success: 'Disabled WhatsApp sign-in',
								error: 'Failed to disable WhatsApp sign-in'
							}
						}
					},
					opts,
					cmd.args
				),
			'Failed to disable WhatsApp sign-in.'
		)
	);
