import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { addEnvTargetOptions, applyChange, withEnvScope } from '../../lib/env-command.ts';
import { applyLocalEnvChange } from '../../lib/local-env.ts';
import { isInteractive } from '../../lib/providers.ts';
import { findWorkspaceRoot, hasBackend } from '../../lib/workspace.ts';
import { missingBackendMessage } from '../../lib/backend-gate.ts';
import { reportResult } from '../../lib/result-report.ts';
import {
	buildEmailSettings,
	describeEmailSettings,
	EMAIL_PROVIDER_IDS,
	EMAIL_PROVIDERS,
	findEmailProvider,
	writeLocalEmailEnv,
	writeRemoteEmailEnv,
	type EmailAnswers,
	type EmailSettings
} from '../../lib/email-settings.ts';

export interface EnableEmailFlags {
	provider?: string;
	region?: string;
	host?: string;
	port?: string;
	tls?: boolean;
	username?: string;
	password?: string;
	apiKey?: string;
	passwordStdin?: boolean;
	from?: string;
	fromName?: string;
	target?: string;
}

/**
 * CLI-only: this writes environment values and changes no file of the app's,
 * so it is not a `@velastack/patterns` pattern and does not go through
 * `runPattern`.
 */
export const email = addEnvTargetOptions(
	new Command('email')
		.description(
			'set up outgoing email: writes the PB_SMTP_* settings PocketBase reads, to .env or to a deployed target with -t'
		)
		.option(
			'--provider <id>',
			`email provider: ${EMAIL_PROVIDER_IDS.join(', ')} — prompted for on a terminal, otherwise smtp`
		)
		.option('--from <address>', 'address email is sent from (PB_SENDER_ADDRESS)')
		.option('--from-name <name>', 'name email is sent as (PB_SENDER_NAME)')
		.option(
			'--api-key <key>',
			'the provider’s API key or token, which is its SMTP password — prompted for when omitted'
		)
		.option('--password <password>', 'SMTP password; the same thing as --api-key')
		.option('--password-stdin', 'read the API key or password from standard input')
		.option('--username <username>', 'SMTP username, for providers that do not fix one')
		.option(
			'--region <region>',
			'provider region: required for ses (e.g. us-east-1), us or eu for mailgun'
		)
		.option('--host <host>', 'SMTP host — required for smtp, overrides the provider’s otherwise')
		.option('--port <port>', 'SMTP port — overrides the provider’s')
		.option('--tls', 'connect with TLS from the start (port 465); overrides the provider’s')
		.option('--no-tls', 'connect in the clear and upgrade with STARTTLS (port 587)')
		.configureHelp(helpConfig)
).action((raw: EnableEmailFlags) =>
	runCommand(async () => {
		const root = findWorkspaceRoot();
		if (root && !hasBackend(root)) throw new Error(missingBackendMessage('vela enable email'));

		// Everything is asked before a server is opened: a shared layer visits
		// every server the app is on, and none of them should wait on a prompt.
		const answers = await collectEmailAnswers(raw);
		const settings = buildEmailSettings(answers);
		const target = raw.target?.trim() || 'local';

		await withEnvScope(
			{ ...raw, target },
			{
				local: async (ctx) => {
					const changed = writeLocalEmailEnv(ctx.workspaceRootDir, settings);
					report(settings, 'local', changed);
					await applyLocalEnvChange(ctx, Object.keys(settings.values));
				},
				instance: async (ctx) => {
					const keys = await writeRemoteEmailEnv(ctx.session, ctx.files, settings);
					report(settings, ctx.targetName);
					// Restarts the app, which is when PocketBase reads these.
					await applyChange(ctx.workspaceRootDir, ctx, keys);
				},
				layer: async (ctx) => {
					const keys = await writeRemoteEmailEnv(ctx.session, ctx.files, settings);
					report(settings, `${ctx.layer}, ${ctx.server}`);
					await applyChange(ctx.workspaceRootDir, ctx, keys);
				}
			},
			{ label: 'enable email' }
		);

		p.note(
			nextSteps(settings, target)
				.map((step) => `- ${step}`)
				.join('\n'),
			'Next steps',
			{ format: (line) => line }
		);
	}, 'Failed to set up email.')
);

function report(settings: EmailSettings, where: string, files: string[] = []): void {
	reportResult({
		summary: `Email set up with ${settings.provider.label} ${pc.dim(`(${where})`)}`,
		filesModified: files,
		sections: [{ label: 'Environment', items: describeEmailSettings(settings) }]
	});
}

export function nextSteps(settings: EmailSettings, target: string): string[] {
	const local = target === 'local';
	const steps: string[] = [];
	if (local) {
		steps.push(
			'Restart `vela dev`, then send a test email: open /admin, Settings, Mail settings, "Send test email".'
		);
		steps.push(
			'Do the same on a deployed target: `vela enable email -t production` (the values in .env are not deployed).'
		);
	} else {
		steps.push(
			'Send a test email: open /admin on that target, Settings, Mail settings, "Send test email". The settings show as locked there because they come from the environment.'
		);
		steps.push('Change one value later with `vela env set <NAME> -t ' + target + '`.');
	}
	if (settings.provider.appKey && settings.values.PB_SMTP_PASSWORD) {
		steps.push(
			`The ${settings.provider.label} API key is in PB_SMTP_PASSWORD. App code that calls ${settings.provider.label}'s API can read it from there; there is no need for a second ${settings.provider.appKey}.`
		);
	}
	steps.push(
		`${settings.values.PB_SENDER_ADDRESS} has to be a sender ${settings.provider.id === 'smtp' ? 'your SMTP server' : settings.provider.label} accepts (a verified domain or address).`
	);
	return steps;
}

