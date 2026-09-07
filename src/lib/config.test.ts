import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type ConfigModule = typeof import('./config.ts');

let tmpHome: string;
let origHome: string | undefined;
let origUserProfile: string | undefined;
let config: ConfigModule;

beforeEach(async () => {
	tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-config-'));
	origHome = process.env.HOME;
	origUserProfile = process.env.USERPROFILE;
	process.env.HOME = tmpHome;
	process.env.USERPROFILE = tmpHome;
	vi.resetModules();
	config = await import('./config.ts');
});

afterEach(() => {
	if (origHome === undefined) delete process.env.HOME;
	else process.env.HOME = origHome;
	if (origUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = origUserProfile;
	fs.rmSync(tmpHome, { recursive: true, force: true });
});

const configPath = () => path.join(tmpHome, '.vela', 'config.json');

describe('readConfig', () => {
	test('returns null when the config file is missing', () => {
		expect(config.readConfig()).toBeNull();
	});

	test('returns null when the config file is malformed JSON', () => {
		fs.mkdirSync(path.join(tmpHome, '.vela'), { recursive: true });
		fs.writeFileSync(configPath(), '{not json');
		expect(config.readConfig()).toBeNull();
	});
});

describe('writeConfig', () => {
	test('creates the .vela directory if absent and persists the payload', () => {
		expect(fs.existsSync(path.join(tmpHome, '.vela'))).toBe(false);
		config.writeConfig({ apiKey: 'key.secret' });
		expect(JSON.parse(fs.readFileSync(configPath(), 'utf8'))).toEqual({ apiKey: 'key.secret' });
	});

	test('round-trip: readConfig returns what writeConfig wrote', () => {
		config.writeConfig({ apiKey: 'abc.xyz' });
		expect(config.readConfig()).toEqual({ apiKey: 'abc.xyz' });
	});

	test('overwrites an existing config', () => {
		config.writeConfig({ apiKey: 'first.key' });
		config.writeConfig({ apiKey: 'second.key' });
		expect(config.readConfig()).toEqual({ apiKey: 'second.key' });
	});
});

describe('clearConfig', () => {
	test('no-op when the file is absent', () => {
		expect(() => config.clearConfig()).not.toThrow();
	});

	test('removes the file when present', () => {
		config.writeConfig({ apiKey: 'abc.xyz' });
		config.clearConfig();
		expect(fs.existsSync(configPath())).toBe(false);
	});
});

describe('requireApiKey', () => {
	test('throws when not logged in', () => {
		expect(() => config.requireApiKey()).toThrow(/Not logged in/);
	});

	test('throws when config exists but has no apiKey', () => {
		fs.mkdirSync(path.join(tmpHome, '.vela'), { recursive: true });
		fs.writeFileSync(configPath(), JSON.stringify({}));
		expect(() => config.requireApiKey()).toThrow(/Not logged in/);
	});

	test('returns the apiKey when present', () => {
		config.writeConfig({ apiKey: 'key.secret' });
		expect(config.requireApiKey()).toBe('key.secret');
	});
});

describe('readApiKey', () => {
	const original = process.env.VELA_API_KEY;

	afterEach(() => {
		if (original === undefined) delete process.env.VELA_API_KEY;
		else process.env.VELA_API_KEY = original;
	});

	test('prefers VELA_API_KEY over the config file', () => {
		config.writeConfig({ apiKey: 'file.key' });
		process.env.VELA_API_KEY = ' env.key ';
		expect(config.readApiKey()).toBe('env.key');
	});

	test('falls back to the config file when the variable is blank', () => {
		config.writeConfig({ apiKey: 'file.key' });
		process.env.VELA_API_KEY = '   ';
		expect(config.readApiKey()).toBe('file.key');
	});

	test('is null with neither', () => {
		delete process.env.VELA_API_KEY;
		expect(config.readApiKey()).toBeNull();
	});
});
