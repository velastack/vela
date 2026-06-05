import { Command } from 'commander';
import * as p from '@clack/prompts';
import makeFetchCookie from 'fetch-cookie';
import { helpConfig } from '../lib/help.ts';
import { API_URL } from '../lib/constants.ts';
import { writeConfig } from '../lib/config.ts';
import { runCommand } from '../lib/run.ts';
import { issueApiKey } from './login.ts';

export const signup = new Command('signup')
	.description('signup to velastack.dev')
	.configureHelp(helpConfig)
	.action(() =>
		runCommand(async () => {
			const { email, password, passwordConfirm } = await p.group({
				email: () => p.text({ message: 'Email' }),
				password: () => p.password({ message: 'Password' }),
				passwordConfirm: () => p.password({ message: 'Confirm password' })
			});

			if (password !== passwordConfirm) {
				throw new Error('Passwords do not match.');
			}

			const fetchCookie = makeFetchCookie(fetch);
			const res = await fetchCookie(`${API_URL}/signup`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					Origin: API_URL
				},
				body: new URLSearchParams({
					type: 'password',
					email: email as string,
					password: password as string,
					passwordConfirm: passwordConfirm as string
				}).toString()
			});

			if (!res.headers.get('Set-Cookie')) {
				throw new Error('Failed to signup. Try again or contact support.');
			}

			const apiKey = await issueApiKey(fetchCookie);
			writeConfig({ apiKey });
			p.log.success('Signed up to velastack.dev');
			p.log.info('Check your email for a confirmation link.');
		}, 'Failed to signup.')
	);
