import {
	blockingFeatures,
	bySlug,
	unmetRequirements,
	type DetectedProviders,
	type FeatureFlag,
	type Pattern,
	type Slug,
	type Unmet
} from '@velastack/patterns';
import { detectWorkspace, type Features } from './workspace.ts';

/** The command that turns a feature on, for a refusal to point at. */
const ENABLE_COMMAND: Partial<Record<keyof Features, string>> = {
	auth: 'vela enable auth',
	api: 'vela enable api',
	apiKeys: 'vela enable api-keys',
	backend: 'vela enable backend',
	i18n: 'vela enable i18n',
	teams: 'vela enable teams',
	payments: 'vela enable payments',
	blog: 'vela enable blog',
	contentNegotiation: 'vela enable content-negotiation',
	cms: 'vela enable cms',
	workflows: 'vela enable workflows',
	ecommerce: 'vela enable ecommerce'
};

/** The command that turns a feature off, for a blocked disable to point at. */
const DISABLE_COMMAND: Partial<Record<FeatureFlag, string>> = {
	auth: 'vela disable auth',
	api: 'vela disable api',
	apiKeys: 'vela disable api-keys',
	backend: 'vela disable backend',
	i18n: 'vela disable i18n',
	teams: 'vela disable teams',
	payments: 'vela disable payments',
	blog: 'vela disable blog',
	contentNegotiation: 'vela disable content-negotiation',
	cms: 'vela disable cms',
	ecommerce: 'vela disable ecommerce'
};

const FEATURE_NAME: Partial<Record<keyof Features, string>> = {
	apiKeys: 'API keys',
	api: 'the API',
	contentNegotiation: 'content negotiation',
	i18n: 'i18n',
	workflows: 'the workflow runtime'
};

/** `Stripe` for `stripe` payments, from the capability's own pattern. */
function providerLabel(capability: string, id: string): string {
	const pattern = (bySlug as Record<string, Pattern | undefined>)[`enable-${capability}`];
	return pattern?.providers?.find((provider) => provider.id === id)?.label ?? id;
}

function labels(capability: string, ids: string[]): string {
	return ids.map((id) => providerLabel(capability, id)).join(' or ');
}

/**
 * The refusal for a pattern whose prerequisites are missing, in the shape of
 * `assertShadcn`: what is needed, that nothing changed, and what to run.
 */
export function unmetMessage(command: string, unmet: Unmet[]): string {
	const needs: string[] = [];
	const steps: string[] = [];
	const notes: string[] = [];

	for (const entry of unmet) {
		if (entry.kind === 'feature') {
			needs.push(FEATURE_NAME[entry.feature] ?? entry.feature);
			const enable = ENABLE_COMMAND[entry.feature];
			if (enable) steps.push(enable);
		} else if (entry.kind === 'provider') {
			const want = `${labels(entry.capability, entry.want)} ${entry.capability}`;
			needs.push(want);
			if (entry.have === null) {
				steps.push(`vela enable ${entry.capability} --provider ${entry.want[0]}`);
			} else {
				notes.push(
					`This project uses ${providerLabel(entry.capability, entry.have)} ${entry.capability}. ` +
						`Switching means \`vela disable ${entry.capability}\`, then ` +
						`\`vela enable ${entry.capability} --provider ${entry.want[0]}\`.`
				);
			}
		} else {
			needs.push(`one ${entry.capability} provider`);
			notes.push(
				`This project has the settings of ${labels(entry.capability, entry.ids)} ${entry.capability} ` +
					'(their variables are declared in src/env.ts), so which one it uses is unclear. ' +
					"Remove the one you don't use."
			);
		}
	}

	const them = needs.length > 1 ? 'them' : 'it';
	const body =
		steps.length > 0
			? [
					'Nothing was changed. To set it up:',
					...steps.map((step, i) => `  ${i + 1}. ${step}`),
					'Then run this again.'
				]
			: ['Nothing was changed.'];
	return [
		`\`${command}\` needs ${needs.join(', ')}, and this project does not have ${them}.`,
		'',
		...body,
		...(notes.length > 0 ? ['', ...notes] : [])
	].join('\n');
}

/**
 * The refusal for a pattern that would strand code still depending on what it
 * removes: which features stand in the way, and the disables to run first.
 */
export function blockedMessage(command: string, blocking: FeatureFlag[]): string {
	const names = blocking.map((feature) => FEATURE_NAME[feature] ?? feature);
	const steps = blocking.flatMap((feature) => DISABLE_COMMAND[feature] ?? []);
	const they = blocking.length > 1 ? 'they depend' : 'it depends';
	return [
		`\`${command}\` can't run while this project has ${names.join(', ')}: ${they} on what it removes.`,
		'',
		'Nothing was changed. To take it out first:',
		...steps.map((step, i) => `  ${i + 1}. ${step}`),
		'Then run this again.'
	].join('\n');
}

/** Throws the refusal when `pattern` can't run on this project. */
export function assertRequires(
	command: string,
	pattern: Pick<Pattern, 'requires' | 'providers' | 'inheritsProvider' | 'blockedBy'>,
	context: { features: Features; detected: DetectedProviders; provider?: string }
): void {
	const unmet = unmetRequirements(pattern, context);
	if (unmet.length > 0) throw new Error(unmetMessage(command, unmet));
	const blocking = blockingFeatures(pattern, context.features);
	if (blocking.length > 0) throw new Error(blockedMessage(command, blocking));
}

/**
 * The same check, for a command to run before it prompts for anything: a
 * refusal after typing a secret key is worse than one before.
 */
export async function assertPatternRequires(slug: Slug, provider?: string): Promise<void> {
	const pattern: Pattern = bySlug[slug];
	const { features, detected } = await detectWorkspace();
	assertRequires(`vela ${pattern.command.base.replace(/^vela /, '')}`, pattern, {
		features,
		detected,
		provider
	});
}
