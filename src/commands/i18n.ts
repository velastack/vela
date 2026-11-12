import process from 'node:process';
import * as p from '@clack/prompts';
import { Command } from 'commander';
import { x } from 'tinyexec';
import { detect } from 'package-manager-detector';
import { resolveCommand } from 'package-manager-detector/commands';
import { helpConfig } from '../lib/help.ts';
import {
	describeOutcome,
	findWuchaleConfig,
	loadUrlPatternPlan,
	promptUrlPatterns,
	writeUrlPatterns
} from '../lib/i18n-routes.ts';
import { isInteractive } from '../lib/providers.ts';
import { runCommand } from '../lib/run.ts';
import { findWorkspaceRoot } from '../lib/workspace.ts';

async function runWuchale(extraArgs: string[]): Promise<void> {
	// wuchale resolves its config against its cwd. Running it from the project
	// root keeps a subdirectory from looking like a project without i18n.
	const cwd = findWorkspaceRoot() ?? process.cwd();
	if (!findWuchaleConfig(cwd)) {
		throw new Error('No wuchale config found. Run `vela enable i18n` to set up i18n.');
	}
	const pm = (await detect({ cwd }))?.name ?? 'npm';
	const resolved = resolveCommand(pm, 'execute', ['wuchale', ...extraArgs])!;
	const args = resolved.args.slice();
	if (pm === 'npm') args.unshift('--yes');
	await x(resolved.command, args, {
		nodeOptions: { cwd, stdio: 'inherit' },
		throwOnError: true
	});
}

const extract = new Command('extract')
	.description('extract translatable strings')
	.configureHelp(helpConfig)
	.action(() => runCommand(() => runWuchale([])));

const watch = new Command('watch')
	.description('watch and extract translatable strings')
	.configureHelp(helpConfig)
	.action(() => runCommand(() => runWuchale(['--watch'])));

const status = new Command('status')
	.description('show i18n status')
	.configureHelp(helpConfig)
	.action(() => runCommand(() => runWuchale(['status'])));

const clean = new Command('clean')
	.description('clean unused translatable strings')
	.configureHelp(helpConfig)
	.action(() => runCommand(() => runWuchale(['--clean'])));

/**
 * Choose the pages that exist in every locale. wuchale localizes a link, and
 * the `reroute` hook strips a locale prefix, only for a path `url.patterns`
 * matches; a page left out is linked in the default language and is a 404
 * under `/es/...`.
 */
async function chooseRoutes(options: { all?: boolean }): Promise<void> {
	const cwd = findWorkspaceRoot() ?? process.cwd();
	const loaded = loadUrlPatternPlan(cwd);
	if ('error' in loaded) throw new Error(loaded.error);
	const { configPath, plan } = loaded;

	if (plan.covered.length > 0) {
		p.log.info(
			`Already matched by a broader pattern:\n${plan.covered.map(({ url, by }) => `- ${url} (${by})`).join('\n')}`
		);
	}
	if (plan.unsupported.length > 0) {
		p.log.warn(
			`A pattern cannot match a literal \`*\` or \`?\`, so these are left out:\n${plan.unsupported.map((url) => `- ${url}`).join('\n')}`
		);
	}
	if (plan.choices.length === 0) {
		p.log.info('No pages to add: every page is already matched by `url.patterns`.');
		return;
	}

	let selected: string[];
	if (options.all) {
		// Everything but a pattern that would also catch static files; a page
		// that needs one is added by hand, or checked in the prompt.
		const broad = plan.choices.filter((choice) => choice.broad && !choice.listed);
		if (broad.length > 0) {
			p.log.warn(
				`Left out, as a pattern this broad also matches files in static/, which would then 404 under a locale:\n${broad.map((choice) => `- ${choice.pattern} (${choice.urls.join(', ')})`).join('\n')}`
			);
		}
		selected = plan.choices
			.filter((choice) => choice.listed || !choice.broad)
			.map((choice) => choice.pattern);
	} else if (!isInteractive()) {
		throw new Error(
			'There is no terminal to ask on. Pass `--all` to give every page a URL in every language.'
		);
	} else {
		const answer = await promptUrlPatterns(plan);
		if (answer === null) {
			p.cancel('Operation cancelled.');
			return;
		}
		selected = answer;
	}

	const outcome = writeUrlPatterns(configPath, plan, selected);
	if (outcome.status === 'failed') throw new Error(outcome.hint);
	if (outcome.status === 'unchanged') {
		p.log.info('`url.patterns` already lists these pages.');
		return;
	}
	p.log.success(describeOutcome(configPath, outcome));
	// The patterns are compiled into src/locales; without this the new ones
	// take effect only the next time the dev server starts.
	await runWuchale([]);
}

const routes = new Command('routes')
	.description('choose which pages have a URL in every language')
	.option('--all', 'add every page without asking')
	.configureHelp(helpConfig)
	.action((options: { all?: boolean }) => runCommand(() => chooseRoutes(options)));

export const i18n = new Command('i18n')
	.description('i18n utilities')
	.configureHelp(helpConfig)
	.addCommand(extract, { isDefault: true })
	.addCommand(watch)
	.addCommand(status)
	.addCommand(clean)
	.addCommand(routes);
