import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { editorAdd } from './editor/add.ts';
import { editorPassword } from './editor/password.ts';
import { editorList } from './editor/list.ts';

/**
 * The admin bar signs in against the CMS's own `cms_editors` table, which
 * starts empty and has no UI to fill it. These commands are how an editor
 * gets an account.
 */
export const editor = new Command('editor')
	.description('manage who can sign in to the admin bar')
	.configureHelp(helpConfig)
	.addCommand(editorAdd)
	.addCommand(editorPassword)
	.addCommand(editorList);
