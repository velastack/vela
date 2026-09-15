import { describe, expect, test } from 'vitest';
import { Command } from 'commander';
import { program } from './program.ts';

const EXPECTED_COMMANDS = [
	'bless',
	'create',
	'generate',
	'enable',
	'disable',
	'destroy',
	'ui',
	'legal',
	'fixtures',
	'seeds',
	'signup',
	'login',
	'logout',
	'whoami',
	'migrate',
	'dev',
	'build',
	'preview',
	'sync',
	'provision',
	'deploy',
	'rollback',
	'status',
	'logs',
	'env',
	'backup',
	'restore',
	'link',
	'test:server',
	'routes',
	'i18n',
	'oauth',
	'schemas',
	'cms'
];

const EXPECTED_GENERATE_SUBCOMMANDS = ['form', 'schema', 'resource', 'scaffold', 'migration'];

const EXPECTED_ENABLE_SUBCOMMANDS = [
	'analytics',
	'auth',
	'api',
	'api-keys',
	'i18n',
	'teams',
	'payments',
	'subscriptions',
	'notifications',
	's3',
	'smtp',
	'cms'
];

const EXPECTED_DISABLE_SUBCOMMANDS = [
	'auth',
	'api',
	'api-keys',
	'backend',
	'content-negotiation',
	'i18n',
	'notifications',
	'teams',
	'payments',
	'subscriptions',
	's3',
	'smtp'
];

const EXPECTED_MIGRATE_SUBCOMMANDS = ['up', 'down', 'create', 'collections', 'history-sync'];

const EXPECTED_ENV_SUBCOMMANDS = ['list', 'set', 'unset', 'import'];

const EXPECTED_DESTROY_SUBCOMMANDS = ['form', 'schema', 'resource', 'scaffold', 'deployment'];

const EXPECTED_BACKUP_SUBCOMMANDS = ['create', 'list', 'download', 'delete', 'schedule'];

const EXPECTED_CMS_SUBCOMMANDS = ['editor', 'deploy'];

const EXPECTED_CMS_EDITOR_SUBCOMMANDS = ['add', 'password', 'list'];

const EXPECTED_UI_SUBCOMMANDS = ['add', 'list', 'style', 'base', 'theme'];

