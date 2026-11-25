import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const prompts = vi.hoisted(() => ({
	select: vi.fn(),
	text: vi.fn(),
	password: vi.fn(),
	confirm: vi.fn()
}));

vi.mock('@clack/prompts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@clack/prompts')>();
	return { ...actual, ...prompts };
});

const { collectEmailAnswers, nextSteps } = await import('./email.ts');
const {
	buildEmailSettings,
	describeEmailSettings,
	EMAIL_ENV_KEYS,
	findEmailProvider,
	removeLocalEmailEnv,
	removeRemoteEmailEnv,
	writeLocalEmailEnv,
	writeRemoteEmailEnv
} = await import('../../lib/email-settings.ts');
const { parseEnv } = await import('../../lib/remote-env.ts');
type SshSession = import('../../lib/ssh.ts').SshSession;

const SECRET = 're_live_do_not_print_me';

beforeEach(() => {
	for (const prompt of Object.values(prompts)) prompt.mockReset();
});

async function settingsFor(flags: Parameters<typeof collectEmailAnswers>[0]) {
	return buildEmailSettings(await collectEmailAnswers(flags, { interactive: false }));
}

describe('provider table', () => {
	test('resend: fixed host, implicit TLS on 465, the API key as the password', async () => {
		const settings = await settingsFor({
			provider: 'resend',
			apiKey: SECRET,
			from: 'hello@example.com',
			fromName: 'Example'
		});
		expect(settings.values).toEqual({
			PB_SMTP_HOST: 'smtp.resend.com',
			PB_SMTP_PORT: '465',
			PB_SMTP_TLS: 'true',
			PB_SMTP_USERNAME: 'resend',
			PB_SMTP_PASSWORD: SECRET,
			PB_SENDER_ADDRESS: 'hello@example.com',
			PB_SENDER_NAME: 'Example'
		});
		expect(settings.secretKeys).toEqual(['PB_SMTP_PASSWORD']);
		expect(prompts.select).not.toHaveBeenCalled();
	});

	test('sendgrid signs in as the literal user "apikey"', async () => {
		const settings = await settingsFor({ provider: 'sendgrid', apiKey: SECRET, from: 'a@b.co' });
		expect(settings.values).toMatchObject({
			PB_SMTP_HOST: 'smtp.sendgrid.net',
			PB_SMTP_PORT: '465',
			PB_SMTP_TLS: 'true',
			PB_SMTP_USERNAME: 'apikey'
		});
	});

	test('postmark uses the token as username too, over STARTTLS, and both are secret', async () => {
		const settings = await settingsFor({ provider: 'postmark', apiKey: SECRET, from: 'a@b.co' });
		expect(settings.values).toMatchObject({
			PB_SMTP_HOST: 'smtp.postmarkapp.com',
			PB_SMTP_PORT: '587',
			PB_SMTP_TLS: 'false',
			PB_SMTP_USERNAME: SECRET,
			PB_SMTP_PASSWORD: SECRET
		});
		expect(settings.secretKeys.sort()).toEqual(['PB_SMTP_PASSWORD', 'PB_SMTP_USERNAME']);
		expect(describeEmailSettings(settings).join('\n')).not.toContain(SECRET);
	});

	test('mailgun needs its SMTP login, and has an EU host', async () => {
		await expect(
			settingsFor({ provider: 'mailgun', password: SECRET, from: 'a@b.co' })
		).rejects.toThrow(/--username/);
		const us = await settingsFor({
			provider: 'mailgun',
			username: 'postmaster@mg.example.com',
			password: SECRET,
			from: 'a@b.co'
		});
		expect(us.values.PB_SMTP_HOST).toBe('smtp.mailgun.org');
		const eu = await settingsFor({
			provider: 'mailgun',
			region: 'eu',
			username: 'postmaster@mg.example.com',
			password: SECRET,
			from: 'a@b.co'
		});
		expect(eu.values.PB_SMTP_HOST).toBe('smtp.eu.mailgun.org');
		await expect(
			settingsFor({
				provider: 'mailgun',
				region: 'mars',
				username: 'x',
				password: SECRET,
				from: 'a@b.co'
			})
		).rejects.toThrow(/no region "mars"/);
	});

	test('ses builds its host from the region, which it cannot do without', async () => {
		await expect(
			settingsFor({ provider: 'ses', username: 'AKIA', password: SECRET, from: 'a@b.co' })
		).rejects.toThrow(/--region/);
		const settings = await settingsFor({
			provider: 'ses',
			region: 'eu-west-1',
			username: 'AKIA',
			password: SECRET,
			from: 'a@b.co'
		});
		expect(settings.values.PB_SMTP_HOST).toBe('email-smtp.eu-west-1.amazonaws.com');
	});

	test('an unknown provider lists the known ones', () => {
		expect(() => findEmailProvider('sparkpost')).toThrow(/resend[\s\S]*smtp/);
	});
});

