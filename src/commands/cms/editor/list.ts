import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../../lib/help.ts';
import { runCommand } from '../../../lib/run.ts';
import { withCmsBackend } from '../../../lib/cms-backend.ts';

export const editorList = new Command('list')
	.description('list editors and the projects they may edit')
	.configureHelp(helpConfig)
	.action(() =>
		runCommand(async () => {
			const rows = await withCmsBackend(async (cms) =>
				cms.editors.list().map((editor) => ({
					email: editor.email,
					projects: cms.editors.projectsFor(editor.id)
				}))
			);

			if (rows.length === 0) {
				p.log.info(`No editors yet. Add one with ${pc.cyan('vela cms editor add <email>')}.`);
				return;
			}

			const width = Math.max(...rows.map((row) => row.email.length));
			p.log.info(
				`Editors\n\n` +
					rows
						.map(
							(row) =>
								`  ${row.email.padEnd(width)}  ${pc.dim(row.projects.join(', ') || 'no projects')}`
						)
						.join('\n')
			);
		}, 'Failed to list editors.')
	);
