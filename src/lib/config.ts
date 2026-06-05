import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface VelaConfig {
	apiKey?: string;
}

const CONFIG_DIR = path.join(os.homedir(), '.vela');
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

export function requireApiKey(): string {
	const config = readConfig();
	if (!config?.apiKey) {
		throw new Error('Not logged in. Run `vela login` to login.');
	}
	return config.apiKey;
}
