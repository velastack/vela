import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand, runDisable } from './_shared.ts';

export const ecommerce = new Command('ecommerce')
	.description('disable ecommerce')
	.option('-y, --yes', 'skip confirmation prompt')
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((opts, cmd) =>
		runCommand(
			() =>
				runDisable(
					{
						slug: 'disable-ecommerce',
						confirmMessage:
							'Disable ecommerce? Removes the cart, the cart and checkout pages, and the navbar cart button. Payments stays as it is.',
						report: {
							summary: 'Disabled ecommerce.',
							nextSteps: [
								'Pages that used <AddToCart> no longer build; remove those uses.',
								'The shadcn sheet and badge components remain installed.'
							],
							task: {
								title: 'Disabling ecommerce',
								success: 'Disabled ecommerce',
								error: 'Failed to disable ecommerce'
							}
						}
					},
					opts,
					cmd.args
				),
			'Failed to disable ecommerce.'
		)
	);
