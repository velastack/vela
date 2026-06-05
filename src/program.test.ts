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
	'test:server',
	'routes',
	'i18n',
	'oauth',
	'schemas'
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

describe('program registration', () => {
	test('every top-level command is registered', () => {
		const names = program.commands.map((c) => c.name());
		for (const expected of EXPECTED_COMMANDS) {
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

	test('migrate registers all subcommands', () => {
		const migrate = program.commands.find((c) => c.name() === 'migrate')!;
		const names = migrate.commands.map((c) => c.name());
		for (const expected of EXPECTED_MIGRATE_SUBCOMMANDS) {
			expect(names).toContain(expected);
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
