import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import * as v from 'valibot';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import { detect, resolveCommand } from 'package-manager-detector';
import { helpConfig } from '../lib/help.ts';
import { runCommand } from '../lib/run.ts';
import { parseOptions } from '../lib/options.ts';
import {
	DEFAULT_TEMPLATE,
	copyTemplate,
	findTemplate,
	listAllTemplates,
	resolveTemplate,
	templateChoicesMessage,
	type TemplateInfo,
	type TemplateListing
} from '../lib/templates.ts';
import {
	AGENT_NAMES,
	getUserAgent,
	installOption,
	installDependencies,
	packageManagerPrompt,
	addPnpmBuildDependencies
} from '../lib/package-manager.ts';
import { createSuperuser, withPocketbase } from '../lib/pocketbase.ts';
import { writeEnvFile } from '../lib/env.ts';
import pkg from '../../package.json' with { type: 'json' };
import { applyTemplateFiles } from '../lib/template-files.ts';
import { reportResult } from '../lib/result-report.ts';
import { readApiKey, requireApiKey } from '../lib/config.ts';
import { isInteractive } from '../lib/providers.ts';
import {
	CMS_URL_RE,
	FREE_CMS_HINT,
	PROJECT_ID_RE,
	cmsEndpointFor,
	decideLink,
	linkNextSteps,
	normalizeCmsUrl,
	type CreateLinkOutcome,
	type LinkDecision,
	type LinkedProject
} from '../lib/link-on-create.ts';
import { linkExistingProject, linkNewProject } from '../lib/link-project.ts';
import { writeProjectConfig } from '../lib/project-config.ts';
import { loginInteractively } from './login.ts';

/**
 * Built per run rather than at module load: the accepted templates come from the
 * templates directory and the registry, so adding one can't leave `--template`
 * behind, and neither is read until a command that needs them actually runs.
 */
export function optionsSchema(listing: TemplateListing) {
	const names = listing.templates.map((template) => template.name);
	let choices = `must be one of: ${templateChoicesMessage(listing.templates)}`;
	if (listing.registryError) {
		choices += ` (could not reach the template registry: ${listing.registryError})`;
	}
	return v.strictObject({
		install: v.union([v.boolean(), v.picklist(AGENT_NAMES)], 'must be a package manager'),
		template: v.optional(v.picklist(names, choices)),
		name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, 'must not be empty'))),
		email: v.optional(v.pipe(v.string(), v.email('must be a valid email address'))),
		password: v.optional(v.pipe(v.string(), v.minLength(8, 'must be at least 8 characters long'))),
		link: v.optional(
			v.pipe(
				v.string(),
				v.check(
					(value) => value === 'new' || value === 'none' || PROJECT_ID_RE.test(value),
					'must be `new`, `none` or a velastack.dev project id'
				)
			)
		),
		team: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, 'must not be empty'))),
		cms: v.optional(
			v.pipe(v.string(), v.trim(), v.regex(CMS_URL_RE, 'must be an absolute CMS URL'))
		)
	});
}
type Options = v.InferOutput<ReturnType<typeof optionsSchema>>;

/**
 * Flags that only make sense for some templates, or in some combinations,
 * checked up front so nothing is downloaded before a bad invocation is refused.
 */
export function checkFlagsForTemplate(template: TemplateInfo, options: Options): void {
	if (!template.backend && (options.email || options.password)) {
		throw new Error(
			`--email and --password don't apply to the ${template.name} template — it has no backend.`
		);
	}
	if (options.cms !== undefined && !template.cms) {
		throw new Error(
			`--cms doesn't apply to the ${template.name} template — it reads no copy from a CMS.`
		);
	}
	if (options.team !== undefined && options.link !== 'new') {
		throw new Error('--team only applies together with --link new.');
	}
}

