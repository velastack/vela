import process from 'node:process';
import * as p from '@clack/prompts';
import type { FetchCookieImpl } from 'fetch-cookie';
import { parse } from 'devalue';
import { API_URL } from './constants.ts';

export type FetchCookie = FetchCookieImpl<string | URL | Request, RequestInit, Response>;

export type AuthMethod = 'password' | 'whatsapp';

/**
 * Which ways into a velastack.dev account are open: email and password, and
 * WhatsApp (a one-time code), per the site's own auth methods endpoint.
 */
export interface AuthMethods {
	password: boolean;
	whatsapp: { enabled: boolean; allowSignup: boolean };
}

const NO_WHATSAPP: AuthMethods['whatsapp'] = { enabled: false, allowSignup: false };

/**
 * Asks velastack.dev which sign-in methods it offers. Only WhatsApp is ever
 * absent (vanilla PocketBase has no such entry), so a failed call means the
 * email prompts as before: whatever is wrong shows on the sign-in itself.
 */
export async function fetchAuthMethods(): Promise<AuthMethods> {
	try {
		const res = await fetch(`${API_URL}/api/collections/users/auth-methods`);
		if (!res.ok) return { password: true, whatsapp: NO_WHATSAPP };
		const data = (await res.json()) as {
			password?: { enabled?: boolean };
			whatsapp?: { enabled?: boolean; allowSignup?: boolean };
		};
		return {
			password: data.password?.enabled !== false,
			whatsapp: {
				enabled: data.whatsapp?.enabled === true,
				allowSignup: data.whatsapp?.allowSignup === true
			}
		};
	} catch {
		return { password: true, whatsapp: NO_WHATSAPP };
	}
}

/**
 * Lets the user pick between email and WhatsApp when the site offers both.
 * Signup needs WhatsApp to accept unknown numbers; login only needs it on.
 */
export async function chooseAuthMethod(
	kind: 'login' | 'signup',
	methods: AuthMethods
): Promise<AuthMethod> {
	const whatsapp = methods.whatsapp.enabled && (kind === 'login' || methods.whatsapp.allowSignup);
	if (!whatsapp) return 'password';
	if (!methods.password) return 'whatsapp';

	const choice = await p.select<AuthMethod>({
		message: kind === 'signup' ? 'How do you want to sign up?' : 'How do you want to log in?',
		options: [
			{ value: 'password', label: 'Email and password' },
			{ value: 'whatsapp', label: 'WhatsApp', hint: 'a one-time code on your phone' }
		]
	});
	if (p.isCancel(choice)) cancelled();
	return choice;
}

export function cancelled(): never {
	p.cancel('Operation cancelled.');
	process.exit(0);
}

/**
 * What a form action answered, as SvelteKit reports it to its own client:
 * where a successful action sends the browser next, or on failure the
 * superforms data with the messages the page would show.
 */
export type FormResult =
	| { type: 'redirect'; location: string }
	| { type: 'failure'; status: number; message: string | null }
	| { type: 'success' }
	| { type: 'error'; message: string | null };

/**
 * Posts one of the site's forms as its own pages do: urlencoded, with the
 * `Origin` its cross-site check wants, and asking for the result as JSON
 * (the `Accept` SvelteKit's `enhance` sends) rather than the rendered page.
 * Cookies the action sets (the session) land in `fetchCookie`'s jar.
 */
