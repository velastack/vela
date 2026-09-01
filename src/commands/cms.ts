import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { editor } from './cms/editor.ts';

export const cms = new Command('cms')
	.description('manage the CMS')
	.configureHelp(helpConfig)
	.addCommand(editor);
