import { Command } from 'commander';
import * as p from '@clack/prompts';
import { helpConfig } from '../lib/help.ts';
import { clearConfig, readConfig } from '../lib/config.ts';
import { runCommand } from '../lib/run.ts';

export const logout = new Command('logout')
	.alias('signout')
	.description('logout from velastack.dev')
	.configureHelp(helpConfig)
	.action(() =>
		runCommand(() => {
			if (!readConfig()) {
				p.log.info('Not logged in');
				return;
			}
			clearConfig();
			p.log.success('Logged out of velastack.dev');
		})
	);
