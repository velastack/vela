import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { form } from './generate/form.ts';
import { schema } from './generate/schema.ts';
import { resource } from './generate/resource.ts';
import { scaffold } from './generate/scaffold.ts';
import { migration } from './generate/migration.ts';

export const generate = new Command('generate')
	.description('generate scaffolding for database models and forms')
	.configureHelp(helpConfig)
	.addCommand(form)
	.addCommand(schema)
	.addCommand(resource)
	.addCommand(scaffold)
	.addCommand(migration);
