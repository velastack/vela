import process from 'node:process';
import * as p from '@clack/prompts';
import { bySlug, type Pattern, type Provider, type Slug } from '@velastack/patterns';

/**
 * Provider selection for `vela enable <capability> --provider <id>`.
 *
 * A pattern that declares `providers` needs exactly one of them chosen. The
 * decision itself is pure so it can be tested without a terminal: the flag
 * wins when given, a terminal gets a prompt, and anything else is an error
 * naming the flag to pass.
 */
export interface ProviderRequest {
	/** `analytics` for `enable-analytics`, as shown in messages. */
	patternName: string;
	providers: Provider[];
	/** `--provider`, as typed. */
	flagValue?: string;
	/** Whether a prompt can be shown at all. */
	interactive: boolean;
}

export type ProviderDecision =
	{ kind: 'use'; provider: Provider } | { kind: 'prompt' } | { kind: 'error'; message: string };

export function capabilityName(slug: string): string {
	return slug.replace(/^enable-/, '');
}

function choices(providers: Provider[]): string {
	return `--provider <${providers.map((provider) => provider.id).join('|')}>`;
}

export function unknownProviderMessage(name: string, raw: string, providers: Provider[]): string {
	return [
		`Unknown provider "${raw}" for ${name}.`,
		'',
		'Available providers:',
		...providers.map((provider) => `  ${provider.id}`)
	].join('\n');
}

export function decideProvider(request: ProviderRequest): ProviderDecision {
	const { patternName, providers, flagValue, interactive } = request;

	if (flagValue !== undefined) {
		const provider = providers.find((candidate) => candidate.id === flagValue);
		if (!provider) {
			return { kind: 'error', message: unknownProviderMessage(patternName, flagValue, providers) };
		}
		return { kind: 'use', provider };
	}

	if (interactive) return { kind: 'prompt' };

	return {
		kind: 'error',
		message:
			`Choose ${article(patternName)} ${patternName} provider: pass ${choices(providers)}. ` +
			'There is no terminal to ask on.'
	};
}

function article(word: string): string {
	return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

export function isInteractive(): boolean {
	return Boolean(process.stdout.isTTY) && !process.env.CI;
}

/** Whether `--provider` was left in the argv handed through to a pattern. */
export function providerFlagInArgv(argv: string[]): boolean {
	return argv.some((arg) => arg === '--provider' || arg.startsWith('--provider='));
}

/**
 * The generic guard every pattern run passes through. A pattern with
 * providers must be told which one; a pattern without them must not be handed
 * `--provider` as if it meant something. `input.provider` on its own is fine
 * either way: `enable payments` sends one for a pattern that declares none.
 */
export function checkProviderInput(
	pattern: Pick<Pattern, 'title' | 'providers'>,
	argv: string[],
	input: Record<string, unknown>
): void {
	const providers = pattern.providers ?? [];
	if (providers.length > 0) {
		if (typeof input.provider !== 'string' || input.provider.length === 0) {
			throw new Error(`${pattern.title} needs a provider. Pass ${choices(providers)}.`);
		}
		return;
	}
	if (providerFlagInArgv(argv)) {
		throw new Error(`${pattern.title} does not support --provider.`);
	}
}

/** The provider for a run of `slug`: from `--provider`, else a prompt. */
export async function resolveProvider(slug: Slug, flagValue?: string): Promise<Provider> {
	const pattern: Pattern = bySlug[slug];
	const providers = pattern.providers ?? [];
	if (providers.length === 0) {
		throw new Error(`${pattern.title} does not support --provider.`);
	}
	const patternName = capabilityName(slug);

	const decision = decideProvider({
		patternName,
		providers,
		flagValue,
		interactive: isInteractive()
	});
	if (decision.kind === 'error') throw new Error(decision.message);
	if (decision.kind === 'use') return decision.provider;

	const selected = await p.select<string>({
		message: `Select ${patternName} provider`,
		options: providers.map((provider) => ({ value: provider.id, label: provider.label }))
	});
	if (p.isCancel(selected)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return providers.find((provider) => provider.id === selected)!;
}

/**
 * Values for the provider's declared env keys. One already in the
 * environment (the workspace `.env` is loaded before every command) is kept
 * without asking; on a terminal the rest are prompted for, blank allowed;
 * off a terminal they fall back to the declared default or blank, and the
 * pattern writes an empty assignment for the developer to fill in.
 */
export async function collectProviderEnv(provider: Provider): Promise<Record<string, string>> {
	const values: Record<string, string> = {};
	const interactive = isInteractive();

	for (const variable of provider.env ?? []) {
		const existing = process.env[variable.key];
		if (existing) {
			values[variable.key] = existing;
			continue;
		}
		if (!interactive) {
			values[variable.key] = variable.default ?? '';
			continue;
		}
		const value = await p.text({
			message: variable.label,
			placeholder: variable.placeholder,
			initialValue: variable.default
		});
		if (p.isCancel(value)) {
			p.cancel('Operation cancelled.');
			process.exit(0);
		}
		values[variable.key] = (value ?? '').trim();
	}

	return values;
}

/** The declared env keys that ended up blank, for the next-steps note. */
export function missingEnvKeys(provider: Provider, values: Record<string, string>): string[] {
	return (provider.env ?? [])
		.filter((variable) => !(values[variable.key] ?? '').trim() && !variable.default)
		.map((variable) => variable.key);
}