describe('program registration', () => {
	test('every top-level command is registered', () => {
		const names = program.commands.map((c) => c.name());
		for (const expected of EXPECTED_COMMANDS) {
			expect(names).toContain(expected);
		}
	});

	test('env registers its subcommands', () => {
		const env = program.commands.find((c) => c.name() === 'env')!;
		const names = env.commands.map((c) => c.name());
		for (const expected of EXPECTED_ENV_SUBCOMMANDS) {
			expect(names).toContain(expected);
		}
	});

	test('backup registers its subcommands', () => {
		const backup = program.commands.find((c) => c.name() === 'backup')!;
		const names = backup.commands.map((c) => c.name());
		for (const expected of EXPECTED_BACKUP_SUBCOMMANDS) {
			expect(names).toContain(expected);
		}
	});

	test('destroy registers its subcommands', () => {
		const destroy = program.commands.find((c) => c.name() === 'destroy')!;
		const names = destroy.commands.map((c) => c.name());
		for (const expected of EXPECTED_DESTROY_SUBCOMMANDS) {
			expect(names).toContain(expected);
		}
	});

	test('generate registers its pattern subcommands', () => {
		const generate = program.commands.find((c) => c.name() === 'generate')!;
		const names = generate.commands.map((c) => c.name());
		for (const expected of EXPECTED_GENERATE_SUBCOMMANDS) {
			expect(names).toContain(expected);
		}
	});

	test('enable registers all feature subcommands', () => {
		const enable = program.commands.find((c) => c.name() === 'enable')!;
		const names = enable.commands.map((c) => c.name());
		for (const expected of EXPECTED_ENABLE_SUBCOMMANDS) {
			expect(names).toContain(expected);
		}
	});

	test('disable registers all feature subcommands', () => {
		const disable = program.commands.find((c) => c.name() === 'disable')!;
		const names = disable.commands.map((c) => c.name());
		for (const expected of EXPECTED_DISABLE_SUBCOMMANDS) {
			expect(names).toContain(expected);
		}
	});

	test('cms registers its subcommands', () => {
		const cms = program.commands.find((c) => c.name() === 'cms')!;
		const names = cms.commands.map((c) => c.name());
		for (const expected of EXPECTED_CMS_SUBCOMMANDS) {
			expect(names).toContain(expected);
		}
	});

	test('cms deploy names the project and can return before the build ends', () => {
		const cms = program.commands.find((c) => c.name() === 'cms')!;
		const deploy = cms.commands.find((c) => c.name() === 'deploy')!;
		const flags = deploy.options.map((o) => o.long);
		expect(flags).toContain('--project');
		expect(flags).toContain('--no-wait');
		// A hosted site is not a target: no `-t`, and no SSH options.
		expect(flags).not.toContain('--target');
		expect(deploy.registeredArguments).toHaveLength(0);
	});

	test('cms editor registers its subcommands', () => {
		const cms = program.commands.find((c) => c.name() === 'cms')!;
		const editor = cms.commands.find((c) => c.name() === 'editor')!;
		const names = editor.commands.map((c) => c.name());
		for (const expected of EXPECTED_CMS_EDITOR_SUBCOMMANDS) {
			expect(names).toContain(expected);
		}
	});

	test('ui registers its subcommands and `add` can replace components', () => {
		const ui = program.commands.find((c) => c.name() === 'ui')!;
		const names = ui.commands.map((c) => c.name());
		for (const expected of EXPECTED_UI_SUBCOMMANDS) {
			expect(names).toContain(expected);
		}
		const add = ui.commands.find((c) => c.name() === 'add')!;
		expect(add.options.map((o) => o.long)).toContain('--overwrite');
		// A style switch replaces files, so it confirms unless told not to, and
		// the font is opt-out because it is most of what makes a style look right.
		const style = ui.commands.find((c) => c.name() === 'style')!;
		expect(style.options.map((o) => o.long)).toEqual(
			expect.arrayContaining(['--yes', '--no-font'])
		);
		const list = ui.commands.find((c) => c.name() === 'list')!;
		expect(list.options.map((o) => o.long)).toContain('--json');
	});

	test('migrate registers all subcommands', () => {
		const migrate = program.commands.find((c) => c.name() === 'migrate')!;
		const names = migrate.commands.map((c) => c.name());
		for (const expected of EXPECTED_MIGRATE_SUBCOMMANDS) {
			expect(names).toContain(expected);
		}
	});

	test('dev declares the vite server flags `vela create` tells users to run', () => {
		const dev = program.commands.find((c) => c.name() === 'dev')!;
		const flags = dev.options.map((o) => o.long);
		// `vela create` prints `npm run dev -- --open`, and the templates run
		// `vela dev` — so dropping these turns that next step into an error.
		// The names mirror vite's own CLI so its docs carry over.
		for (const flag of ['--open', '--host', '--port', '--strictPort', '--cors', '--force']) {
			expect(flags).toContain(flag);
		}
	});

	test('migrate aliases are wired', () => {
		const migrate = program.commands.find((c) => c.name() === 'migrate')!;
		const byName = (n: string) => migrate.commands.find((c) => c.name() === n)!;
		expect(byName('down').aliases()).toContain('rollback');
		expect(byName('create').aliases()).toContain('new');
		expect(byName('collections').aliases()).toContain('snapshot');
	});
});

/**
 * One selector, everywhere. These assertions are the executable form of the
 * decisions: a positional server or a stray `--env` creeping back into any of
 * these commands is a regression, not a style choice.
 */
