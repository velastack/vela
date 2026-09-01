import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { backupCreate } from './backup/create.ts';
import { backupList } from './backup/list.ts';
import { backupDownload } from './backup/download.ts';
import { backupDelete } from './backup/delete.ts';
import { backupSchedule } from './backup/schedule.ts';

export const backup = new Command('backup')
	.description('back up the database and uploads, locally or on a target')
	.configureHelp(helpConfig)
	.addCommand(backupCreate)
	.addCommand(backupList)
	.addCommand(backupDownload)
	.addCommand(backupDelete)
	.addCommand(backupSchedule);
