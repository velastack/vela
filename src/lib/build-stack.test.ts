import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildStack, DevOnlyEnvError } from './build-stack.ts';
import { staticEnvImports } from './static-env.ts';
import { missingFromExample } from './env-nudge.ts';

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-build-stack-'));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
	const file = path.join(root, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

describe('staticEnvImports', () => {
	test('collects the names imported from $env/static, private and public, across src', () => {
		write(
			'src/lib/server/stripe.ts',
			`import { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET as whsec } from '$env/static/private';\n`
		);
		write(
			'src/routes/+layout.svelte',
			`<script lang="ts">\n\timport { PUBLIC_CMS_URL } from "$env/static/public";\n</script>\n`
		);
		write('src/lib/dynamic.ts', `import { env } from '$env/dynamic/private';\n`);
		expect([...staticEnvImports(root)].sort()).toEqual([
			'PUBLIC_CMS_URL',
			'STRIPE_SECRET_KEY',
			'STRIPE_WEBHOOK_SECRET'
		]);
	});

	test('a project with no src has none', () => {
		expect(staticEnvImports(root).size).toBe(0);
	});
});

describe('buildStack', () => {
	test('the target wins, vela derives on top, and dev-only keys are blanked', () => {
		write('.env', 'STRIPE_SECRET_KEY=sk_test\nAI_MODEL=small\nPOCKETBASE_URL=http://localhost:1\n');
		const { env, blanked } = buildStack(root, {
			stack: { STRIPE_SECRET_KEY: 'sk_live', WHATSAPP_MODE: 'velastack' },
			derived: { VELA_ORIGIN: 'https://acme.com', POCKETBASE_URL: 'http://127.0.0.1:9' },
			tunnel: true
		});
		expect(env).toEqual({
			STRIPE_SECRET_KEY: 'sk_live',
			WHATSAPP_MODE: 'velastack',
			VELA_ORIGIN: 'https://acme.com',
			POCKETBASE_URL: 'http://127.0.0.1:9',
			AI_MODEL: ''
		});
		expect(blanked).toEqual(['AI_MODEL']);
	});

	test('a build against a local database keeps the PocketBase keys it needs', () => {
		write(
			'.env',
			'POCKETBASE_SUPERUSER_EMAIL=a@b.c\nPOCKETBASE_SUPERUSER_PASSWORD=pw\nAI_MODEL=x\n'
		);
		const { env, blanked } = buildStack(root, { stack: {}, derived: {}, tunnel: false });
		expect(env).toEqual({ AI_MODEL: '' });
		expect(blanked).toEqual(['AI_MODEL']);
		expect('POCKETBASE_SUPERUSER_EMAIL' in env).toBe(false);
	});

	test('a static import of a dev-only key fails before the build', () => {
		write('.env', 'ANTHROPIC_API_KEY=sk-ant\n');
		write('src/lib/ai.ts', `import { ANTHROPIC_API_KEY } from '$env/static/private';\n`);
		expect(() => buildStack(root, { stack: {}, derived: {}, tunnel: true })).toThrow(
			DevOnlyEnvError
		);
		expect(() => buildStack(root, { stack: {}, derived: {}, tunnel: true })).toThrow(
			/ANTHROPIC_API_KEY is imported from \$env\/static but set only in your \.env/
		);
	});

	test('no .env means nothing to blank', () => {
		expect(buildStack(root, { stack: { A: '1' }, derived: {}, tunnel: true })).toEqual({
			env: { A: '1' },
			blanked: []
		});
	});
});

describe('missingFromExample', () => {
	test('names documented keys the stack lacks, minus what the server supplies', () => {
		write(
			'.env.example',
			[
				'# comment',
				'POCKETBASE_SUPERUSER_EMAIL=admin@example.com',
				'POCKETBASE_SUPERUSER_PASSWORD=change-me',
				'STRIPE_SECRET_KEY=sk_test_...',
				'PUBLIC_CMS_URL=http://localhost:5173',
				'ORIGIN=',
				'WHATSAPP_MODE='
			].join('\n') + '\n'
		);
		expect(missingFromExample(root, ['PUBLIC_CMS_URL'])).toEqual([
			'STRIPE_SECRET_KEY',
			'WHATSAPP_MODE'
		]);
	});

	test('no example, nothing missing', () => {
		expect(missingFromExample(root, [])).toEqual([]);
	});
});
