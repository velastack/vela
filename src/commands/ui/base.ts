import fs from 'node:fs';
import path from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { reportResult } from '../../lib/result-report.ts';
import { templatesDir } from '../../lib/templates.ts';

const VALID_COLORS = ['slate', 'gray', 'zinc', 'stone', 'neutral'] as const;
type BaseColor = (typeof VALID_COLORS)[number];

function findThemeFile(color: BaseColor): string {
	const candidate = path.join(templatesDir(), 'ui', 'css', `${color}.css`);
	if (!fs.existsSync(candidate)) {
		throw new Error(`Theme file not found for color: ${color}`);
	}
	return candidate;
}

function extractSelectors(css: string): { root: string; dark: string } {
	const rootMatch = css.match(/:root\s*{[^}]*}/);
	const darkMatch = css.match(/\.dark\s*{[^}]*}/);
	if (!rootMatch || !darkMatch) {
		throw new Error('Invalid theme file: missing :root or .dark selector');
	}
	return { root: rootMatch[0], dark: darkMatch[0] };
}

function applyTheme(appCss: string, selectors: { root: string; dark: string }): string {
	let out = appCss;
	out = out.match(/:root\s*{[^}]*}/)
		? out.replace(/:root\s*{[^}]*}/, selectors.root)
		: `${selectors.root}\n\n${out}`;
	out = out.match(/\.dark\s*{[^}]*}/)
		? out.replace(/\.dark\s*{[^}]*}/, selectors.dark)
		: `${out}\n\n${selectors.dark}`;
	return out;
}

export const base = new Command('base')
	.description('change the base color')
	.argument('<color>', 'base color to use', (value) => {
		if (!(VALID_COLORS as readonly string[]).includes(value)) {
			throw new InvalidArgumentError(`Valid colors are: ${VALID_COLORS.join(', ')}`);
		}
		return value as BaseColor;
	})
	.configureHelp(helpConfig)
	.action((color: BaseColor) =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();
			const appCssPath = path.join(workspaceRootDir, 'src', 'app.css');
			if (!fs.existsSync(appCssPath)) {
				throw new Error(`Could not find ${path.relative(workspaceRootDir, appCssPath)}`);
			}

			const themeContent = fs.readFileSync(findThemeFile(color), 'utf8');
			const selectors = extractSelectors(themeContent);
			const appCss = fs.readFileSync(appCssPath, 'utf8');
			fs.writeFileSync(appCssPath, applyTheme(appCss, selectors));

			reportResult({
				summary: `Set base color to ${color}.`,
				filesModified: [path.relative(workspaceRootDir, appCssPath)],
				nextSteps: [
					'Run your dev server to preview the new palette.',
					'Tweak individual CSS variables in src/app.css if you want to customize the theme further.'
				]
			});
		}, 'Failed to change base color.')
	);
