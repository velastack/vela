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
	TEMPLATE_MANIFEST,
	findProjectTemplate,
	projectTemplateNames,
	type ProjectTemplate
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
import { applyTemplateFiles, restoreTemplateNames } from '../lib/template-files.ts';
import { reportResult } from '../lib/result-report.ts';

/**
 * Built per run rather than at module load: the accepted templates come from the
 * templates directory, so adding one can't leave `--template` behind, and the
 * directory is only read once a command that needs it actually runs.
 */
function optionsSchema() {
	const templates = projectTemplateNames();
	return v.strictObject({
		install: v.union([v.boolean(), v.picklist(AGENT_NAMES)], 'must be a package manager'),
		template: v.optional(v.picklist(templates, `must be one of: ${templates.join(', ')}`)),
		name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, 'must not be empty'))),
		email: v.optional(v.pipe(v.string(), v.email('must be a valid email address'))),
		password: v.optional(v.pipe(v.string(), v.minLength(8, 'must be at least 8 characters long')))
	});
}
type Options = v.InferOutput<ReturnType<typeof optionsSchema>>;

export const create = new Command('create')
	.description('scaffold a new velastack project')
	.argument('[path]', 'where the project will be created')
	.option('--template <type>', 'template to scaffold', 'minimal')
	.option('--no-install', 'skip installing dependencies')
	.option('--name <name>', 'app name (used for emails, etc)')
	.option('--email <email>', 'email of the admin user')
	.option('--password <password>', 'password of the admin user')
	.addOption(installOption)
	.configureHelp(helpConfig)
	.action((projectPath: string | undefined, rawOpts) => {
		return runCommand(async () => {
			const options = parseOptions(optionsSchema(), rawOpts);
			const { directory, packageManager, name, template } = await createProject(
				projectPath,
				options
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
			if (template.backend) {
				nextSteps.push('Run `vela generate scaffold <model>` to generate your first CRUD pages.');
			} else {
				nextSteps.push(
					'Set your deployed URL in `src/lib/site.ts` before building for production.'
				);
				nextSteps.push('Run `vela ui add <component>` to add UI components.');
			}
			nextSteps.push('Stuck? Visit https://docs.velastack.dev');

			reportResult({
				summary: `Created ${name} at ${directory}.`,
				nextSteps
			});
		}, 'Failed to create project.');
	});

async function createProject(cwdArg: string | undefined, options: Options) {
	const onCancel = () => {
		p.cancel('Operation cancelled.');
		process.exit(0);
	};

	const template = findProjectTemplate(options.template ?? DEFAULT_TEMPLATE);
	if (!template.backend && (options.email || options.password)) {
		throw new Error(
			`--email and --password don't apply to the ${template.name} template — it has no backend.`
		);
	}

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

	const projectPath = directory;

	copyTemplate(template, projectPath);
	applyTemplateFiles(projectPath, { appName: name, cliVersion: pkg.version });
	if (!fs.existsSync(path.join(projectPath, 'package.json'))) {
		throw new Error(`Template ${template.name} is missing package.template.json`);
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

	return { directory: projectPath, packageManager, name, template };
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

function copyTemplate(template: ProjectTemplate, target: string): void {
	fs.mkdirSync(target, { recursive: true });
	fs.cpSync(template.dir, target, {
		recursive: true,
		// The manifest describes the template to the CLI; it isn't part of the project.
		filter: (src) =>
			path.basename(src) !== '.DS_Store' && path.relative(template.dir, src) !== TEMPLATE_MANIFEST
	});
	restoreTemplateNames(target);
}