export interface CollectOptions {
	interactive?: boolean;
	readStdin?: () => Promise<string>;
}

/**
 * The flags, plus a question for each one left out. Without a terminal
 * nothing is asked, and whatever is still missing is reported in one go, by
 * flag name.
 */
export async function collectEmailAnswers(
	flags: EnableEmailFlags,
	options: CollectOptions = {}
): Promise<EmailAnswers> {
	const interactive = options.interactive ?? isInteractive();
	const missing: string[] = [];

	let providerId = flags.provider;
	if (!providerId) {
		providerId = interactive
			? cancelled(
					await p.select<string>({
						message: 'Email provider',
						options: EMAIL_PROVIDERS.map((provider) => ({
							value: provider.id,
							label: provider.label,
							hint: provider.host ? undefined : 'host, port, username and password'
						}))
					})
				)
			: 'smtp';
	}
	const provider = findEmailProvider(providerId);
	const plain = provider.id === 'smtp';

	let region = flags.region?.trim().toLowerCase();
	if (provider.region) {
		const { choices, required, hint } = provider.region;
		if (!region) {
			if (interactive) {
				region = choices
					? cancelled(
							await p.select<string>({
								message: `${provider.label} region`,
								options: choices.map((choice) => ({ value: choice, label: choice }))
							})
						)
					: cancelled(
							await p.text({
								message: `${provider.label} region (${hint})`,
								validate: (input) => (input?.trim() ? undefined : 'Required')
							})
						)
							.trim()
							.toLowerCase();
			} else if (required) missing.push(`--region <region> (${hint})`);
			else region = choices?.[0];
		}
		if (region && choices && !choices.includes(region)) {
			throw new Error(`${provider.label} has no region "${region}". Use ${choices.join(' or ')}.`);
		}
		if (region && !/^[a-z0-9-]+$/.test(region)) {
			throw new Error(`"${region}" is not a region name.`);
		}
	}

	let host = flags.host?.trim();
	if (!host && plain) {
		if (interactive) {
			host = cancelled(
				await p.text({
					message: 'SMTP host',
					placeholder: 'smtp.example.com',
					validate: (input) => (input?.trim() ? undefined : 'Required')
				})
			).trim();
		} else missing.push('--host <host>');
	}

	let port = flags.port === undefined ? undefined : Number(flags.port);
	if (flags.port !== undefined && !Number.isInteger(port)) {
		throw new Error(`--port: ${flags.port} is not a port number.`);
	}
	if (port === undefined && plain && interactive) {
		port = Number(
			cancelled(
				await p.text({
					message: 'SMTP port',
					initialValue: String(provider.port),
					validate: (input) => (/^\d+$/.test(input?.trim() ?? '') ? undefined : 'A port number')
				})
			).trim()
		);
	}

	let tls = flags.tls;
	if (tls === undefined && plain) {
		const implicit = (port ?? provider.port) === 465;
		tls = interactive
			? cancelled(
					await p.confirm({
						message: 'Connect with TLS from the start? (yes for port 465, no for 587 and STARTTLS)',
						initialValue: implicit
					})
				)
			: implicit;
	}

	let username = flags.username?.trim();
	if (username === undefined && provider.username.kind === 'ask') {
		if (interactive) {
			username = cancelled(
				await p.text({
					message: provider.username.label,
					validate: (input) => (plain || input?.trim() ? undefined : 'Required')
				})
			)?.trim();
		} else if (!plain) missing.push('--username <username>');
	}

	// A relay with no username takes no password either.
	const wantsSecret = !plain || Boolean(username);
	let secret = flags.apiKey ?? flags.password;
	if (flags.apiKey !== undefined && flags.password !== undefined) {
		throw new Error('--api-key and --password are the same value; pass one of them.');
	}
	if (secret === undefined && flags.passwordStdin) {
		secret = await (options.readStdin ?? readStdin)();
		if (!secret) throw new Error('--password-stdin: nothing arrived on standard input.');
	}
	if (secret === undefined && wantsSecret) {
		if (interactive) {
			secret = cancelled(
				await p.password({
					message: provider.secretLabel,
					validate: (input) => (input?.length ? undefined : 'Required')
				})
			);
		} else {
			missing.push(
				`--api-key <key>, --password <password> or --password-stdin (the ${provider.secretLabel})`
			);
		}
	}

	let from = flags.from?.trim();
	if (!from) {
		if (interactive) {
			from = cancelled(
				await p.text({
					message: 'Address to send from',
					placeholder: 'hello@example.com',
					validate: (input) => (input?.includes('@') ? undefined : 'An email address is required')
				})
			).trim();
		} else missing.push('--from <address>');
	}

	let fromName = flags.fromName?.trim();
	if (fromName === undefined && interactive) {
		fromName = cancelled(await p.text({ message: 'Name to send as (optional)' }))?.trim();
	}

	if (missing.length > 0) {
		throw new Error(
			`There is no terminal to ask on, and ${flags.provider ? `--provider ${provider.id}` : 'the default provider, smtp,'} needs:\n\n` +
				missing.map((flag) => `  ${flag}`).join('\n') +
				(flags.provider
					? ''
					: `\n\nOr name a provider: --provider <${EMAIL_PROVIDER_IDS.join('|')}>.`)
		);
	}

	return {
		provider,
		region,
		host,
		port,
		tls,
		username,
		secret,
		from: from!,
		fromName: fromName || undefined
	};
}

function cancelled<T>(value: T): Exclude<T, symbol> {
	if (p.isCancel(value)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return value as Exclude<T, symbol>;
}

async function readStdin(): Promise<string> {
	let data = '';
	process.stdin.setEncoding('utf8');
	for await (const chunk of process.stdin) data += chunk;
	return data.replace(/\r?\n$/, '');
}
