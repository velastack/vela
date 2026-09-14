import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';
import { collectProviderEnv, missingEnvKeys, resolveProvider } from '../../lib/providers.ts';

export const analytics = new Command('analytics')
	.description('enable web analytics (Plausible, Google Analytics or PostHog)')
	.option('--provider <provider>', 'analytics provider: plausible, google or posthog')
	.allowUnknownOption(true)
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((opts: { provider?: string }, cmd) =>
		runCommand(async () => {
			const provider = await resolveProvider('enable-analytics', opts.provider);
			const providerEnv = await collectProviderEnv(provider);
			const blank = missingEnvKeys(provider, providerEnv);

			await runPattern(
				'enable-analytics',
				cmd.args,
				{ provider: provider.id, providerEnv },
				{
					summary: `Enabled analytics with ${provider.label}.`,
					nextSteps: [
						...blank.map(
							(key) =>
								`Set ${key} in .env; the analytics component renders nothing until it is set.`
						),
						`Run \`vela dev\` and look for a page view in ${provider.label}.`,
						'Set the same PUBLIC_* variables on each deploy target with `vela env set`.',
						'The component lives in src/lib/components/analytics/analytics.svelte; edit it freely.'
					],
					task: {
						title: 'Enabling analytics',
						success: `Enabled analytics with ${provider.label}`,
						error: 'Failed to enable analytics'
					}
				}
			);
		}, 'Failed to enable analytics.')
	);
