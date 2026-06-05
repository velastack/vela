import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { auth } from './disable/auth.ts';
import { api } from './disable/api.ts';
import { apiKeys } from './disable/api-keys.ts';
import { backend } from './disable/backend.ts';
import { contentNegotiation } from './disable/content-negotiation.ts';
import { i18n } from './disable/i18n.ts';
import { teams } from './disable/teams.ts';
import { payments } from './disable/payments.ts';
import { s3 } from './disable/s3.ts';
import { smtp } from './disable/smtp.ts';

export const disable = new Command('disable')
	.description('disable features')
	.configureHelp(helpConfig)
	.addCommand(auth)
	.addCommand(api)
	.addCommand(apiKeys)
	.addCommand(backend)
	.addCommand(contentNegotiation)
	.addCommand(i18n)
	.addCommand(teams)
	.addCommand(payments)
	.addCommand(s3)
	.addCommand(smtp);