export const create = new Command('create')
	.description('scaffold a new velastack project')
	.argument('[path]', 'where the project will be created')
	.option('--template <type>', 'template to scaffold (built-in or from the registry)', 'minimal')
	.option('--no-install', 'skip installing dependencies')
	.option('--name <name>', 'app name (used for emails, etc)')
	.option('--email <email>', 'email of the admin user')
	.option('--password <password>', 'password of the admin user')
	.option(
		'--link <new|none|project-id>',
		'link to a velastack.dev project: create one, skip, or use an existing project id (default: create when logged in at a terminal)'
	)
	.option('--team <id>', 'velastack.dev team for `--link new` (default: your personal team)')
	.option(
		'--cms <url>',
		"read from a CMS at this URL instead of the linked project's (CMS-ready templates only)"
	)
	.addOption(installOption)
	.configureHelp(helpConfig)
	.action((projectPath: string | undefined, rawOpts) => {
		return runCommand(async () => {
			const listing = await listAllTemplates();
			const options = parseOptions(optionsSchema(listing), rawOpts);
			const { directory, packageManager, name, template, link } = await createProject(
				projectPath,
				options,
				listing
			);

			const relative = path.relative(process.cwd(), directory);
			const pm =
				packageManager ?? (await detect({ cwd: directory }))?.name ?? getUserAgent() ?? 'npm';

			const nextSteps: string[] = [];
			if (relative !== '') {
				const hasSpaces = relative.includes(' ');
				nextSteps.push(`\`cd ${hasSpaces ? `"${relative}"` : relative}\``);
			}
			if (!packageManager) {
				const resolved = resolveCommand(pm, 'install', []);
				if (resolved) {
					nextSteps.push(
						`\`${resolved.command} ${resolved.args.join(' ')}\` to install dependencies`
					);
				}
			}
			const runDev = resolveCommand(pm, 'run', ['dev', '--open']);
			if (runDev) {
				nextSteps.push(
					`\`${runDev.command} ${runDev.args.join(' ')}\` to start the dev server (Ctrl-C to stop)`
				);
			}
			if (template.nextSteps) {
				nextSteps.push(...template.nextSteps);
			} else if (template.backend) {
				nextSteps.push('Run `vela generate scaffold <model>` to generate your first CRUD pages.');
			} else {
				nextSteps.push(
					'Set your deployed URL in `src/lib/site.ts` before building for production.'
				);
				nextSteps.push('Run `vela ui add <component>` to add UI components.');
			}
			nextSteps.push(...linkNextSteps(link));
			nextSteps.push('Stuck? Visit https://docs.velastack.dev');

			reportResult({
				summary: `Created ${name} at ${directory}.`,
				nextSteps
			});
		}, 'Failed to create project.');
	});

async function createProject(
	cwdArg: string | undefined,
	options: Options,
	listing: TemplateListing
) {
	const onCancel = () => {
		p.cancel('Operation cancelled.');
		process.exit(0);
	};

	const template = findTemplate(listing, options.template ?? DEFAULT_TEMPLATE);
	checkFlagsForTemplate(template, options);

	let directory: string;
	if (cwdArg) {
		directory = path.resolve(cwdArg);
	} else {
		const answer = await p.text({
			message: 'Where would you like your project to be created?',
			placeholder: '  (hit Enter to use current directory)',
			defaultValue: './'
		});
		if (p.isCancel(answer)) onCancel();
		directory = path.resolve(answer as string);
	}

	if (
		fs.existsSync(directory) &&
		fs.readdirSync(directory).filter((f) => !f.startsWith('.git')).length > 0
	) {
		const force = await p.confirm({
			message: 'Directory not empty. Continue?',
			initialValue: false
		});
		if (p.isCancel(force) || !force) onCancel();
	}

	const dirName = path.basename(directory);

	const { name } = await p.group(
		{
			name: () => {
				if (options.name) return Promise.resolve(options.name);
				return p.text({
					message: 'App name (used for emails, etc)',
					initialValue: dirName || 'SvelteKit',
					validate: (value) => (value?.trim() ? undefined : 'App name is required')
				});
			}
		},
		{ onCancel }
	);

	const credentials = template.backend ? await promptCredentials(options, onCancel) : undefined;

	// Before any file is written: a failed copy leaves at most an orphan row on
	// velastack.dev, where a half-written project would be the worse leftover.
	const link = await linkOnCreate(name, template, options, onCancel);

	const projectPath = directory;

	if (template.source === 'remote') p.log.step(`Downloading template ${template.name}...`);
	const resolved = await resolveTemplate(template);
	try {
		copyTemplate(resolved, projectPath);
		applyTemplateFiles(projectPath, {
			appName: name,
			cliVersion: pkg.version,
			cmsEndpoint: link.cmsEndpoint
		});
	} finally {
		resolved.cleanup();
	}
	if (!fs.existsSync(path.join(projectPath, 'package.json'))) {
		throw new Error(`Template ${template.name} is missing package.template.json`);
	}
	if (link.linked) {
		const { projectId, teamId, projectName } = link.linked;
		writeProjectConfig(projectPath, { projectId, teamId, projectName });
	}

	p.log.success('Project created');

	let packageManager: ReturnType<typeof getUserAgent> | undefined;
	if (options.install !== false) {
		const pm =
			typeof options.install === 'string'
				? options.install
				: await packageManagerPrompt(projectPath);

		if (pm) {
			const builds = template.backend ? ['esbuild', 'pocketbase-server'] : ['esbuild'];
			addPnpmBuildDependencies(projectPath, pm, builds);
			await installDependencies(pm, projectPath);
			packageManager = pm;
		}
	}

	if (credentials) {
		const { email, password } = credentials;

		p.log.step('Initializing PocketBase...');
		await createSuperuser(projectPath, email, password);

		await withPocketbase(
			projectPath,
			async (pb) => {
				await pb.settings.update({
					meta: { appName: name, appURL: 'http://localhost:5173' }
				});
			},
			{ email, password }
		);

		writeEnvFile(
			projectPath,
			{
				POCKETBASE_SUPERUSER_EMAIL: email,
				POCKETBASE_SUPERUSER_PASSWORD: password
			},
			['PocketBase superuser credentials — used by `vela` commands']
		);

		p.log.success('PocketBase initialized');
	}

	return { directory: projectPath, packageManager, name, template, link };
}

