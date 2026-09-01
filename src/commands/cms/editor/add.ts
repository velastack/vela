import { randomBytes } from 'node:crypto';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../../lib/help.ts';
import { runCommand } from '../../../lib/run.ts';
import { DEFAULT_PROJECT, withCmsBackend } from '../../../lib/cms-backend.ts';

export const editorAdd = new Command('add')
	.description('create an editor who can sign in to the admin bar')
	.argument('<email>', 'email the editor signs in with')
	.option('--password <password>', 'password to set — generated and shown once when omitted')
	.option('--project <id>', 'project the editor may edit', DEFAULT_PROJECT)
	.configureHelp(helpConfig)
	.action((email: string, options: { password?: string; project: string }) =>
		runCommand(async () => {
			const generated = options.password === undefined;
			// 96 bits, URL-safe, and never written anywhere but this terminal.
			const password = options.password ?? randomBytes(12).toString('base64url');

			const editor = await withCmsBackend((cms) =>
				cms.editors.create({ email, password, projects: [options.project] })
			);

			const lines = [`Added ${pc.cyan(editor.email)} as an editor of ${pc.cyan(options.project)}.`];
			if (generated) {
				lines.push('', `Password: ${pc.bold(password)}`, '', 'It is shown once; copy it now.');
			}
			p.log.success(lines.join('\n'));
			p.log.info(
				`Run ${pc.cyan('vela dev')}, open any page with ${pc.cyan('?edit')} on the URL (or press ${pc.cyan('Ctrl+E')}), and sign in.`
			);
		}, 'Failed to add the editor.')
	);
