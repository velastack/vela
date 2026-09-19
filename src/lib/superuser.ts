import process from 'node:process';
import * as v from 'valibot';
import * as p from '@clack/prompts';

/** `--email`, validated identically wherever a command accepts one. */
export const emailFlag = v.optional(v.pipe(v.string(), v.email('must be a valid email address')));

/** `--password`, with PocketBase's own minimum length. */
export const passwordFlag = v.optional(
	v.pipe(v.string(), v.minLength(8, 'must be at least 8 characters long'))
);

export interface Credentials {
	email: string;
	password: string;
}

/** Either half on its own: a flag may name one and not the other. */
export type PartialCredentials = Partial<Credentials>;

export type SuperuserDecision =
	| { kind: 'use'; credentials: Credentials; reused: boolean }
	| { kind: 'prompt'; known: PartialCredentials }
	| { kind: 'error'; message: string };

/**
 * Where the PocketBase superuser credentials come from.
 *
 * Flags win, then the environment — the workspace `.env` is loaded before every
 * command, so a project that already has credentials reuses them rather than
 * being asked for a second pair the database would not recognise. Whatever is
 * still missing is prompted for; off a terminal there is nothing to prompt on,
 * so the flags to pass are named instead.
 *
 * Pure, so the precedence can be tested without a terminal or a database.
 */
export function decideSuperuser(
	flags: PartialCredentials,
	env: PartialCredentials,
	interactive: boolean
): SuperuserDecision {
	const email = flags.email ?? env.email;
	const password = flags.password ?? env.password;

	if (email && password) {
		return {
			kind: 'use',
			credentials: { email, password },
			reused: flags.email === undefined && flags.password === undefined
		};
	}

	if (interactive) {
		const known: PartialCredentials = {};
		if (email) known.email = email;
		if (password) known.password = password;
		return { kind: 'prompt', known };
	}

	const missing = [email ? undefined : '--email', password ? undefined : '--password'].filter(
		(flag): flag is string => flag !== undefined
	);
	return {
		kind: 'error',
		message:
			`Pass ${missing.join(' and ')} for the PocketBase admin user. ` +
			'There is no terminal to ask on.'
	};
}

/** The superuser credentials already in the environment, whether from `.env` or the shell. */
export function superuserFromEnv(): PartialCredentials {
	const email = process.env.POCKETBASE_SUPERUSER_EMAIL?.trim();
	const password = process.env.POCKETBASE_SUPERUSER_PASSWORD;
	return { ...(email ? { email } : {}), ...(password ? { password } : {}) };
}

/**
 * The prompts every command that sets up a PocketBase database asks.
 *
 * Shared by `vela create`, `vela bless` and `vela enable backend` so their
 * wording and validation cannot drift: all three end up with a superuser in
 * `data/` and the same pair of keys in `.env`.
 */
export function promptSuperuser(
	known: PartialCredentials,
	onCancel: () => void
): Promise<Credentials> {
	return p.group(
		{
			email: () => {
				if (known.email) return Promise.resolve(known.email);
				return p.text({
					message: 'Enter an email for the admin user',
					initialValue: 'admin@example.com',
					validate: (value) =>
						!value ? 'Email is required' : !value.includes('@') ? 'Invalid email' : undefined
				});
			},
			password: () => {
				if (known.password) return Promise.resolve(known.password);
				return p.password({
					message: 'Enter a password for the admin user (at least 8 characters)',
					validate: (value) =>
						!value
							? 'Password is required'
							: value.length < 8
								? 'Password must be at least 8 characters long'
								: undefined
				});
			}
		},
		{ onCancel }
	);
}
