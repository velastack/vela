import fs from 'node:fs';
import path from 'node:path';
import { addEnvComment, addEnvVar, removeEnvVar, upsertEnvVar } from './env.ts';
import { importIntoLayer, unsetInLayer, type LayerFiles } from './env-scopes.ts';
import type { SshSession } from './ssh.ts';

/**
 * Outgoing email, as the PocketBase build vela ships reads it from the
 * environment at start. Setting `PB_SMTP_HOST` is what turns SMTP on.
 */
export const EMAIL_ENV_KEYS = [
	'PB_SMTP_HOST',
	'PB_SMTP_PORT',
	'PB_SMTP_TLS',
	'PB_SMTP_USERNAME',
	'PB_SMTP_PASSWORD',
	'PB_SENDER_ADDRESS',
	'PB_SENDER_NAME'
] as const;

export type EmailEnvKey = (typeof EMAIL_ENV_KEYS)[number];

/** Where the SMTP username comes from for a provider. */
export type UsernameMode =
	| { kind: 'fixed'; value: string }
	/** The provider signs in with the same token as username and password. */
	| { kind: 'secret' }
	| { kind: 'ask'; label: string };

export interface EmailProvider {
	id: string;
	label: string;
	/** Unset for plain `smtp`, where the host is asked for. */
	host?: (region: string | undefined) => string;
	port: number;
	/**
	 * `PB_SMTP_TLS`. True means the connection starts encrypted (implicit TLS,
	 * the port 465 kind). False still upgrades with STARTTLS when the server
	 * offers it, which is what port 587 wants.
	 */
	tls: boolean;
	username: UsernameMode;
	/** What the secret is called at this provider, for the prompt. */
	secretLabel: string;
	/** Regions, when the SMTP host depends on one. The first is the default; none means required free text. */
	region?: { required: boolean; choices?: string[]; hint: string };
	/** The name app code usually keeps this same key under, when it is an API key. */
	appKey?: string;
}

/**
 * Deliberately small, and from memory of each provider's SMTP documentation:
 * check the host, port and username convention against the provider's current
 * docs before relying on a row, and prefer `--provider smtp` with explicit
 * values for anything not listed here.
 *
 *   Resend    https://resend.com/docs/send-with-smtp
 *   Postmark  https://postmarkapp.com/developer/user-guide/send-email-with-smtp
 *   SendGrid  https://www.twilio.com/docs/sendgrid/for-developers/sending-email/integrating-with-the-smtp-api
 *   Mailgun   https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/send-smtp
 *   SES       https://docs.aws.amazon.com/ses/latest/dg/smtp-connect.html
 */
export const EMAIL_PROVIDERS: EmailProvider[] = [
	{
		id: 'resend',
		label: 'Resend',
		host: () => 'smtp.resend.com',
		port: 465,
		tls: true,
		username: { kind: 'fixed', value: 'resend' },
		secretLabel: 'Resend API key',
		appKey: 'RESEND_API_KEY'
	},
	{
		id: 'postmark',
		label: 'Postmark',
		host: () => 'smtp.postmarkapp.com',
		// Postmark has no implicit-TLS port; 587 upgrades with STARTTLS.
		port: 587,
		tls: false,
		username: { kind: 'secret' },
		secretLabel: 'Postmark server API token'
	},
	{
		id: 'sendgrid',
		label: 'SendGrid',
		host: () => 'smtp.sendgrid.net',
		port: 465,
		tls: true,
		// Literally the word, not the key's name.
		username: { kind: 'fixed', value: 'apikey' },
		secretLabel: 'SendGrid API key',
		appKey: 'SENDGRID_API_KEY'
	},
	{
		id: 'mailgun',
		label: 'Mailgun',
		host: (region) => (region === 'eu' ? 'smtp.eu.mailgun.org' : 'smtp.mailgun.org'),
		port: 465,
		tls: true,
		// Per-domain SMTP credentials, not the account's API key.
		username: { kind: 'ask', label: 'Mailgun SMTP login (e.g. postmaster@mg.example.com)' },
		secretLabel: 'Mailgun SMTP password',
		region: { required: false, choices: ['us', 'eu'], hint: 'us or eu' }
	},
	{
		id: 'ses',
		label: 'Amazon SES',
		host: (region) => `email-smtp.${region}.amazonaws.com`,
		port: 465,
		tls: true,
		// SES SMTP credentials are their own pair, created in the SES console;
		// they are not an IAM access key.
		username: { kind: 'ask', label: 'SES SMTP username' },
		secretLabel: 'SES SMTP password',
		region: { required: true, hint: 'the AWS region SES is set up in, e.g. us-east-1' }
	},
	{
		id: 'smtp',
		label: 'Another SMTP server',
		port: 587,
		tls: false,
		username: { kind: 'ask', label: 'SMTP username (leave empty for none)' },
		secretLabel: 'SMTP password'
	}
];