describe('without a terminal', () => {
	test('no flags at all means smtp, and names every flag it still needs', async () => {
		const error = await collectEmailAnswers({}, { interactive: false }).catch((e: Error) => e);
		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain('--host <host>');
		expect(message).toContain('--from <address>');
		expect(message).toContain('--provider <');
		for (const prompt of Object.values(prompts)) expect(prompt).not.toHaveBeenCalled();
	});

	test('a named provider with no secret names the three ways to pass one', async () => {
		await expect(
			collectEmailAnswers({ provider: 'resend', from: 'a@b.co' }, { interactive: false })
		).rejects.toThrow(/--api-key <key>, --password <password> or --password-stdin/);
	});

	test('plain smtp from flags: port decides TLS unless told', async () => {
		const implicit = await settingsFor({
			provider: 'smtp',
			host: 'mail.example.com',
			port: '465',
			username: 'mailer',
			password: SECRET,
			from: 'a@b.co'
		});
		expect(implicit.values).toMatchObject({ PB_SMTP_PORT: '465', PB_SMTP_TLS: 'true' });
		const starttls = await settingsFor({
			provider: 'smtp',
			host: 'mail.example.com',
			username: 'mailer',
			password: SECRET,
			from: 'a@b.co'
		});
		expect(starttls.values).toMatchObject({ PB_SMTP_PORT: '587', PB_SMTP_TLS: 'false' });
		const forced = await settingsFor({
			provider: 'smtp',
			host: 'mail.example.com',
			tls: true,
			username: 'mailer',
			password: SECRET,
			from: 'a@b.co'
		});
		expect(forced.values.PB_SMTP_TLS).toBe('true');
	});

	test('an open relay takes no credentials, and clears old ones', async () => {
		const settings = await settingsFor({ host: 'relay.internal', from: 'a@b.co' });
		expect(settings.values).not.toHaveProperty('PB_SMTP_USERNAME');
		expect(settings.values).not.toHaveProperty('PB_SMTP_PASSWORD');
		expect(settings.stale).toEqual(['PB_SMTP_USERNAME', 'PB_SMTP_PASSWORD']);
	});

	test('the secret can arrive on standard input', async () => {
		const answers = await collectEmailAnswers(
			{ provider: 'resend', passwordStdin: true, from: 'a@b.co' },
			{ interactive: false, readStdin: async () => SECRET }
		);
		expect(answers.secret).toBe(SECRET);
	});

	test('--api-key and --password together are refused', async () => {
		await expect(
			collectEmailAnswers(
				{ provider: 'resend', apiKey: 'a', password: 'b', from: 'a@b.co' },
				{ interactive: false }
			)
		).rejects.toThrow(/same value/);
	});

	test('a bad sender or port is refused', async () => {
		await expect(
			settingsFor({ provider: 'resend', apiKey: SECRET, from: 'not-an-address' })
		).rejects.toThrow(/email address/);
		await expect(
			settingsFor({ provider: 'resend', apiKey: SECRET, from: 'a@b.co', port: 'smtp' })
		).rejects.toThrow(/--port/);
	});
});

