import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { runCommand } from '../lib/run.ts';
import { formatTemplateList, listAllTemplates, summarizeTemplates } from '../lib/templates.ts';

/**
 * What `vela create --template` accepts. Written with `console.log` rather
 * than the prompt library so it reads the same in a pipe, and so `--json`
 * prints nothing but JSON on stdout.
 */
export const templates = new Command('templates')
	.description('list the templates `vela create --template` accepts')
	.option('--json', 'print the list as JSON')
	.configureHelp(helpConfig)
	.action((options: { json?: boolean }) =>
		runCommand(async () => {
			const listing = await listAllTemplates();

			if (options.json) {
				console.log(
					JSON.stringify(
						{
							templates: summarizeTemplates(listing.templates),
							...(listing.registryError ? { registryError: listing.registryError } : {})
						},
						null,
						2
					)
				);
				return;
			}

			console.log(formatTemplateList(listing.templates));
			console.log('\nCreate a project from one with `vela create my-app --template <name>`.');
			if (listing.registryError) {
				console.error(
					`\nCould not reach the template registry (${listing.registryError}). Showing built-in templates only.`
				);
			}
		}, 'Failed to list templates.')
	);
