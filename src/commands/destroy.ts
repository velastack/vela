import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { form } from './destroy/form.ts';
import { schema } from './destroy/schema.ts';
import { resource } from './destroy/resource.ts';
import { scaffold } from './destroy/scaffold.ts';

export const destroy = new Command('destroy')
	.description('destroy scaffolding')
	.configureHelp(helpConfig)
	.addCommand(form)
	.addCommand(schema)
	.addCommand(resource)
	.addCommand(scaffold);
