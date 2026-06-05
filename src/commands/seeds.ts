import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { load } from './seeds/load.ts';
import { save } from './seeds/save.ts';
import { clear } from './seeds/clear.ts';

export const seeds = new Command('seeds')
	.description('manage seed data')
	.configureHelp(helpConfig)
	.addCommand(load)
	.addCommand(save)
	.addCommand(clear);
