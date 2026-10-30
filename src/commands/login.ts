import os from 'node:os';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import makeFetchCookie from 'fetch-cookie';
import { helpConfig } from '../lib/help.ts';
import { API_URL } from '../lib/constants.ts';
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

export type { FetchCookie } from '../lib/account.ts';

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
 * Email and password, or a WhatsApp code when the site offers it. Shared
 * with `vela create`, which offers to log in on the spot when a template
 * needs a CMS and there is no key yet. Returns the key so the caller can
 * carry on without re-reading the config.
 */
export async function loginInteractively(): Promise<string> {
	const method = await chooseAuthMethod('login', await fetchAuthMethods());
	const fetchCookie = makeFetchCookie(fetch);

	if (method === 'whatsapp') {
		await signInWithWhatsApp(fetchCookie, 'login');
	} else {
		await loginWithPassword(fetchCookie);
	}

	const apiKey = await issueApiKey(fetchCookie);
	writeConfig({ apiKey });
	return apiKey;
}

async function loginWithPassword(fetchCookie: FetchCookie): Promise<void> {
	const { email, password } = await p.group(
		{
			email: () => p.text({ message: 'Email' }),
			password: () => p.password({ message: 'Password' })
		},
		{ onCancel: cancelled }
	);

	const result = await postForm(fetchCookie, '/login', { type: 'password', email, password });

	if (result.type !== 'redirect') {
		throw new Error(
			`${failureText(result, 'Failed to authenticate.')} Run \`vela signup\` to create an account or reset at https://velastack.dev/reset`
		);
	}
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
