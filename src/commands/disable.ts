import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { ai } from './disable/ai.ts';
import { analytics } from './disable/analytics.ts';
import { auth } from './disable/auth.ts';
import { api } from './disable/api.ts';
import { apiKeys } from './disable/api-keys.ts';
import { backend } from './disable/backend.ts';
import { contentNegotiation } from './disable/content-negotiation.ts';
import { i18n } from './disable/i18n.ts';
import { notifications } from './disable/notifications.ts';
import { teams } from './disable/teams.ts';
import { payments } from './disable/payments.ts';
import { subscriptions } from './disable/subscriptions.ts';

export const disable = new Command('disable')
	.description('disable features')
	.configureHelp(helpConfig)
	.addCommand(ai)
	.addCommand(analytics)
	.addCommand(auth)
	.addCommand(api)
	.addCommand(apiKeys)
	.addCommand(backend)
	.addCommand(contentNegotiation)
	.addCommand(i18n)
	.addCommand(notifications)
	.addCommand(teams)
	.addCommand(payments)
	.addCommand(subscriptions);
