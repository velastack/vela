import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export interface VelaConfig {
	apiKey?: string;
}

/**
 * `~/.vela`, home to the API key and the template registry cache. Resolved per
 * call so a test can point HOME somewhere disposable.
 */
export function configDir(): string {
	return path.join(os.homedir(), '.vela');
}

const CONFIG_DIR = configDir();
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export function readConfig(): VelaConfig | null {
	if (!fs.existsSync(CONFIG_PATH)) return null;
	try {
		return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as VelaConfig;
	} catch {
		return null;
	}
}

export function writeConfig(config: VelaConfig): void {
	fs.mkdirSync(CONFIG_DIR, { recursive: true });
	fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function clearConfig(): void {
	if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
}

/**
 * The velastack.dev API key, if there is one.
 *
 * `VELA_API_KEY` wins over `~/.vela/config.json`: a CI runner has no home
 * directory worth logging into, and the GitHub action passes the key this way.
 */
export function readApiKey(): string | null {
	const fromEnv = process.env.VELA_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	return readConfig()?.apiKey ?? null;
}

export function requireApiKey(): string {
	const apiKey = readApiKey();
	if (!apiKey) {
		throw new Error('Not logged in. Run `vela login` to login, or set VELA_API_KEY.');
	}
	return apiKey;
}
