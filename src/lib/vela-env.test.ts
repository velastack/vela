import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ensureEnvDeclarations, envImports, envNamesRead, VELA_ENV_VARS } from './vela-env.ts';
import { findProjectTemplate } from './templates.ts';

let dir: string;
afterEach(() => {
	if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('VELA_ENV_VARS', () => {
	test('declares what the minimal template declares, with the same descriptions', () => {
		const envTs = fs.readFileSync(
			path.join(findProjectTemplate('minimal').dir, 'src', 'env.ts'),
			'utf8'
		);
		const declared = [...envTs.matchAll(/^\t([A-Z_][A-Z0-9_]*): \{/gm)].map((m) => m[1]);
		expect(VELA_ENV_VARS.map((v) => v.name)).toEqual(declared);
		for (const spec of VELA_ENV_VARS) {
			expect(envTs).toContain(
				`description: ${JSON.stringify(spec.description).replace(/^"|"$/g, "'")}`
			);
		}
	});
});

describe('envImports', () => {
	test('named imports, aliases, and env.X through $env/dynamic', () => {
		const source = [
			"import { POCKETBASE_URL, TEST as IS_TEST } from '$app/env/private';",
			"import { PUBLIC_NAME } from '$app/env/public';",
			"import { env } from '$env/dynamic/private';",
			'const x = env.WORKFLOWS_ENABLED ?? env.WORKFLOWS_CONCURRENCY;'
		].join('\n');
		expect(envImports(source)).toEqual([
			{ name: 'POCKETBASE_URL', local: 'POCKETBASE_URL' },
			{ name: 'TEST', local: 'IS_TEST' },
			{ name: 'PUBLIC_NAME', local: 'PUBLIC_NAME' },
			{ name: 'WORKFLOWS_ENABLED', local: 'env.WORKFLOWS_ENABLED' },
			{ name: 'WORKFLOWS_CONCURRENCY', local: 'env.WORKFLOWS_CONCURRENCY' }
		]);
	});
});

describe('ensureEnvDeclarations', () => {
	test('creates src/env.ts, then extends it, never duplicating', async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-env-'));
		const first = await ensureEnvDeclarations(dir, VELA_ENV_VARS.slice(0, 2));
		expect(first).toMatchObject({ file: path.join('src', 'env.ts'), changed: true });
		const second = await ensureEnvDeclarations(dir, VELA_ENV_VARS);
		expect(second.changed).toBe(true);
		const third = await ensureEnvDeclarations(dir, VELA_ENV_VARS);
		expect(third.changed).toBe(false);

		fs.mkdirSync(path.join(dir, 'src', 'lib'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, 'src', 'lib', 'x.ts'),
			`import { ${VELA_ENV_VARS.map((v) => v.name).join(', ')} } from '$app/env/private';\n`
		);
		const content = fs.readFileSync(path.join(dir, 'src', 'env.ts'), 'utf8');
		for (const name of envNamesRead(dir)) expect(content).toContain(`${name}: {`);
	});
});
