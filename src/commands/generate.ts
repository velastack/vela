import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { form } from './generate/form.ts';
import { schema } from './generate/schema.ts';
import { resource } from './generate/resource.ts';
import { scaffold } from './generate/scaffold.ts';
import { migration } from './generate/migration.ts';
import { workflow } from './generate/workflow.ts';
import { shop } from './generate/shop.ts';
import { withFieldSyntaxHelp } from '../lib/field-syntax.ts';

// The generators that take field definitions print the syntax after their help.
for (const command of [form, schema, resource, scaffold, migration]) {
	withFieldSyntaxHelp(command);
}

export const generate = new Command('generate')
	.description('generate scaffolding for database models and forms')
	.configureHelp(helpConfig)
	.addCommand(form)
	.addCommand(schema)
	.addCommand(resource)
	.addCommand(scaffold)
	.addCommand(shop)
	.addCommand(migration)
	.addCommand(workflow);
