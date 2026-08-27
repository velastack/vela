import { describe, expect, test } from 'vitest';
import { addEnvVar, hasEnvVar, removeEnvVar, upsertEnvVar } from './env.ts';

const FILE = `# PocketBase superuser credentials — used by \`vela\` commands
POCKETBASE_SUPERUSER_EMAIL=admin@example.com
POCKETBASE_SUPERUSER_PASSWORD=hunter2

# Payments
STRIPE_SECRET_KEY=sk_test_old
`;

describe('upsertEnvVar', () => {
	test('replaces a value where addEnvVar would do nothing', () => {
		expect(addEnvVar(FILE, 'STRIPE_SECRET_KEY', 'sk_live')).toBe(FILE);
		expect(upsertEnvVar(FILE, 'STRIPE_SECRET_KEY', 'sk_live')).toContain(
			'STRIPE_SECRET_KEY=sk_live'
		);
	});

	test('leaves comments, blank lines and ordering alone', () => {
		const out = upsertEnvVar(FILE, 'STRIPE_SECRET_KEY', 'sk_live');
		expect(out.split('\n')).toEqual([
			'# PocketBase superuser credentials — used by `vela` commands',
			'POCKETBASE_SUPERUSER_EMAIL=admin@example.com',
			'POCKETBASE_SUPERUSER_PASSWORD=hunter2',
			'',
			'# Payments',
			'STRIPE_SECRET_KEY=sk_live',
			''
		]);
	});

	test('appends a key the file does not have', () => {
		const out = upsertEnvVar(FILE, 'RESEND_API_KEY', 're_123');
		expect(out.startsWith(FILE)).toBe(true);
		expect(out.trimEnd().endsWith('RESEND_API_KEY=re_123')).toBe(true);
	});

	test('keeps an export prefix, which a sourced file depends on', () => {
		expect(upsertEnvVar('export API_URL=old\n', 'API_URL', 'new')).toBe('export API_URL=new\n');
	});

	test('quotes only what dotenv would misread', () => {
		expect(upsertEnvVar('', 'A', 'sk_live_123')).toBe('A=sk_live_123\n');
		expect(upsertEnvVar('', 'A', 'https://example.com/x')).toBe('A=https://example.com/x\n');
		expect(upsertEnvVar('', 'A', 'two words')).toBe('A="two words"\n');
		expect(upsertEnvVar('', 'A', 'has # hash')).toBe('A="has # hash"\n');
		expect(upsertEnvVar('', 'A', 'a"b\\c\nd')).toBe('A="a\\"b\\\\c\\nd"\n');
	});

	test('does not match a key that merely shares a prefix', () => {
		const out = upsertEnvVar('STRIPE_SECRET_KEY_OLD=keep\n', 'STRIPE_SECRET_KEY', 'new');
		expect(out).toContain('STRIPE_SECRET_KEY_OLD=keep');
		expect(out).toContain('STRIPE_SECRET_KEY=new');
	});

	test('replaces only the first occurrence when a file has duplicates', () => {
		const out = upsertEnvVar('A=one\nA=two\n', 'A', 'three');
		expect(out).toBe('A=three\nA=two\n');
	});
});

describe('removeEnvVar', () => {
	test('drops the line and nothing else', () => {
		const out = removeEnvVar(FILE, 'POCKETBASE_SUPERUSER_PASSWORD');
		expect(out).not.toContain('POCKETBASE_SUPERUSER_PASSWORD');
		expect(out).toContain('POCKETBASE_SUPERUSER_EMAIL=admin@example.com');
		expect(out).toContain('# Payments');
	});

	test('returns the file unchanged when the key is absent', () => {
		expect(removeEnvVar(FILE, 'NOT_THERE')).toBe(FILE);
	});
});

describe('hasEnvVar', () => {
	test('finds a key however it is written', () => {
		expect(hasEnvVar(FILE, 'STRIPE_SECRET_KEY')).toBe(true);
		expect(hasEnvVar('export A = 1\n', 'A')).toBe(true);
		expect(hasEnvVar(FILE, 'STRIPE')).toBe(false);
	});
});
