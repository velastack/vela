import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';

export const migration = new Command('migration')
	.description('generate a migration for an existing collection')
	.argument('<collection>', 'collection name')
	.argument('<op>', 'operation (add, remove, rename, references)')
	.argument('[args...]', 'operation arguments (e.g. "birthday:date")')
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action((collection: string, op: string, args: string[]) =>
		runCommand(
			() =>
				runPattern(
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
				),
			'Failed to generate migration.'
		)
	);
