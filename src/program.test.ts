import { describe, expect, test } from 'vitest';
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
	'auth',
	'api',
	'api-keys',
	'i18n',
	'teams',
	'payments',
	's3',
	'smtp',
	'cms'
];

const EXPECTED_MIGRATE_SUBCOMMANDS = ['up', 'down', 'create', 'collections', 'history-sync'];

const EXPECTED_ENV_SUBCOMMANDS = ['list', 'set', 'unset', 'import'];

const EXPECTED_DESTROY_SUBCOMMANDS = ['form', 'schema', 'resource', 'scaffold', 'deployment'];

const EXPECTED_BACKUP_SUBCOMMANDS = ['create', 'list', 'download', 'delete', 'schedule'];

const EXPECTED_CMS_EDITOR_SUBCOMMANDS = ['add', 'password', 'list'];

const EXPECTED_UI_SUBCOMMANDS = ['add', 'base'];

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
