import process from 'node:process';
import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';
import { runSchemaEditor } from '../../lib/schema-editor.ts';

export const migration = new Command('migration')
	.description('generate a migration for an existing collection, or edit the schema in a browser')
	.argument('[collection]', 'collection name')
	.argument('[op]', 'operation (add, remove, rename, references)')
	.argument('[args...]', 'operation arguments (e.g. "birthday:date")')
	.option('--ai', 'open the visual schema editor in a browser instead')
	.option('--no-open', 'with --ai: print the editor URL without opening a browser')
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action(
		(
			collection: string | undefined,
			op: string | undefined,
			args: string[],
			opts: { ai?: boolean; open: boolean }
		) =>
			runCommand(() => {
				if (opts.ai) {
					return runSchemaEditor({ cwd: process.cwd(), noOpen: !opts.open });
				}
				if (!collection || !op) {
					throw new Error(
						'Expected a collection and an operation, e.g. `vela generate migration users add birthday:date`, or `--ai` to edit the schema in a browser.'
					);
				}
				return runPattern(
					'generate-migration',
					[collection, op, ...args],
					{},
					{
						summary: `Created ${op} migration for ${collection}.`,
						nextSteps: [
							'The change is already applied to the local database. There is no need to run `vela migrate up` here.',
							'Commit the migration file in migrations/. It is what applies the change to other environments.',
							'The zod schema in src/lib/schemas/ is updated when the collection has one. Run `vela generate schema <model>` to rebuild it.'
						],
						task: {
							title: 'Generating migration',
							success: 'Generated migration',
							error: 'Failed to generate migration'
						}
					}
				);
			}, 'Failed to generate migration.')
	);
