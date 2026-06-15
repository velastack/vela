import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { resolveCommand } from 'package-manager-detector';
import { helpConfig } from '../lib/help.ts';
import { runCommand } from '../lib/run.ts';
import {
	AGENT_NAMES,
	addPnpmBuildDependencies,
	getUserAgent,
	installDependencies,
	installOption,
	packageManagerPrompt
} from '../lib/package-manager.ts';
import { createSuperuser } from '../lib/pocketbase.ts';
import { writeEnvFile } from '../lib/env.ts';
import {
	mergePackageJson,
	readPackageJson,
	readTemplatePackageJson,
	writePackageJson
} from '../lib/package-json.ts';
import {
	mergeGitignore,
	mergeSvelteConfig,
	mergeTsconfig,
	mergeViteConfig
} from '../lib/config-merge.ts';
import { isVanillaRoutes } from '../lib/scaffold-detect.ts';
import { getWorkspace } from '../lib/workspace.ts';
import { reportResult } from '../lib/result-report.ts';

const OptionsSchema = v.strictObject({
	install: v.union([v.boolean(), v.picklist(AGENT_NAMES)]),
	template: v.optional(v.picklist(['minimal'])),
	email: v.optional(v.pipe(v.string(), v.email())),
	password: v.optional(v.pipe(v.string(), v.minLength(8))),
	skipRoutes: v.optional(v.boolean()),
	forceRoutes: v.optional(v.boolean())
});
type Options = v.InferOutput<typeof OptionsSchema>;

const VELA_ONLY_FILES = [
	'src/hooks.server.ts',
	'src/app.css',
	'src/lib/index.ts',
	'src/lib/utils.ts',
	'components.json',
	'.npmrc',
	'.ignore'
];
const VELA_ONLY_DIRS = ['src/lib/components', 'data', 'test', 'static'];

export const bless = new Command('bless')
	.description('upgrade a vanilla SvelteKit project into a VelaStack project')
	.argument('[path]', 'path to the existing SvelteKit project')
	.option('--template <type>', 'template to scaffold from', 'minimal')
	.option('--email <email>', 'email of the admin user')
	.option('--password <password>', 'password of the admin user')
	.option('--no-install', 'skip installing dependencies')
	.addOption(installOption)
	.option('--skip-routes', 'preserve src/routes even if it looks untouched')
	.option('--force-routes', 'replace src/routes with the vela template without detection')
	.configureHelp(helpConfig)
	.action((projectPath: string | undefined, rawOpts) => {
		const options = v.parse(OptionsSchema, rawOpts);
		if (options.skipRoutes && options.forceRoutes) {
			throw new Error('--skip-routes and --force-routes are mutually exclusive');
		}
		return runCommand(async () => {
			await blessProject(projectPath, options);
		}, 'Failed to bless project.');
	});

