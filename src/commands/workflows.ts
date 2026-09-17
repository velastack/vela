import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { workflowsList } from './workflows/list.ts';
import { workflowsRun } from './workflows/run.ts';
import { workflowsCancel } from './workflows/cancel.ts';

/**
 * The local project's workflow runs. Talks to the dev server's PocketBase
 * when one is running, or starts a throwaway one; the dashboard's Workflows
 * tab shows the same runs with their steps.
 */
export const workflows = new Command('workflows')
	.description('list, start and cancel background workflow runs')
	.configureHelp(helpConfig)
	.addCommand(workflowsList)
	.addCommand(workflowsRun)
	.addCommand(workflowsCancel);
