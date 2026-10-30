import { Command } from 'commander';
import * as p from '@clack/prompts';
import makeFetchCookie from 'fetch-cookie';
import { helpConfig } from '../lib/help.ts';
import { writeConfig } from '../lib/config.ts';
import { runCommand } from '../lib/run.ts';
import {
	cancelled,
	chooseAuthMethod,
	failureText,
	fetchAuthMethods,
	postForm,
	signInWithWhatsApp,
	type FetchCookie
} from '../lib/account.ts';
import { issueApiKey } from './login.ts';

export const signup = new Command('signup')
	.description('signup to velastack.dev')
	.configureHelp(helpConfig)
	.action(() =>
		runCommand(async () => {
			const method = await chooseAuthMethod('signup', await fetchAuthMethods());
			const fetchCookie = makeFetchCookie(fetch);

			// A number that already has an account logs in rather than signing up.
			let isNew = true;
			if (method === 'whatsapp') {
				({ isNew } = await signInWithWhatsApp(fetchCookie, 'signup'));
			} else {
				await signupWithPassword(fetchCookie);
			}

			const apiKey = await issueApiKey(fetchCookie);
			writeConfig({ apiKey });
			p.log.success(isNew ? 'Signed up to velastack.dev' : 'Logged in to velastack.dev');
			if (method === 'password') {
				p.log.info('Check your email for a confirmation link.');
			}
		}, 'Failed to signup.')
	);

async function signupWithPassword(fetchCookie: FetchCookie): Promise<void> {
	const { email, password, passwordConfirm } = await p.group(
		{
			email: () => p.text({ message: 'Email' }),
			password: () => p.password({ message: 'Password' }),
			passwordConfirm: () => p.password({ message: 'Confirm password' })
		},
		{ onCancel: cancelled }
	);

	if (password !== passwordConfirm) {
		throw new Error('Passwords do not match.');
	}

	const result = await postForm(fetchCookie, '/signup', {
		type: 'password',
		email,
		password,
		passwordConfirm
	});

	if (result.type !== 'redirect') {
		throw new Error(failureText(result, 'Could not create the account.'));
	}
}