describe('on a terminal', () => {
	test('a named provider asks only for the secret and the sender', async () => {
		prompts.select.mockResolvedValueOnce('resend');
		prompts.password.mockResolvedValueOnce(SECRET);
		prompts.text.mockResolvedValueOnce('hello@example.com').mockResolvedValueOnce('');
		const settings = buildEmailSettings(await collectEmailAnswers({}, { interactive: true }));
		expect(settings.values).toMatchObject({
			PB_SMTP_HOST: 'smtp.resend.com',
			PB_SMTP_PASSWORD: SECRET,
			PB_SENDER_ADDRESS: 'hello@example.com'
		});
		expect(settings.values).not.toHaveProperty('PB_SENDER_NAME');
		expect(prompts.password).toHaveBeenCalledTimes(1);
		// Sender address and name; never host, port or username.
		expect(prompts.text).toHaveBeenCalledTimes(2);
		expect(prompts.confirm).not.toHaveBeenCalled();
	});

	test('smtp asks for host, port, TLS, username and password', async () => {
		prompts.select.mockResolvedValueOnce('smtp');
		prompts.text
			.mockResolvedValueOnce('mail.example.com')
			.mockResolvedValueOnce('2525')
			.mockResolvedValueOnce('mailer')
			.mockResolvedValueOnce('a@b.co')
			.mockResolvedValueOnce('Example');
		prompts.confirm.mockResolvedValueOnce(false);
		prompts.password.mockResolvedValueOnce(SECRET);
		const settings = buildEmailSettings(await collectEmailAnswers({}, { interactive: true }));
		expect(settings.values).toEqual({
			PB_SMTP_HOST: 'mail.example.com',
			PB_SMTP_PORT: '2525',
			PB_SMTP_TLS: 'false',
			PB_SMTP_USERNAME: 'mailer',
			PB_SMTP_PASSWORD: SECRET,
			PB_SENDER_ADDRESS: 'a@b.co',
			PB_SENDER_NAME: 'Example'
		});
	});
});

describe('next steps', () => {
	test('point at the test email, the target, and the key that is already there', async () => {
		const settings = await settingsFor({ provider: 'resend', apiKey: SECRET, from: 'a@b.co' });
		const local = nextSteps(settings, 'local').join('\n');
		expect(local).toContain('Send test email');
		expect(local).toContain('vela enable email -t production');
		expect(local).toMatch(/PB_SMTP_PASSWORD[\s\S]*RESEND_API_KEY/);
		expect(local).not.toContain(SECRET);
		const remote = nextSteps(settings, 'production').join('\n');
		expect(remote).not.toContain('vela enable email -t production');
	});
});

