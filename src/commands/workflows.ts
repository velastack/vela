import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { workflowsList } from './workflows/list.ts';
import { workflowsRun } from './workflows/run.ts';
import { workflowsCancel } from './workflows/cancel.ts';

/**
 * Workflow runs in whichever copy of the app `-t` names, `local` by default.
 * Locally that is the dev server's PocketBase when one is running, or one
 * started for the command; on a deployed target it is that instance's, over
 * SSH. The dashboard's Workflows tab shows the same runs with their steps.
 */
export const workflows = new Command('workflows')
	.description('list, start and cancel background workflow runs')
	.configureHelp(helpConfig)
	.addCommand(workflowsList)
	.addCommand(workflowsRun)
	.addCommand(workflowsCancel);