/**
 * Link the new project to velastack.dev and settle where its CMS is.
 *
 * The decision itself is `decideLink`; this is the part that talks to a
 * terminal and to velastack.dev. A CMS template gets its endpoint from the
 * linked project unless `--cms` named one, and a logged-out user at a terminal
 * is offered the login flow rather than sent away to run it.
 */
async function linkOnCreate(
	name: string,
	template: TemplateInfo,
	options: Options,
	onCancel: () => void
): Promise<CreateLinkOutcome> {
	const templateCms = template.cms === true;
	const interactive = isInteractive();
	const loggedIn = readApiKey() !== null;

	const outcome: CreateLinkOutcome = {
		cmsEndpoint: options.cms ? normalizeCmsUrl(options.cms) : '',
		cmsSource: options.cms ? 'flag' : 'none',
		templateCms,
		loggedIn,
		interactive
	};

	let decision: LinkDecision = decideLink({
		link: options.link,
		needsCms: templateCms && !options.cms,
		loggedIn,
		interactive
	});

	if (decision.kind === 'prompt-cms') {
		const choice = await promptCms(onCancel);
		if (choice.kind === 'url') {
			outcome.cmsEndpoint = choice.url;
			outcome.cmsSource = 'prompt';
			decision = { kind: 'none' };
		} else {
			decision = { kind: choice.kind === 'login' ? 'login-then-create' : 'none' };
		}
	}

	if (decision.kind === 'error') throw new Error(decision.message);

	let apiKey: string | undefined;
	if (decision.kind === 'login-then-create') {
		apiKey = await loginInteractively();
		outcome.loggedIn = true;
		decision = { kind: 'create' };
	}

	let linked: LinkedProject | undefined;
	if (decision.kind === 'create') {
		p.log.step(
			options.link === 'new'
				? 'Linking to a new velastack.dev project...'
				: 'Linking to a new velastack.dev project (pass `--link none` to skip)...'
		);
		linked = await linkNewProject(apiKey ?? requireApiKey(), {
			name,
			template: template.name,
			teamId: options.team,
			interactive
		});
	} else if (decision.kind === 'existing') {
		p.log.step('Linking to velastack.dev...');
		linked = await linkExistingProject(requireApiKey(), decision.projectId);
	} else if (decision.kind === 'none' && decision.warn) {
		p.log.warn(decision.warn);
	}

	if (linked) {
		outcome.linked = linked;
		p.log.success(`Linked to ${linked.projectName} (${linked.dashboardUrl})`);
		if (templateCms && !outcome.cmsEndpoint) {
			outcome.cmsEndpoint = cmsEndpointFor(linked.projectId);
			outcome.cmsSource = 'linked';
			p.log.success(`CMS: ${outcome.cmsEndpoint}`);
		}
	}

	return outcome;
}

type CmsPromptChoice = { kind: 'login' } | { kind: 'url'; url: string } | { kind: 'skip' };

async function promptCms(onCancel: () => void): Promise<CmsPromptChoice> {
	p.note(`This template reads its copy from a hosted CMS.\n${FREE_CMS_HINT}.`, 'CMS');
	const choice = await p.select({
		message: 'Where should the site read its content from?',
		options: [
			{ value: 'login', label: 'Log in to velastack.dev and create one', hint: 'free' },
			{ value: 'url', label: 'Use an existing CMS URL' },
			{ value: 'skip', label: 'Skip for now', hint: 'the site shows its fallback copy' }
		]
	});
	if (p.isCancel(choice)) onCancel();
	if (choice !== 'url') return { kind: choice as 'login' | 'skip' };

	const url = await p.text({
		message: 'CMS URL',
		placeholder: 'https://velastack.dev/v1/projects/<project>/cms',
		validate: (value) =>
			CMS_URL_RE.test(value?.trim() ?? '') ? undefined : 'Enter an absolute http(s) URL'
	});
	if (p.isCancel(url)) onCancel();
	return { kind: 'url', url: normalizeCmsUrl(url as string) };
}

function promptCredentials(options: Options, onCancel: () => void) {
	return p.group(
		{
			email: () => {
				if (options.email) return Promise.resolve(options.email);
				return p.text({
					message: 'Enter an email for the admin user',
					initialValue: 'admin@example.com',
					validate: (value) =>
						!value ? 'Email is required' : !value.includes('@') ? 'Invalid email' : undefined
				});
			},
			password: () => {
				if (options.password) return Promise.resolve(options.password);
				return p.password({
					message: 'Enter a password for the admin user (at least 8 characters)',
					validate: (value) =>
						!value
							? 'Password is required'
							: value.length < 8
								? 'Password must be at least 8 characters long'
								: undefined
				});
			}
		},
		{ onCancel }
	);
}