describe('writing .env', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-email-test-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('updates lines in place, appends the rest, and leaves everything else alone', async () => {
		fs.writeFileSync(
			path.join(dir, '.env'),
			'# mine\nFOO=bar\nPB_SMTP_HOST=old.example.com\nPB_SMTP_USERNAME=old\nBAZ=1\n'
		);
		const settings = await settingsFor({ provider: 'resend', apiKey: SECRET, from: 'a@b.co' });
		expect(writeLocalEmailEnv(dir, settings)).toEqual(['.env']);
		const lines = fs.readFileSync(path.join(dir, '.env'), 'utf8').split('\n');
		expect(lines.slice(0, 5)).toEqual([
			'# mine',
			'FOO=bar',
			'PB_SMTP_HOST=smtp.resend.com',
			'PB_SMTP_USERNAME=resend',
			'BAZ=1'
		]);
		expect(lines).toContain(`PB_SMTP_PASSWORD=${SECRET}`);
		expect(lines).toContain('PB_SMTP_PORT=465');
		// Run again: nothing to change.
		expect(writeLocalEmailEnv(dir, settings)).toEqual([]);
	});

	test('names go into .env.example with empty values, once, and only when it exists', async () => {
		const settings = await settingsFor({ provider: 'resend', apiKey: SECRET, from: 'a@b.co' });
		writeLocalEmailEnv(dir, settings);
		expect(fs.existsSync(path.join(dir, '.env.example'))).toBe(false);

		fs.writeFileSync(path.join(dir, '.env.example'), 'FOO=\nPB_SMTP_HOST=\n');
		expect(writeLocalEmailEnv(dir, settings)).toEqual(['.env.example']);
		const example = fs.readFileSync(path.join(dir, '.env.example'), 'utf8');
		for (const key of EMAIL_ENV_KEYS) {
			expect(example.match(new RegExp(`^${key}=$`, 'gm'))).toHaveLength(1);
		}
		expect(example).not.toContain(SECRET);
		expect(example).not.toContain('smtp.resend.com');
		expect(writeLocalEmailEnv(dir, settings)).toEqual([]);
	});

	test('credentials an open relay does not use are taken out', async () => {
		fs.writeFileSync(path.join(dir, '.env'), 'PB_SMTP_USERNAME=old\nPB_SMTP_PASSWORD=old\n');
		writeLocalEmailEnv(dir, await settingsFor({ host: 'relay.internal', from: 'a@b.co' }));
		const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
		expect(env).not.toContain('PB_SMTP_USERNAME');
		expect(env).not.toContain('PB_SMTP_PASSWORD');
	});

	test('disable removes the seven and nothing else', async () => {
		const settings = await settingsFor({ provider: 'resend', apiKey: SECRET, from: 'a@b.co' });
		fs.writeFileSync(path.join(dir, '.env'), 'FOO=bar\n');
		writeLocalEmailEnv(dir, settings);
		expect(removeLocalEmailEnv(dir).sort()).toEqual(Object.keys(settings.values).sort());
		expect(fs.readFileSync(path.join(dir, '.env'), 'utf8').trim()).toBe('FOO=bar');
		expect(removeLocalEmailEnv(dir)).toEqual([]);
	});
});

describe('writing to a target', () => {
	/** An SSH session that is a map of remote files. */
	function fakeSession(files: Record<string, string> = {}) {
		const session = {
			readFile: async (file: string) => files[file] ?? null,
			writeFile: async (file: string, content: string) => {
				files[file] = content;
			},
			script: async () => ({ stdout: '', stderr: '', exitCode: 0 })
		};
		return { session: session as unknown as SshSession, files };
	}
	const layer = { secret: '/etc/vela/apps/app/env', public: '/etc/vela/apps/app/env.public' };

	test('credentials are written secret, the rest readable, and other keys stay', async () => {
		const { session, files } = fakeSession({
			[layer.secret]: 'STRIPE_SECRET_KEY="sk"\nPB_SMTP_HOST="old.example.com"\n'
		});
		const settings = await settingsFor({ provider: 'resend', apiKey: SECRET, from: 'a@b.co' });
		const keys = await writeRemoteEmailEnv(session, layer, settings);

		const secret = parseEnv(files[layer.secret]!);
		const open = parseEnv(files[layer.public]!);
		expect(secret).toEqual({ STRIPE_SECRET_KEY: 'sk', PB_SMTP_PASSWORD: SECRET });
		expect(open).toEqual({
			PB_SMTP_HOST: 'smtp.resend.com',
			PB_SMTP_PORT: '465',
			PB_SMTP_TLS: 'true',
			PB_SMTP_USERNAME: 'resend',
			PB_SENDER_ADDRESS: 'a@b.co'
		});
		expect(files[layer.public]).not.toContain(SECRET);
		expect(keys.sort()).toEqual(Object.keys(settings.values).sort());
	});

	test('disable unsets them from both sides', async () => {
		const { session, files } = fakeSession();
		const settings = await settingsFor({ provider: 'postmark', apiKey: SECRET, from: 'a@b.co' });
		await writeRemoteEmailEnv(session, layer, settings);
		const removed = await removeRemoteEmailEnv(session, layer);
		expect(removed.sort()).toEqual(Object.keys(settings.values).sort());
		expect(parseEnv(files[layer.secret]!)).toEqual({});
		expect(parseEnv(files[layer.public]!)).toEqual({});
	});
});
