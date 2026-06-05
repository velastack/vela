import os from 'node:os';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import makeFetchCookie, { type FetchCookieImpl } from 'fetch-cookie';
import { helpConfig } from '../lib/help.ts';
import { API_URL } from '../lib/constants.ts';
import { writeConfig } from '../lib/config.ts';
import { runCommand } from '../lib/run.ts';

export type FetchCookie = FetchCookieImpl<string | URL | Request, RequestInit, Response>;

export const login = new Command('login')
	.description('login to velastack.dev')
	.configureHelp(helpConfig)
	.action(() =>
		runCommand(async () => {
			const { email, password } = await p.group({
				email: () => p.text({ message: 'Email' }),
				password: () => p.password({ message: 'Password' })
			});

			const fetchCookie = makeFetchCookie(fetch);
			const loginRes = await fetchCookie(`${API_URL}/login`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					Origin: API_URL
				},
				body: new URLSearchParams({
					type: 'password',
					email: email as string,
					password: password as string
				}).toString()
			});

			if (!loginRes.headers.get('Set-Cookie')) {
				throw new Error(
					'Run `vela signup` to create an account or reset at https://velastack.dev/reset'
				);
			}

			const apiKey = await issueApiKey(fetchCookie);
			writeConfig({ apiKey });
			p.log.success('Logged in to velastack.dev');
		}, 'Failed to login.')
	);

export async function issueApiKey(fetchCookie: FetchCookie): Promise<string> {
	const label = `CLI - ${os.hostname()}`;

	await fetchCookie(`${API_URL}/api-keys/new`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Origin: API_URL
		},
		body: new URLSearchParams({ label }).toString()
	});

	const cookie = await fetchCookie.cookieJar.getCookieString(API_URL);
	const apiKey = extractApiKey(cookie);
	if (!apiKey) {
		throw new Error('Failed to create API key. Try again or contact support.');
	}

	const [id] = apiKey.split('.');
	const res = await fetchCookie(`${API_URL}/api/collections/api_keys/records`, {
		headers: { Authorization: `Bearer ${apiKey}` }
	});
	const data = (await res.json()) as { items: Array<{ id: string; label: string }> };
	for (const item of data.items) {
		if (item.label === label && item.id !== id) {
			await fetchCookie(`${API_URL}/api/collections/api_keys/records/${item.id}`, {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${apiKey}` }
			});
		}
	}

	return apiKey;
}

function extractApiKey(cookie: string): string | null {
	const flashCookie = cookie.split(';').find((c) => c.trim().startsWith('flash='));
	if (!flashCookie) return null;
	const decoded = decodeURIComponent(flashCookie.split('=')[1]!);
	return (JSON.parse(decoded) as { apiKey: string }).apiKey;
}
