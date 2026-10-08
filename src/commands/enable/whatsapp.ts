import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';

export const whatsapp = new Command('whatsapp')
	.description('enable WhatsApp sign-in on the login and signup pages (requires auth)')
	.allowUnknownOption(true)
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((_opts, cmd) =>
		runCommand(
			() =>
				runPattern(
					'enable-whatsapp',
					cmd.args,
					{},
					{
						summary: 'Enabled WhatsApp sign-in. Email is optional on users now.',
						nextSteps: [
							'Run `vela dev` and sign up with a phone number on /signup: the code shows in the PocketBase logs.',
							'Before deploying, set a sender: `vela env set VELASTACK_API_KEY=...` for the VelaStack relay, or `vela env set WHATSAPP_PHONE_NUMBER_ID=... WHATSAPP_ACCESS_TOKEN=... WHATSAPP_TEMPLATE_NAME=...` for the WhatsApp Cloud API.'
						],
						task: {
							title: 'Enabling WhatsApp sign-in',
							success: 'Enabled WhatsApp sign-in',
							error: 'Failed to enable WhatsApp sign-in'
						}
					}
				),
			'Failed to enable WhatsApp sign-in.'
		)
	);
