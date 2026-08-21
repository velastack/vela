import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import { detect, resolveCommand } from 'package-manager-detector';
import { helpConfig } from '../lib/help.ts';
import { runCommand } from '../lib/run.ts';
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
import { restoreTemplateNames } from '../lib/template-files.ts';
import { reportResult } from '../lib/result-report.ts';

const OptionsSchema = v.strictObject({
	install: v.union([v.boolean(), v.picklist(AGENT_NAMES)]),
	template: v.optional(v.picklist(['minimal'])),
	name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
	email: v.optional(v.pipe(v.string(), v.email())),
	password: v.optional(v.pipe(v.string(), v.minLength(8)))
});
type Options = v.InferOutput<typeof OptionsSchema>;

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
		const options = v.parse(OptionsSchema, rawOpts);
		return runCommand(async () => {
			const { directory, packageManager, name } = await createProject(projectPath, options);

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
			nextSteps.push('Run `vela generate scaffold <model>` to generate your first CRUD pages.');
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

	const { name, email, password } = await p.group(
		{
			name: () => {
				if (options.name) return Promise.resolve(options.name);
				return p.text({
					message: 'App name (used for emails, etc)',
					initialValue: dirName || 'SvelteKit',
					validate: (value) => (value?.trim() ? undefined : 'App name is required')
				});
			},
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

	const projectPath = directory;
	const template = options.template ?? 'minimal';

	copyTemplate(template, projectPath);
	writePackageJson(projectPath, name);

	p.log.success('Project created');

	let packageManager: ReturnType<typeof getUserAgent> | undefined;
	if (options.install !== false) {
		const pm =
			typeof options.install === 'string'
				? options.install
				: await packageManagerPrompt(projectPath);

		if (pm) {
			addPnpmBuildDependencies(projectPath, pm, ['esbuild', 'pocketbase-server']);
			await installDependencies(pm, projectPath);
			packageManager = pm;
		}
	}

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

	return { directory: projectPath, packageManager, name };
}

function copyTemplate(template: string, target: string): void {
	const source = findTemplateDir(template);
	fs.mkdirSync(target, { recursive: true });
	fs.cpSync(source, target, {
		recursive: true,
		filter: (src) => path.basename(src) !== '.DS_Store'
	});
	restoreTemplateNames(target);
}

function writePackageJson(target: string, name: string): void {
	const templatePath = path.join(target, 'package.template.json');
	if (!fs.existsSync(templatePath)) {
		throw new Error('Template is missing package.template.json');
	}
	const raw = fs.readFileSync(templatePath, 'utf8');
	const replaced = raw.replace(/~TODO~/g, toValidPackageName(name));
	fs.writeFileSync(path.join(target, 'package.json'), replaced);
	fs.unlinkSync(templatePath);
}

function toValidPackageName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/^[._]/, '')
		.replace(/[^a-z0-9~.-]+/g, '-');
}

function findTemplateDir(template: string): string {
	let dir = path.dirname(fileURLToPath(import.meta.url));
	const { root } = path.parse(dir);
	while (dir !== root) {
		const candidate = path.join(dir, 'templates', template);
		if (fs.existsSync(candidate)) return candidate;
		dir = path.dirname(dir);
	}
	throw new Error(`Template not found: ${template}`);
}
