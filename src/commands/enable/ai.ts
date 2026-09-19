import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';
import { detectFormInput } from '../../lib/form-ui.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { collectProviderEnv, missingEnvKeys, resolveProvider } from '../../lib/providers.ts';

export const ai = new Command('ai')
	.description('enable AI chat with the Vercel AI SDK (Vercel AI Gateway, OpenAI or Anthropic)')
	.option('--provider <provider>', 'AI provider: gateway, openai or anthropic')
	.allowUnknownOption(true)
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((opts: { provider?: string }, cmd) =>
		runCommand(async () => {
			const provider = await resolveProvider('enable-ai', opts.provider);
			const providerEnv = await collectProviderEnv(provider);
			const blank = missingEnvKeys(provider, providerEnv);
			const keys = (provider.env ?? []).map((variable) => variable.key);

			const { workspaceRootDir, features } = await getWorkspace();
			// The endpoint's server.test.ts needs the `vela test:server` harness.
			const { serverTests } = detectFormInput(workspaceRootDir);

			await runPattern(
				'enable-ai',
				cmd.args,
				{ provider: provider.id, providerEnv, serverTests },
				{
					summary: `Enabled AI with ${provider.label}.`,
					nextSteps: [
						...blank.map((key) => `Set ${key} in .env; /api/chat answers 503 until it is set.`),
						'Run `vela dev` and open /ai to chat.',
						features.auth
							? 'Only signed-in users can call /api/chat, and the /ai page sits behind sign-in.'
							: '/api/chat is open to anyone who can reach the site, and every reply is billed to your key: put it behind sign-in or a rate limit before you deploy.',
						`Set ${keys.join(' and ')} on each deploy target with \`vela env set\`.`,
						'Pick the model in src/lib/server/ai.ts and the instructions in src/routes/api/chat/+server.ts.'
					],
					task: {
						title: 'Enabling AI',
						success: `Enabled AI with ${provider.label}`,
						error: 'Failed to enable AI'
					}
				}
			);
		}, 'Failed to enable AI.')
	);
