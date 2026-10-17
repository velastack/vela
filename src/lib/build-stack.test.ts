import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildStack, DevOnlyEnvError } from './build-stack.ts';
import { staticEnv, staticEnvImports } from './static-env.ts';
import { readAtBuildTime } from './env-command.ts';
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

const KIT3 = JSON.stringify({ devDependencies: { '@sveltejs/kit': '^3.0.0' } });
const KIT2 = JSON.stringify({ devDependencies: { '@sveltejs/kit': '^2.0.0' } });

const ENV_TS = `import { defineEnvVars } from '@sveltejs/kit/env';
const isProd = true;
export const variables = defineEnvVars({
	POCKETBASE_URL: { schema: (value) => value ?? '' },
	STRIPE_SECRET_KEY: { static: true },
	'PUBLIC_CMS_URL': { public: true, 'static': true },
	AI_MODEL: { static: isProd },
	COMPUTED: { static: (true) as boolean }
});
`;

describe('staticEnv', () => {
	test('on Kit 3, a variable is static when src/env.ts literally says so', () => {
		write('package.json', KIT3);
		write('src/env.ts', ENV_TS);
		// A leftover alias import says nothing about a runtime variable.
		write('src/lib/pb.ts', `import { POCKETBASE_URL } from '$env/static/private';\n`);
		const result = staticEnv(root);
		expect(result.rule).toBe('declarations');
		expect(result.how).toBe('declared static: true in src/env.ts');
		expect([...result.names].sort()).toEqual(['COMPUTED', 'PUBLIC_CMS_URL', 'STRIPE_SECRET_KEY']);
	});

	test('reads src/env.js and a plain object literal too', () => {
		write('package.json', KIT3);
		write(
			'src/env.js',
			`const variables = { A: { static: true }, B: {} };\nexport { variables };\n`
		);
		const result = staticEnv(root);
		expect([...result.names]).toEqual(['A']);
		expect(result.how).toBe('declared static: true in src/env.js');
	});

	test('on Kit 3 with no src/env.ts, nothing is static', () => {
		write('package.json', KIT3);
		write('src/lib/ai.ts', `import { ANTHROPIC_API_KEY } from '$env/static/private';\n`);
		expect(staticEnv(root).names.size).toBe(0);
	});

	test('a project that declares no SvelteKit is read by the Kit 3 rule', () => {
		write('src/env.ts', ENV_TS);
		write('src/lib/pb.ts', `import { POCKETBASE_URL } from '$env/static/private';\n`);
		expect(staticEnv(root).names.has('POCKETBASE_URL')).toBe(false);
		expect(staticEnv(root).names.has('STRIPE_SECRET_KEY')).toBe(true);
	});

	test('on Kit 2 the import path decides, and src/env.ts is not consulted', () => {
		write('package.json', KIT2);
		write('src/env.ts', ENV_TS);
		write('src/lib/pb.ts', `import { POCKETBASE_URL } from '$env/static/private';\n`);
		const result = staticEnv(root);
		expect(result.rule).toBe('imports');
		expect(result.how).toBe('imported from $env/static');
		expect([...result.names]).toEqual(['POCKETBASE_URL']);
	});

	test('readAtBuildTime filters the changed keys and names the rule', () => {
		write('package.json', KIT3);
		write('src/env.ts', ENV_TS);
		expect(readAtBuildTime(root, ['STRIPE_SECRET_KEY', 'AI_MODEL', 'POCKETBASE_URL'])).toEqual({
			baked: ['STRIPE_SECRET_KEY'],
			how: 'declared static: true in src/env.ts'
		});
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

	test('a static declaration of a dev-only key fails before the build', () => {
		write('package.json', KIT3);
		write('.env', 'ANTHROPIC_API_KEY=sk-ant\n');
		write(
			'src/env.ts',
			`import { defineEnvVars } from '@sveltejs/kit/env';\nexport const variables = defineEnvVars({ ANTHROPIC_API_KEY: { static: true } });\n`
		);
		expect(() => buildStack(root, { stack: {}, derived: {}, tunnel: true })).toThrow(
			DevOnlyEnvError
		);
		expect(() => buildStack(root, { stack: {}, derived: {}, tunnel: true })).toThrow(
			/ANTHROPIC_API_KEY is declared static: true in src\/env\.ts but set only in your \.env[^]*or drop static: true/
		);
	});

	test('on Kit 3 a leftover $env/static import of a runtime key does not fail the build', () => {
		write('package.json', KIT3);
		write('.env', 'ANTHROPIC_API_KEY=sk-ant\n');
		write('src/env.ts', `export const variables = { ANTHROPIC_API_KEY: {} };\n`);
		write('src/lib/ai.ts', `import { ANTHROPIC_API_KEY } from '$env/static/private';\n`);
		expect(buildStack(root, { stack: {}, derived: {}, tunnel: true }).blanked).toEqual([
			'ANTHROPIC_API_KEY'
		]);
	});

	test('on Kit 2 a static import of a dev-only key fails before the build', () => {
		write('package.json', KIT2);
		write('.env', 'ANTHROPIC_API_KEY=sk-ant\n');
		write('src/lib/ai.ts', `import { ANTHROPIC_API_KEY } from '$env/static/private';\n`);
		expect(() => buildStack(root, { stack: {}, derived: {}, tunnel: true })).toThrow(
			/ANTHROPIC_API_KEY is imported from \$env\/static but set only in your \.env[^]*or remove the import/
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