describe('target selection', () => {
	const find = (path: string) => {
		const [name, sub] = path.split(' ');
		const command = program.commands.find((c) => c.name() === name)!;
		return sub ? command.commands.find((c) => c.name() === sub)! : command;
	};

	const TARGET_AWARE: [string, string][] = [
		['deploy', 'production'],
		['status', 'production'],
		['logs', 'production'],
		['rollback', 'production'],
		['destroy deployment', 'production'],
		['env list', 'local'],
		['env set', 'local'],
		['env unset', 'local'],
		['env import', 'local'],
		['admin create', 'local'],
		['backup create', 'production'],
		['backup list', 'production'],
		['backup download', 'production'],
		['backup delete', 'production'],
		['backup schedule', 'production'],
		['restore', 'production'],
		['enable s3', 'local'],
		['disable s3', 'local']
	];

	test.each(TARGET_AWARE)('%s takes -t and no longer takes --env', (path) => {
		const flags = find(path).options.map((o) => o.long);
		expect(flags).toContain('--target');
		expect(flags).toContain('--server');
		expect(flags).not.toContain('--env');
	});

	test.each(TARGET_AWARE)('%s defaults to %s', (path, fallback) => {
		const option = find(path).options.find((o) => o.long === '--target')!;
		expect(option.defaultValue).toBe(fallback);
	});

	test.each(TARGET_AWARE.map(([path]) => path))('%s takes no positional server', (path) => {
		// The old shape accepted the SSH host positionally on half of these.
		const positionals = find(path).registeredArguments.map((a) => a.name());
		expect(positionals).not.toContain('target');
	});

	test('provision keeps a machine, not a target', () => {
		const provision = program.commands.find((c) => c.name() === 'provision')!;
		expect(provision.options.map((o) => o.long)).not.toContain('--target');
		expect(provision.registeredArguments.map((a) => a.name())).toEqual(['target']);
	});
});

describe('pattern argv forwarding', () => {
	function walk(cmd: Command): Command[] {
		return [cmd, ...cmd.commands.flatMap(walk)];
	}

	// Private commander state, read the same way `registeredArguments` is above.
	const forwarding = walk(program).filter(
		(c) => (c as unknown as { _allowUnknownOption: boolean })._allowUnknownOption
	);

	test('at least the enable/disable/generate/destroy families forward argv', () => {
		expect(forwarding.map((c) => c.name())).toContain('cms');
	});

	test.each(forwarding.map((c) => [`${c.parent?.name() ?? ''} ${c.name()}`.trim(), c] as const))(
		'%s accepts an unknown option and its value',
		(_path, cmd) => {
			// Commander appends unknown options to `args` and then counts them as
			// excess positionals, so `enable cms --endpoint <url>` failed with "too
			// many arguments" until the command also allowed excess arguments.
			expect((cmd as unknown as { _allowExcessArguments: boolean })._allowExcessArguments).toBe(
				true
			);
		}
	);

	test('enable cms parses --endpoint <url> as its own option', async () => {
		const enable = program.commands.find((c) => c.name() === 'enable')!;
		const cms = enable.commands.find((c) => c.name() === 'cms')!;
		const url = 'https://velastack.dev/v1/projects/2tj321uzke7k7fn/cms';
		const original = (cms as unknown as { _actionHandler: unknown })._actionHandler;
		let seen: { endpoint?: string; args: string[] } | undefined;
		cms.exitOverride().action((opts: { endpoint?: string }, c: Command) => {
			seen = { endpoint: opts.endpoint, args: c.args };
		});
		try {
			await program.parseAsync(['enable', 'cms', '--endpoint', url, '--other'], { from: 'user' });
		} finally {
			(cms as unknown as { _actionHandler: unknown })._actionHandler = original;
		}
		// The endpoint is a declared option so it can lift the static-site guard;
		// anything else still passes through to the pattern.
		expect(seen).toEqual({ endpoint: url, args: ['--other'] });
	});

	test('enable analytics parses --provider <id> as its own option', async () => {
		const enable = program.commands.find((c) => c.name() === 'enable')!;
		const analytics = enable.commands.find((c) => c.name() === 'analytics')!;
		const original = (analytics as unknown as { _actionHandler: unknown })._actionHandler;
		let seen: { provider?: string; args: string[] } | undefined;
		analytics.exitOverride().action((opts: { provider?: string }, c: Command) => {
			seen = { provider: opts.provider, args: c.args };
		});
		try {
			await program.parseAsync(['enable', 'analytics', '--provider', 'plausible', '--other'], {
				from: 'user'
			});
		} finally {
			(analytics as unknown as { _actionHandler: unknown })._actionHandler = original;
		}
		// The provider is consumed here and handed to the pattern as input, so it
		// never reaches the argv the generic --provider guard inspects.
		expect(seen).toEqual({ provider: 'plausible', args: ['--other'] });
	});
});
