import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { load } from './fixtures/load.ts';
import { clear } from './fixtures/clear.ts';
import { reset } from './fixtures/reset.ts';
import { generate } from './fixtures/generate.ts';
import { regen } from './fixtures/regen.ts';

export const fixtures = new Command('fixtures')
	.description('manage fixture data')
	.configureHelp(helpConfig)
	.addCommand(generate)
	.addCommand(load)
	.addCommand(clear)
	.addCommand(reset)
	.addCommand(regen);
