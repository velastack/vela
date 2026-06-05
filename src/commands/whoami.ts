import { Command } from 'commander';
import * as p from '@clack/prompts';
import { helpConfig } from '../lib/help.ts';
import { API_URL } from '../lib/constants.ts';
import { readConfig } from '../lib/config.ts';
import { runCommand } from '../lib/run.ts';

export const whoami = new Command('whoami')
	.description('show the current user')
	.configureHelp(helpConfig)
	.action(() =>
		runCommand(async () => {
			const apiKey = readConfig()?.apiKey;
			if (!apiKey) {
				p.log.info('Not logged in. Run `vela login` to login.');
				return;
			}
			const res = await fetch(`${API_URL}/api/collections/users/records`, {
				headers: { Authorization: `Bearer ${apiKey}` }
			});
			const data = (await res.json()) as { items: Array<{ email: string }> };
			if (!data.items.length) throw new Error('No user found. Run `vela login` to login.');
			p.log.success(`Logged in as ${data.items[0]!.email}`);
		})
	);