export const EMAIL_PROVIDER_IDS = EMAIL_PROVIDERS.map((provider) => provider.id);

export function findEmailProvider(id: string): EmailProvider {
	const provider = EMAIL_PROVIDERS.find((candidate) => candidate.id === id.toLowerCase());
	if (!provider) {
		throw new Error(
			`Unknown email provider "${id}".\n\nAvailable providers:\n` +
				EMAIL_PROVIDER_IDS.map((known) => `  ${known}`).join('\n')
		);
	}
	return provider;
}

export interface EmailAnswers {
	provider: EmailProvider;
	region?: string;
	host?: string;
	port?: number;
	tls?: boolean;
	username?: string;
	/** The password, API key or token. Never printed. */
	secret?: string;
	from: string;
	fromName?: string;
}

export interface EmailSettings {
	provider: EmailProvider;
	/** Every variable to write. */
	values: Partial<Record<EmailEnvKey, string>>;
	/** The ones holding a credential: written secret, shown as dots. */
	secretKeys: EmailEnvKey[];
	/** Of the seven, the ones this configuration does not use and must not leave behind. */
	stale: EmailEnvKey[];
}

/**
 * Turn answers into the variables PocketBase reads. Explicit host, port and
 * TLS win over the provider's row, so a provider that moves a port can be
 * followed without waiting for a CLI release.
 */
export function buildEmailSettings(answers: EmailAnswers): EmailSettings {
	const { provider } = answers;
	const host = answers.host?.trim() || provider.host?.(answers.region);
	if (!host) throw new Error('An SMTP host is required.');
	const port = answers.port ?? provider.port;
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`${port} is not a port number.`);
	}
	if (!answers.from.includes('@')) {
		throw new Error(`The sender address has to be an email address, and "${answers.from}" is not.`);
	}

	const secret = answers.secret ?? '';
	const username =
		provider.username.kind === 'fixed'
			? answers.username?.trim() || provider.username.value
			: provider.username.kind === 'secret'
				? answers.username?.trim() || secret
				: (answers.username?.trim() ?? '');

	// Only a plain SMTP relay may go without credentials; a named provider
	// with none would be written, restarted and then fail on the first send.
	if (provider.id !== 'smtp') {
		if (!secret) throw new Error(`${provider.label} needs its ${provider.secretLabel}.`);
		if (!username) throw new Error(`${provider.label} needs an SMTP username.`);
	}

	const values: EmailSettings['values'] = {
		PB_SMTP_HOST: host,
		PB_SMTP_PORT: String(port),
		PB_SMTP_TLS: String(answers.tls ?? provider.tls),
		PB_SENDER_ADDRESS: answers.from.trim()
	};
	if (username) values.PB_SMTP_USERNAME = username;
	if (secret) values.PB_SMTP_PASSWORD = secret;
	if (answers.fromName?.trim()) values.PB_SENDER_NAME = answers.fromName.trim();

	const secretKeys: EmailEnvKey[] = [];
	if (values.PB_SMTP_PASSWORD) secretKeys.push('PB_SMTP_PASSWORD');
	// A username that is the token itself is as secret as the password.
	if (values.PB_SMTP_USERNAME && values.PB_SMTP_USERNAME === secret) {
		secretKeys.push('PB_SMTP_USERNAME');
	}

	const stale = (['PB_SMTP_USERNAME', 'PB_SMTP_PASSWORD'] as const).filter(
		(key) => !(key in values)
	);
	return { provider, values, secretKeys, stale };
}

