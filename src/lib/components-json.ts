import fs from 'node:fs';
import path from 'node:path';

export interface ComponentsJson {
	style?: string;
	iconLibrary?: string;
	tailwind?: { css?: string; baseColor?: string };
	aliases?: Record<string, string>;
}

export function readComponentsJson(root: string): ComponentsJson | undefined {
	const file = path.join(root, 'components.json');
	if (!fs.existsSync(file)) return undefined;
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
		return parsed && typeof parsed === 'object' ? (parsed as ComponentsJson) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * SvelteKit 3 removed `$lib`. shadcn-svelte writes its imports through these
 * aliases, so a components.json still on `$lib` adds components whose imports
 * do not resolve. Read as legacy input; never rewritten here.
 */
function legacyLibAliases(config: ComponentsJson): string[] {
	return Object.entries(config.aliases ?? {})
		.filter(([, value]) => value === '$lib' || value.startsWith('$lib/'))
		.map(([key]) => key);
}

/**
 * Since shadcn-svelte 1.2 the registry is style-scoped and a config without
 * `style` silently resolves to `nova`; vela's templates and components are
 * written against `vega`. These are hints rather than edits: switching the
 * style of a project that already has components would leave it half and half.
 */
export function componentsJsonHints(config: ComponentsJson): string[] {
	const hints: string[] = [];
	if (!config.style) {
		hints.push(
			'components.json has no "style": shadcn-svelte defaults to "nova", while vela ships "vega". Add "style": "vega" so new components match.'
		);
	}
	const legacy = legacyLibAliases(config);
	if (legacy.length > 0) {
		hints.push(
			`components.json aliases ${legacy.map((k) => `"${k}"`).join(', ')} still use $lib, which SvelteKit 3 removed: change "$lib" to "#lib" in each so new components import through the package.json #lib entries.`
		);
	}
	if (!config.iconLibrary) {
		hints.push(
			'components.json has no "iconLibrary": add "iconLibrary": "lucide", the library vela\'s components use.'
		);
	}
	return hints;
}
