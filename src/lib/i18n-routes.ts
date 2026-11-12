import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import { APP_DIR } from './constants.ts';
import {
	coveringPattern,
	readUrlPatterns,
	routeIdToPattern,
	urlPatternsHint,
	withUrlPatterns
} from './i18n-url-patterns.ts';
import { listRoutes, type Route } from './routes.ts';

/** The names wuchale tries when no `--config` is given. */
const WUCHALE_CONFIG_NAMES = ['js', 'mjs', 'ts', 'mts'].map((ext) => `wuchale.config.${ext}`);

/** The project's wuchale config, or null when it has none. */
export function findWuchaleConfig(root: string): string | null {
	for (const name of WUCHALE_CONFIG_NAMES) {
		const file = path.join(root, name);
		if (fs.existsSync(file)) return file;
	}
	return null;
}

export interface PatternChoice {
	/** The entry for `url.patterns`: `/blog/*`. */
	pattern: string;
	/** The pages it stands for, as their URLs: `/blog/[slug]`. */
	urls: string[];
	/** Already in `url.patterns`. */
	listed: boolean;
	/** Every page behind it is a sign-in page or in the signed-in part of the app. */
	app: boolean;
	/**
	 * Starts with a wildcard (`/*`, `/**`), so it matches far more than its
	 * page: wuchale would also put a locale in front of `asset("/logo.png")`
	 * and of links to files in `static/`, which then 404.
	 */
	broad: boolean;
}

/** The group the auth patterns put the sign-in and sign-up pages in. */
const AUTH_DIR = '(auth)';

/** Whether the choice starts checked: listed already, or a public page with a pattern of its own. */
export const startsChecked = (choice: PatternChoice) =>
	choice.listed || (!choice.app && !choice.broad);

export interface UrlPatternPlan {
	/** One choice per pattern a page of the project needs. */
	choices: PatternChoice[];
	/** Pages a broader pattern in the config already matches. */
	covered: Array<{ url: string; by: string }>;
	/** Pages whose path has a literal `*` or `?`, which a pattern cannot say. */
	unsupported: string[];
}

/**
 * What `url.patterns` could list, from the pages the project has and the
 * patterns its config (`current`) lists now.
 */
export function planUrlPatterns(routes: Route[], current: string[]): UrlPatternPlan {
	const plan: UrlPatternPlan = { choices: [], covered: [], unsupported: [] };
	const byPattern = new Map<string, PatternChoice>();
	const inApp = (id: string) =>
		id.split('/').some((segment) => segment === APP_DIR || segment === AUTH_DIR);

	for (const route of routes) {
		if (!route.page) continue;
		const pattern = routeIdToPattern(route.id);
		if (pattern === null) {
			plan.unsupported.push(route.urlPattern);
			continue;
		}
		const listed = current.includes(pattern);
		const by = listed ? undefined : coveringPattern(pattern, current);
		if (by !== undefined) {
			plan.covered.push({ url: route.urlPattern, by });
			continue;
		}
		const choice = byPattern.get(pattern);
		if (choice) {
			if (!choice.urls.includes(route.urlPattern)) choice.urls.push(route.urlPattern);
			choice.app &&= inApp(route.id);
		} else {
			const added = {
				pattern,
				urls: [route.urlPattern],
				listed,
				app: inApp(route.id),
				broad: /^\/\*/.test(pattern)
			};
			byPattern.set(pattern, added);
			plan.choices.push(added);
		}
	}
	return plan;
}

export type UrlPatternOutcome =
	| { status: 'written'; added: string[]; removed: string[] }
	| { status: 'unchanged' }
	/** The config has no `url.patterns` array vela can edit; `hint` is what to paste. */
	| { status: 'failed'; hint: string };

/** Make `url.patterns` list `selected` of the plan's choices, leaving every other entry alone. */
export function writeUrlPatterns(
	configPath: string,
	plan: UrlPatternPlan,
	selected: string[]
): UrlPatternOutcome {
	const add = plan.choices
		.filter((choice) => !choice.listed && selected.includes(choice.pattern))
		.map((choice) => choice.pattern);
	const remove = plan.choices
		.filter((choice) => choice.listed && !selected.includes(choice.pattern))
		.map((choice) => choice.pattern);
	if (add.length === 0 && remove.length === 0) return { status: 'unchanged' };

	const result = withUrlPatterns(fs.readFileSync(configPath, 'utf8'), add, remove);
	if (!result) return { status: 'failed', hint: urlPatternsHint(add) };
	if (!result.changed) return { status: 'unchanged' };
	fs.writeFileSync(configPath, result.source);
	return { status: 'written', added: add, removed: remove };
}

/**
 * Ask which pages exist in every locale. Pages already listed start checked,
 * and so do the rest of the public ones. The sign-in pages and the signed-in
 * app start unchecked, as those are the ones most often left in one language,
 * and so does a pattern broad enough to catch static files. Null when the
 * prompt is cancelled.
 */
export async function promptUrlPatterns(plan: UrlPatternPlan): Promise<string[] | null> {
	const selection = await p.multiselect({
		message: 'Which pages get a URL in every language?',
		options: plan.choices.map((choice) => {
			const hints = choice.urls.filter((url) => url !== choice.pattern);
			if (choice.broad) hints.push('also matches static files, which would then 404');
			return {
				value: choice.pattern,
				label: choice.pattern,
				...(hints.length > 0 ? { hint: hints.join('; ') } : {})
			};
		}),
		initialValues: plan.choices.filter(startsChecked).map((choice) => choice.pattern),
		required: false
	});
	return p.isCancel(selection) ? null : selection;
}

/** The plan for the project at `root`, or why there is none. */
export function loadUrlPatternPlan(
	root: string
): { configPath: string; plan: UrlPatternPlan } | { error: string } {
	const configPath = findWuchaleConfig(root);
	if (!configPath) {
		return { error: 'No wuchale config found. Run `vela enable i18n` to set up i18n.' };
	}
	const current = readUrlPatterns(fs.readFileSync(configPath, 'utf8'));
	if (!current) {
		return {
			error: `Could not find a \`url.patterns\` array in ${path.basename(configPath)}. List the pages that exist in every language there, as paths: \`url: { localize: "src/lib/url.ts", patterns: ["/", "/about"] }\`.`
		};
	}
	return { configPath, plan: planUrlPatterns(listRoutes(root), current) };
}

/** One line for what a write changed. */
export function describeOutcome(
	configPath: string,
	outcome: Extract<UrlPatternOutcome, { status: 'written' }>
): string {
	const parts: string[] = [];
	if (outcome.added.length > 0) parts.push(`added ${outcome.added.join(', ')}`);
	if (outcome.removed.length > 0) parts.push(`removed ${outcome.removed.join(', ')}`);
	return `Updated url.patterns in ${path.basename(configPath)}: ${parts.join('; ')}.`;
}
