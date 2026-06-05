import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { terms } from './legal/terms.ts';
import { privacy } from './legal/privacy.ts';

export const legal = new Command('legal')
	.description('generate placeholder legal documents')
	.configureHelp(helpConfig)
	.addCommand(terms)
	.addCommand(privacy);
