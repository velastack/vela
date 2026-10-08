import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { readLocalEnvFile } from './remote-env.ts';
import type { SshSession } from './ssh.ts';
import { layerFiles, setInLayer, visibilityFor, type Layer } from './env-scopes.ts';
import { isInteractive } from './providers.ts';

export const ENV_EXAMPLE = '.env.example';

/**
 * Keys the server supplies on its own, so their absence from the layers means
 * nothing: what `runtime.env` derives, and the superuser `apply.sh` creates on
 * the first deploy of a backend.
 */
const SUPPLIED =
	/^(NODE_ENV|HOST|PORT|ORIGIN|PROTOCOL_HEADER|HOST_HEADER|ADDRESS_HEADER|XFF_DEPTH|PB_PORT|POCKETBASE_URL|POCKETBASE_SUPERUSER_EMAIL|POCKETBASE_SUPERUSER_PASSWORD|APP_NAME|VELA_)/;

/**
 * The names `.env.example` documents that the target's stack does not have.
 *
 * The file cannot say which of its keys are required — a project's own example
 * is full of optional ones — so this is a nudge, never a gate: it is what makes
 * a first deploy ask for the keys it will obviously want, and nothing more.
 */
export function missingFromExample(root: string, present: Iterable<string>): string[] {
	const file = path.join(root, ENV_EXAMPLE);
	if (!fs.existsSync(file)) return [];
	const have = new Set(present);
	return Object.keys(readLocalEnvFile(file))
		.filter((key) => !have.has(key) && !SUPPLIED.test(key))
		.sort();
}

export interface NudgeTarget {
	session: SshSession;
	appId: string;
	instance: string;
	targetName: string;
	preview: boolean;
}

/**
 * Say which documented keys the target lacks and, at a terminal, offer to set
 * them now, each into the layer the user picks. In CI the list is printed and
 * the deploy goes on. Returns the keys that were set, so the caller can resolve
 * the stack again.
 */
export async function nudgeMissingEnv(
	root: string,
	target: NudgeTarget,
	present: Iterable<string>
): Promise<string[]> {
	const missing = missingFromExample(root, present);
	if (missing.length === 0) return [];

	const where = pc.cyan(target.targetName);
	if (!isInteractive()) {
		p.log.warn(
			`${where} does not have ${missing.length} of the variables ${ENV_EXAMPLE} documents:\n\n` +
				missing.map((key) => `  ${key}`).join('\n') +
				`\n\nSet any it needs with ${pc.cyan(`vela env set KEY -t ${target.targetName}`)}.`
		);
		return [];
	}

	p.log.warn(
		`${where} does not have ${missing.length} of the variables ${ENV_EXAMPLE} documents:\n\n` +
			missing.map((key) => `  ${key}`).join('\n')
	);
	const go = await p.confirm({ message: 'Set any of them now?', initialValue: true });
	if (p.isCancel(go)) cancel();
	if (!go) return [];

	const set: string[] = [];
	for (const key of missing) {
		const layer = await pickLayer(key, target);
		if (!layer) continue;
		const asPublic = visibilityFor(key, false) === 'public' ? true : await askPublic(key);
		const value = await promptValue(key, asPublic);
		const files =
			layer === 'instance'
				? layerFiles(target.appId, 'instance', target.instance)
				: layerFiles(target.appId, layer);
		await setInLayer(target.session, files, key, value, asPublic);
		p.log.success(
			`${key} set${asPublic ? ' (public)' : ''} ${pc.dim(`(${layer === 'instance' ? target.targetName : layer})`)}`
		);
		set.push(key);
	}
	return set;
}

async function pickLayer(key: string, target: NudgeTarget): Promise<Layer | null> {
	const options: { value: Layer | 'skip'; label: string; hint?: string }[] = [
		{ value: 'instance', label: target.targetName, hint: 'this target only' },
		{ value: 'all', label: 'all', hint: 'every target, on every server this app is deployed to' }
	];
	if (target.preview) options.push({ value: 'preview', label: 'preview', hint: 'every preview' });
	options.push({ value: 'skip', label: 'skip', hint: 'leave it unset' });

	const choice = await p.select({ message: `Where should ${pc.cyan(key)} be set?`, options });
	if (p.isCancel(choice)) cancel();
	return choice === 'skip' ? null : choice;
}

async function askPublic(key: string): Promise<boolean> {
	const choice = await p.confirm({
		message: `Is ${pc.cyan(key)} public? (readable back with vela env list; no for a secret)`,
		initialValue: false
	});
	if (p.isCancel(choice)) cancel();
	return choice;
}

async function promptValue(key: string, asPublic: boolean): Promise<string> {
	const message = `Value for ${pc.cyan(key)}${asPublic ? pc.dim(' (public)') : ''}`;
	const validate = (input: string | undefined) => (!input?.length ? 'Required' : undefined);
	const value = asPublic
		? await p.text({ message, validate })
		: await p.password({ message, validate });
	if (p.isCancel(value)) cancel();
	return value;
}

function cancel(): never {
	p.cancel('Operation cancelled.');
	process.exit(0);
}
