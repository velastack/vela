import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../../lib/help.ts';
import { runCommand } from '../../../lib/run.ts';
import { withCmsBackend } from '../../../lib/cms-backend.ts';

export const editorPassword = new Command('password')
	.description("set an editor's password")
	.argument('<email>', 'email of the editor')
	.argument('<password>', 'new password')
	.configureHelp(helpConfig)
	.action((email: string, password: string) =>
		runCommand(async () => {
			await withCmsBackend((cms) => cms.editors.setPassword(email, password));
			// The backend ends every session for the editor on a password change.
			p.log.success(
				`Updated the password for ${pc.cyan(email)}. Existing sessions were signed out.`
			);
		}, 'Failed to set the password.')
	);
