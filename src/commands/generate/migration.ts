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
	.allowUnknownOption(true)
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
							'Review the generated migration file in migrations/.',
							'Run `vela migrate up` to apply the migration.'
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