export async function postForm(
	fetchCookie: FetchCookie,
	path: string,
	fields: Record<string, string>
): Promise<FormResult> {
	const res = await fetchCookie(`${API_URL}${path}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/json',
			'x-sveltekit-action': 'true',
			Origin: API_URL
		},
		body: new URLSearchParams(fields).toString()
	});
	let result: {
		type?: string;
		status?: number;
		location?: string;
		data?: string;
		error?: { message?: string };
	};
	try {
		result = (await res.json()) as typeof result;
	} catch {
		return { type: 'error', message: `velastack.dev answered ${res.status}` };
	}
	switch (result.type) {
		case 'redirect':
			return { type: 'redirect', location: result.location ?? '/' };
		case 'success':
			return { type: 'success' };
		case 'failure':
			return { type: 'failure', status: result.status ?? 400, message: formMessage(result.data) };
		default:
			return { type: 'error', message: result.error?.message ?? null };
	}
}

/**
 * The message a failed superforms action carries: the one on the form, or
 * else the first field error. `data` is devalue-encoded, as in the page.
 */
function formMessage(data: string | undefined): string | null {
	if (!data) return null;
	let form: {
		message?: { text?: string } | string;
		errors?: Record<string, string[] | undefined>;
	};
	try {
		({ form } = parse(data) as { form: typeof form });
	} catch {
		return null;
	}
	if (typeof form?.message === 'string') return form.message;
	if (form?.message?.text) return form.message.text;
	for (const errors of Object.values(form?.errors ?? {})) {
		if (errors?.[0]) return errors[0];
	}
	return null;
}

/** The path a successful form action sends the browser to, or null when it failed. */
export function redirectedTo(result: FormResult): string | null {
	if (result.type !== 'redirect') return null;
	return new URL(result.location, API_URL).pathname;
}

/**
 * A number the server will take: international format, so a `+` (or the `00`
 * prefix) and 8 to 15 digits with any of the usual separators between them.
 * The server normalizes it; this only turns an obvious slip around early.
 */
export function validatePhone(value: string | undefined): string | undefined {
	const raw = (value ?? '').trim().replace(/^00/, '+');
	if (!raw.startsWith('+')) return 'Enter the number in international format, eg. +16165550123';
	const rest = raw.slice(1);
	if (/[^0-9 .()-]/.test(rest)) return 'Enter the number in international format, eg. +16165550123';
	const digits = rest.replace(/[^0-9]/g, '');
	if (digits.length < 8 || digits.length > 15 || digits.startsWith('0')) {
		return 'Enter the number in international format, eg. +16165550123';
	}
	return undefined;
}

const CODE_ATTEMPTS = 3;

/**
 * Signs in (or up) with a WhatsApp code through the same pages the site uses:
 * the number goes to `/login` or `/signup`, which sends the code and points at
 * `/whatsapp/<id>`; the code goes there, which starts the session. Unknown
 * numbers get an account when the site allows it, and that account has only
 * a number, so the site asks for a name on `/welcome` and so does this.
 *
 * Leaves the session cookie in `fetchCookie`'s jar for the API key step.
 */
export async function signInWithWhatsApp(
	fetchCookie: FetchCookie,
	kind: 'login' | 'signup'
): Promise<{ isNew: boolean }> {
	const phone = await p.text({
		message: 'WhatsApp number',
		placeholder: '+1 616 555 0123',
		validate: validatePhone
	});
	if (p.isCancel(phone)) cancelled();

	const sent = await postForm(fetchCookie, `/${kind}`, { type: 'whatsapp', phone: phone.trim() });
	const codePath = redirectedTo(sent);
	const otpId = codePath?.match(/^\/whatsapp\/([^/]+)$/)?.[1];
	if (!otpId) {
		throw new Error(failureText(sent, 'Failed to send the WhatsApp code.'));
	}
	p.log.info('We sent a code to your WhatsApp.');

	for (let attempt = 1; ; attempt++) {
		const code = await p.text({
			message: 'Code',
			validate: (value) => (/^\d{4,8}$/.test((value ?? '').trim()) ? undefined : 'Enter the code')
		});
		if (p.isCancel(code)) cancelled();

		const verified = await postForm(fetchCookie, codePath!, { otp: code.trim() });
		const next = redirectedTo(verified);
		if (next) {
			const isNew = next.startsWith('/welcome');
			if (isNew) await askForName(fetchCookie);
			return { isNew };
		}
		if (verified.type !== 'failure') {
			throw new Error(failureText(verified, 'Failed to verify the code.'));
		}
		if (attempt >= CODE_ATTEMPTS) {
			throw new Error(
				`${verified.message ?? 'The code is wrong or has expired.'} Run \`vela ${kind}\` again.`
			);
		}
		p.log.warn(`${verified.message ?? 'That code is wrong or has expired.'} Try again.`);
	}
}

/** What to tell the user about a form that did not go through. */
export function failureText(result: FormResult, fallback: string): string {
	const message = result.type === 'failure' || result.type === 'error' ? result.message : null;
	return message ?? `${fallback} Try again or contact support.`;
}

async function askForName(fetchCookie: FetchCookie): Promise<void> {
	const name = await p.text({
		message: 'Your name',
		validate: (value) => ((value ?? '').trim() ? undefined : 'Enter your name')
	});
	if (p.isCancel(name)) cancelled();
	const res = await postForm(fetchCookie, '/welcome', { name: name.trim() });
	if (!redirectedTo(res)) {
		// The account exists and the session is good; the name can be set on
		// the site later, so this is worth a word and not a failure.
		p.log.warn('Could not save your name. You can set it at https://velastack.dev/settings');
	}
}
