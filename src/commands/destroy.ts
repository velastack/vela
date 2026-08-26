import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { form } from './destroy/form.ts';
import { schema } from './destroy/schema.ts';
import { resource } from './destroy/resource.ts';
import { scaffold } from './destroy/scaffold.ts';
import { deployment } from './destroy/deployment.ts';

export const destroy = new Command('destroy')
	.description('destroy scaffolding, or a deployment')
	.configureHelp(helpConfig)
	.addCommand(form)
	.addCommand(schema)
	.addCommand(resource)
	.addCommand(scaffold)
	.addCommand(deployment);
