import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { NO_DELEGATE_ENV, delegateToLocalCli, findLocalCli, isDelegatable } from './delegate.ts';

let tmp: string;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vela-delegate-')));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

/** Write a project-local `vela` install under `dir` and return its bin path. */
function writeLocalCli(
	dir: string,
	version: string,
	{ bin = { vela: './dist/bin.js', velastack: './dist/bin.js' } as unknown, body = '' } = {}
): string {
	const pkgDir = path.join(dir, 'node_modules', 'vela');
	fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
	fs.writeFileSync(
		path.join(pkgDir, 'package.json'),
		JSON.stringify({ name: 'vela', version, bin })
	);
	const binPath = path.join(pkgDir, 'dist', 'bin.js');
	fs.writeFileSync(binPath, body);
	return binPath;
}

describe('findLocalCli', () => {
	test('finds a local install at the working directory', () => {
		const binPath = writeLocalCli(tmp, '0.11.0');
		expect(findLocalCli(tmp, '/elsewhere/global/bin.js')).toEqual({ binPath, version: '0.11.0' });
	});

	test('walks up to a local install in an ancestor directory', () => {
		const binPath = writeLocalCli(tmp, '0.11.0');
		const nested = path.join(tmp, 'src', 'routes');
		fs.mkdirSync(nested, { recursive: true });
		expect(findLocalCli(nested, '/elsewhere/global/bin.js')?.binPath).toBe(binPath);
	});

	test('returns null when no local install exists', () => {
		expect(findLocalCli(tmp, '/elsewhere/global/bin.js')).toBeNull();
	});

	test('returns null when the local install is the running one', () => {
		const binPath = writeLocalCli(tmp, '0.11.0');
		expect(findLocalCli(tmp, binPath)).toBeNull();
	});

	test('accepts a string bin field', () => {
		const binPath = writeLocalCli(tmp, '0.11.0', { bin: './dist/bin.js' });
		expect(findLocalCli(tmp, '/elsewhere/global/bin.js')?.binPath).toBe(binPath);
	});

	test('returns null when the manifest is unreadable or incomplete', () => {
		const pkgDir = path.join(tmp, 'node_modules', 'vela');
		fs.mkdirSync(pkgDir, { recursive: true });
		fs.writeFileSync(path.join(pkgDir, 'package.json'), 'not json');
		expect(findLocalCli(tmp, '/elsewhere/global/bin.js')).toBeNull();
	});

	test('returns null when the bin file is missing', () => {
		const pkgDir = path.join(tmp, 'node_modules', 'vela');
		fs.mkdirSync(pkgDir, { recursive: true });
		fs.writeFileSync(
			path.join(pkgDir, 'package.json'),
			JSON.stringify({ name: 'vela', version: '0.11.0', bin: { vela: './dist/bin.js' } })
		);
		expect(findLocalCli(tmp, '/elsewhere/global/bin.js')).toBeNull();
	});

	test('stops at the nearest install rather than continuing upward', () => {
		writeLocalCli(tmp, '0.11.0');
		const inner = path.join(tmp, 'packages', 'app');
		fs.mkdirSync(inner, { recursive: true });
		const innerBin = writeLocalCli(inner, '0.12.0');
		expect(findLocalCli(inner, '/elsewhere/global/bin.js')).toEqual({
			binPath: innerBin,
			version: '0.12.0'
		});
	});
});

describe('isDelegatable', () => {
	test('bootstrapping commands are never handed off', () => {
		expect(isDelegatable(['create', 'my-app'])).toBe(false);
		expect(isDelegatable(['bless'])).toBe(false);
	});

	test('project commands are handed off', () => {
		expect(isDelegatable(['dev'])).toBe(true);
		expect(isDelegatable(['generate', 'scaffold', 'post'])).toBe(true);
	});

	test('skips leading flags when identifying the command', () => {
		expect(isDelegatable(['--verbose', 'create'])).toBe(false);
		expect(isDelegatable(['--verbose', 'dev'])).toBe(true);
	});

	test('a bare invocation is delegatable', () => {
		expect(isDelegatable([])).toBe(true);
		expect(isDelegatable(['--help'])).toBe(true);
	});
});

describe('delegateToLocalCli', () => {
	const selfPath = '/elsewhere/global/bin.js';

	test('does not delegate when the local version matches', () => {
		writeLocalCli(tmp, '0.9.0');
		const code = delegateToLocalCli({
			argv: ['dev'],
			cwd: tmp,
			selfPath,
			selfVersion: '0.9.0',
			env: {}
		});
		expect(code).toBeNull();
	});

	test('does not delegate when no local install exists', () => {
		const code = delegateToLocalCli({
			argv: ['dev'],
			cwd: tmp,
			selfPath,
			selfVersion: '0.9.0',
			env: {}
		});
		expect(code).toBeNull();
	});

	test('does not delegate when the sentinel is already set', () => {
		writeLocalCli(tmp, '0.11.0');
		const code = delegateToLocalCli({
			argv: ['dev'],
			cwd: tmp,
			selfPath,
			selfVersion: '0.9.0',
			env: { [NO_DELEGATE_ENV]: '1' }
		});
		expect(code).toBeNull();
	});

	test('does not delegate a bootstrapping command', () => {
		writeLocalCli(tmp, '0.11.0');
		const code = delegateToLocalCli({
			argv: ['create', 'my-app'],
			cwd: tmp,
			selfPath,
			selfVersion: '0.9.0',
			env: {}
		});
		expect(code).toBeNull();
	});

	test('runs the pinned CLI and returns its exit code', () => {
		writeLocalCli(tmp, '0.11.0', { body: 'process.exit(0);\n' });
		const code = delegateToLocalCli({
			argv: ['dev'],
			cwd: tmp,
			selfPath,
			selfVersion: '0.9.0',
			env: {}
		});
		expect(code).toBe(0);
	});

	test('propagates a non-zero exit code', () => {
		writeLocalCli(tmp, '0.11.0', { body: 'process.exit(3);\n' });
		const code = delegateToLocalCli({
			argv: ['dev'],
			cwd: tmp,
			selfPath,
			selfVersion: '0.9.0',
			env: {}
		});
		expect(code).toBe(3);
	});

	test('passes argv through and marks the child so it cannot delegate again', () => {
		const out = path.join(tmp, 'argv.json');
		writeLocalCli(tmp, '0.11.0', {
			body: `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), sentinel: process.env.${NO_DELEGATE_ENV} }));\n`
		});
		const code = delegateToLocalCli({
			argv: ['generate', 'scaffold', 'post', '--ai', 'a blog post'],
			cwd: tmp,
			selfPath,
			selfVersion: '0.9.0',
			env: {}
		});
		expect(code).toBe(0);
		expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual({
			argv: ['generate', 'scaffold', 'post', '--ai', 'a blog post'],
			sentinel: '1'
		});
	});
});
