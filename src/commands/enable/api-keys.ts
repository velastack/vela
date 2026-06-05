import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';

export const apiKeys = new Command('api-keys')
	.description('enable API key management')
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action((_opts, cmd) =>
		runCommand(
			() =>
				runPattern(
					'enable-api-keys',
					cmd.args,
					{},
					{
						summary: 'Enabled API key management.',
						nextSteps: [
							'Run `vela dev` and visit /account/api-keys to issue your first key.',
							'Customize the API key UI in src/routes/(app)/account/api-keys/.',
							'Protect API routes by reading `locals.apiKey` in your +server.ts handlers.'
						],
						task: {
							title: 'Enabling api keys',
							success: 'Enabled api keys',
							error: 'Failed to enable api keys'
						}
					}
				),
			'Failed to enable API keys.'
		)
	);