async function blessProject(cwdArg: string | undefined, options: Options) {
	const projectPath = cwdArg ? resolveProjectPath(cwdArg) : (await getWorkspace()).workspaceRootDir;

	assertNotAlreadyBlessed(projectPath);

	const templateDir = findTemplateDir(options.template ?? 'minimal');

	const { email, password } = await p.group(
		{
			email: () => {
				if (options.email) return Promise.resolve(options.email);
				return p.text({
					message: 'Enter an email for the admin user',
					defaultValue: 'admin@example.com',
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
		{
			onCancel: () => {
				p.cancel('Operation cancelled.');
				process.exit(0);
			}
		}
	);

	mergeDependencies(projectPath, templateDir);
	copyVelaOnlyFiles(templateDir, projectPath);
	mergeConfigFiles(projectPath);
	mergeAppDts(templateDir, projectPath);
	maybeReplaceRoutes(projectPath, templateDir, options);

	p.log.success('Vela files in place');

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

	writeEnvFile(
		projectPath,
		{
			POCKETBASE_SUPERUSER_EMAIL: email,
			POCKETBASE_SUPERUSER_PASSWORD: password
		},
		['PocketBase superuser credentials — used by `vela` commands']
	);

	p.log.success('PocketBase initialized');

	printNextSteps(projectPath, packageManager);
}

function resolveProjectPath(cwdArg: string): string {
	const projectPath = path.resolve(cwdArg);
	if (!fs.existsSync(projectPath)) {
		throw new Error(`Path does not exist: ${projectPath}`);
	}
	if (!fs.existsSync(path.join(projectPath, 'package.json'))) {
		throw new Error(`No package.json found at ${projectPath}`);
	}
	if (!fs.existsSync(path.join(projectPath, 'src', 'routes'))) {
		throw new Error(`No src/routes directory found at ${projectPath}`);
	}
	return projectPath;
}

function assertNotAlreadyBlessed(projectPath: string) {
	const hooksPath = path.join(projectPath, 'src', 'hooks.server.ts');
	if (!fs.existsSync(hooksPath)) return;
	const content = fs.readFileSync(hooksPath, 'utf8');
	if (content.includes('@velastack/pocketbase')) {
		throw new Error(
			'This project already looks blessed (src/hooks.server.ts imports @velastack/pocketbase). Run `vela sync` instead.'
		);
	}
}

function mergeDependencies(projectPath: string, templateDir: string) {
	const userPkgPath = path.join(projectPath, 'package.json');
	const templatePkgPath = path.join(templateDir, 'package.template.json');

	const userPkg = readPackageJson(userPkgPath);
	const appName = typeof userPkg.name === 'string' ? userPkg.name : 'sveltekit';
	const templatePkg = readTemplatePackageJson(templatePkgPath, appName);

	const { merged, added, conflicts, replaced } = mergePackageJson(userPkg, templatePkg);
	writePackageJson(userPkgPath, merged);

	if (added.length > 0) {
		p.log.info(
			`Added ${added.length} entries to package.json (${summarize(added.map((c) => c.name))}).`
		);
	}
	if (replaced.length > 0) {
		const lines = replaced.map(
			(c) =>
				`  script ${pc.bold(c.name)}: ${pc.gray(c.userValue ?? '')} → ${pc.cyan(c.templateValue)}`
		);
		p.log.info(`Updated ${replaced.length} script(s):\n${lines.join('\n')}`);
	}
	if (conflicts.length > 0) {
		const lines = conflicts.map(
			(c) =>
				`  dep ${pc.bold(c.name)}: kept ${pc.cyan(c.userValue ?? '')} (template wants ${pc.gray(c.templateValue)})`
		);
		p.log.warn(`Kept ${conflicts.length} dependency version(s) on conflict:\n${lines.join('\n')}`);
	}
}

function copyVelaOnlyFiles(templateDir: string, projectPath: string) {
	for (const rel of VELA_ONLY_FILES) {
		const src = path.join(templateDir, rel);
		const dest = path.join(projectPath, rel);
		if (!fs.existsSync(src)) continue;
		if (fs.existsSync(dest)) continue;
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.copyFileSync(src, dest);
	}

	for (const rel of VELA_ONLY_DIRS) {
		const src = path.join(templateDir, rel);
		const dest = path.join(projectPath, rel);
		if (!fs.existsSync(src)) continue;
		copyDirShallow(src, dest);
	}
}

function copyDirShallow(src: string, dest: string) {
	fs.mkdirSync(dest, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		if (entry.name === '.DS_Store') continue;
		const srcChild = path.join(src, entry.name);
		const destChild = path.join(dest, entry.name);
		if (entry.isDirectory()) {
			copyDirShallow(srcChild, destChild);
		} else if (entry.isFile() && !fs.existsSync(destChild)) {
			fs.copyFileSync(srcChild, destChild);
		}
	}
}

function mergeConfigFiles(projectPath: string) {
	const runes = mergeSvelteConfig(projectPath);
	const outcomes = [
		[runes.file ?? 'svelte.config', runes],
		['vite.config.ts', mergeViteConfig(path.join(projectPath, 'vite.config.ts'))],
		['tsconfig.json', mergeTsconfig(path.join(projectPath, 'tsconfig.json'))],
		['.gitignore', mergeGitignore(path.join(projectPath, '.gitignore'))]
	] as const;

	for (const [name, outcome] of outcomes) {
		if (outcome.applied) {
			p.log.info(`${name}: ${outcome.reason}`);
			continue;
		}
		if (outcome.snippet) {
			p.log.warn(
				`${name}: ${outcome.reason}\n${pc.gray('Add this manually:')}\n${pc.cyan(outcome.snippet)}`
			);
		}
	}
}

function mergeAppDts(templateDir: string, projectPath: string) {
	const dest = path.join(projectPath, 'src', 'app.d.ts');
	const templateFile = path.join(templateDir, 'src', 'app.d.ts');
	if (!fs.existsSync(dest)) {
		if (!fs.existsSync(templateFile)) return;
		fs.copyFileSync(templateFile, dest);
		return;
	}
	const current = fs.readFileSync(dest, 'utf8');
	if (current.includes('namespace Superforms')) return;
	const block = `\tnamespace Superforms {\n\t\ttype Message = {\n\t\t\ttype: 'error' | 'success';\n\t\t\ttext: string;\n\t\t};\n\t}\n`;
	const match = current.match(/declare global\s*\{\s*\n/);
	if (!match || match.index === undefined) {
		p.log.warn(
			`src/app.d.ts: non-standard shape — add this namespace manually:\n${pc.cyan(block)}`
		);
		return;
	}
	const insertAt = match.index + match[0].length;
	const updated = current.slice(0, insertAt) + block + current.slice(insertAt);
	fs.writeFileSync(dest, updated);
}

function maybeReplaceRoutes(projectPath: string, templateDir: string, options: Options) {
	if (options.skipRoutes) {
		p.log.info('Skipping src/routes (--skip-routes).');
		return;
	}

	if (!options.forceRoutes && !isVanillaRoutes(projectPath)) {
		p.log.info('Leaving src/routes alone (looks customized).');
		return;
	}

	const target = path.join(projectPath, 'src', 'routes');
	fs.rmSync(target, { recursive: true, force: true });
	const src = path.join(templateDir, 'src', 'routes');
	fs.cpSync(src, target, {
		recursive: true,
		filter: (s) => path.basename(s) !== '.DS_Store'
	});
	p.log.success('Replaced src/routes with the vela template.');
}

function summarize(names: string[]): string {
	if (names.length <= 4) return names.join(', ');
	return `${names.slice(0, 3).join(', ')}, and ${names.length - 3} more`;
}

function printNextSteps(projectPath: string, packageManager: ReturnType<typeof getUserAgent>) {
	const relative = path.relative(process.cwd(), projectPath);
	const pm = packageManager ?? getUserAgent() ?? 'npm';

	const nextSteps: string[] = [];
	if (relative !== '') {
		const hasSpaces = relative.includes(' ');
		nextSteps.push(`\`cd ${hasSpaces ? `"${relative}"` : relative}\``);
	}
	const runDev = resolveCommand(pm, 'run', ['dev', '--open']);
	if (runDev) {
		nextSteps.push(
			`\`${runDev.command} ${runDev.args.join(' ')}\` to start the dev server (Ctrl-C to stop)`
		);
	}
	nextSteps.push(
		'Run `vela enable auth` to layer on sign-in flows, or `vela generate scaffold <model>` to scaffold a CRUD page.'
	);
	nextSteps.push('Stuck? Visit https://docs.velastack.dev');

	reportResult({
		summary: `Blessed project at ${projectPath}.`,
		nextSteps
	});
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
