import os from 'node:os';
import process from 'node:process';
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
			await loginInteractively();
			p.log.success('Logged in to velastack.dev');
		}, 'Failed to login.')
	);

/**
 * Ask for credentials, sign in, mint an API key and store it in `~/.vela`.
 *
 * Shared with `vela create`, which offers to log in on the spot when a template
 * needs a CMS and there is no key yet. Returns the key so the caller can carry
 * on without re-reading the config.
 */
export async function loginInteractively(): Promise<string> {
	const { email, password } = await p.group(
		{
			email: () => p.text({ message: 'Email' }),
			password: () => p.password({ message: 'Password' })
		},
		{
			onCancel: () => {
				p.cancel('Operation cancelled.');
				process.exit(0);
			}
		}
	);

	const fetchCookie = makeFetchCookie(fetch);
	const loginRes = await fetchCookie(`${API_URL}/login`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Origin: API_URL
		},
		body: new URLSearchParams({ type: 'password', email, password }).toString()
	});

	if (!loginRes.headers.get('Set-Cookie')) {
		throw new Error(
			'Run `vela signup` to create an account or reset at https://velastack.dev/reset'
		);
	}

	const apiKey = await issueApiKey(fetchCookie);
	writeConfig({ apiKey });
	return apiKey;
}

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