/** The settings as they may be shown: a credential is dots, whatever its length. */
export function describeEmailSettings(settings: EmailSettings): string[] {
	return EMAIL_ENV_KEYS.filter((key) => key in settings.values).map((key) =>
		settings.secretKeys.includes(key) ? `${key}=••••` : `${key}=${settings.values[key]}`
	);
}

/**
 * Write the settings into the project's `.env`, in place where a line is
 * already there, and list the names in `.env.example` when the project keeps
 * one. Returns the files it changed, relative to the project.
 */
export function writeLocalEmailEnv(workspaceRootDir: string, settings: EmailSettings): string[] {
	const changed: string[] = [];

	const envFile = path.join(workspaceRootDir, '.env');
	const before = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
	let content = before;
	for (const key of EMAIL_ENV_KEYS) {
		const value = settings.values[key];
		if (value !== undefined) content = upsertEnvVar(content, key, value);
	}
	for (const key of settings.stale) content = removeEnvVar(content, key);
	if (content !== before) {
		fs.writeFileSync(envFile, content);
		changed.push('.env');
	}

	// Names only: the example file is committed, and says what a new checkout
	// has to fill in.
	const exampleFile = path.join(workspaceRootDir, '.env.example');
	if (fs.existsSync(exampleFile)) {
		const exampleBefore = fs.readFileSync(exampleFile, 'utf8');
		let example = exampleBefore;
		if (!EMAIL_ENV_KEYS.some((key) => example.includes(`${key}=`))) {
			example = addEnvComment(
				example,
				'Outgoing email (PocketBase SMTP). Set with `vela enable email`.'
			);
		}
		for (const key of EMAIL_ENV_KEYS) example = addEnvVar(example, key, '');
		if (example !== exampleBefore) {
			fs.writeFileSync(exampleFile, example);
			changed.push('.env.example');
		}
	}
	return changed;
}

/** Remove the settings from `.env`. Returns the names that were there. */
export function removeLocalEmailEnv(workspaceRootDir: string): string[] {
	const envFile = path.join(workspaceRootDir, '.env');
	if (!fs.existsSync(envFile)) return [];
	const before = fs.readFileSync(envFile, 'utf8');
	let content = before;
	const removed: string[] = [];
	for (const key of EMAIL_ENV_KEYS) {
		const next = removeEnvVar(content, key);
		if (next !== content) removed.push(key);
		content = next;
	}
	if (content !== before) fs.writeFileSync(envFile, content);
	return removed;
}

/**
 * Write the settings into one env layer on a server, the way `vela env import`
 * does: credentials write-only, the rest readable back with `vela env list`.
 * Returns every key that changed, for the restart that follows.
 */
export async function writeRemoteEmailEnv(
	session: SshSession,
	files: LayerFiles,
	settings: EmailSettings
): Promise<string[]> {
	const secret: Record<string, string> = {};
	const open: Record<string, string> = {};
	for (const [key, value] of Object.entries(settings.values)) {
		if (settings.secretKeys.includes(key as EmailEnvKey)) secret[key] = value;
		else open[key] = value;
	}
	await importIntoLayer(session, files, open, true);
	if (Object.keys(secret).length > 0) await importIntoLayer(session, files, secret, false);

	const removed: string[] = [];
	for (const key of settings.stale) {
		if (await unsetInLayer(session, files, key)) removed.push(key);
	}
	return [...Object.keys(settings.values), ...removed];
}

/** Remove the settings from one env layer. Returns the names that were there. */
export async function removeRemoteEmailEnv(
	session: SshSession,
	files: LayerFiles
): Promise<string[]> {
	const removed: string[] = [];
	for (const key of EMAIL_ENV_KEYS) {
		if (await unsetInLayer(session, files, key)) removed.push(key);
	}
	return removed;
}
