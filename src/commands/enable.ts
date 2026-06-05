import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { auth } from './enable/auth.ts';
import { api } from './enable/api.ts';
import { apiKeys } from './enable/api-keys.ts';
import { backend } from './enable/backend.ts';
import { i18n } from './enable/i18n.ts';
import { teams } from './enable/teams.ts';
import { payments } from './enable/payments.ts';
import { subscriptions } from './enable/subscriptions.ts';
import { s3 } from './enable/s3.ts';
import { smtp } from './enable/smtp.ts';
import { cms } from './enable/cms.ts';
import { blog } from './enable/blog.ts';
import { contentNegotiation } from './enable/content-negotiation.ts';

export const enable = new Command('enable')
	.description('enable features')
	.configureHelp(helpConfig)
	.addCommand(auth)
	.addCommand(api)
	.addCommand(apiKeys)
	.addCommand(backend)
	.addCommand(contentNegotiation)
	.addCommand(i18n)
	.addCommand(teams)
	.addCommand(payments)
	.addCommand(subscriptions)
	.addCommand(s3)
	.addCommand(smtp)
	.addCommand(cms)
	.addCommand(blog);
