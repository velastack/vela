import fs from 'node:fs';

export interface MergeOutcome {
	applied: boolean;
	reason: string;
	snippet?: string;
}

const RUNES_SNIPPET = `\tcompilerOptions: {
\t\trunes: ({ filename }) => (filename.split(/[/\\\\]/).includes('node_modules') ? undefined : true)
\t},\n`;

const TAILWIND_IMPORT = `import tailwindcss from '@tailwindcss/vite';`;

export function mergeSvelteConfig(filePath: string): MergeOutcome {
	if (!fs.existsSync(filePath)) {
		return {
			applied: false,
			reason: 'svelte.config.js not found',
			snippet: RUNES_SNIPPET
		};
	}

	const original = fs.readFileSync(filePath, 'utf8');
	if (/runes\s*:/m.test(original)) {
		return { applied: false, reason: 'runes already configured' };
	}
	if (/compilerOptions\s*:/m.test(original)) {
		return {
			applied: false,
			reason: 'compilerOptions already present — add `runes` manually',
			snippet: `runes: ({ filename }) => (filename.split(/[/\\\\]/).includes('node_modules') ? undefined : true)`
		};
	}

	const anchor = original.match(/^(const\s+config\s*=\s*\{)\s*\n/m);
	if (!anchor || anchor.index === undefined) {
		return {
			applied: false,
			reason: 'svelte.config.js has a non-standard shape',
			snippet: RUNES_SNIPPET
		};
	}

	const insertAt = anchor.index + anchor[0].length;
	const updated = original.slice(0, insertAt) + RUNES_SNIPPET + original.slice(insertAt);
	fs.writeFileSync(filePath, updated);
	return { applied: true, reason: 'added runes compilerOption' };
}

export function mergeViteConfig(filePath: string): MergeOutcome {
	if (!fs.existsSync(filePath)) {
		return {
			applied: false,
			reason: 'vite.config.ts not found',
			snippet: `${TAILWIND_IMPORT}\n// then add tailwindcss() to the plugins array`
		};
	}

	const original = fs.readFileSync(filePath, 'utf8');
	if (original.includes('@tailwindcss/vite')) {
		return { applied: false, reason: 'tailwindcss plugin already present' };
	}

	const pluginsMatch = original.match(/plugins\s*:\s*\[/);
	if (!pluginsMatch || pluginsMatch.index === undefined) {
		return {
			applied: false,
			reason: 'vite.config.ts has a non-standard shape — no plugins array found',
			snippet: `import tailwindcss from '@tailwindcss/vite';\n// plugins: [tailwindcss(), sveltekit()]`
		};
	}

	const withImport = addImport(original, TAILWIND_IMPORT);

	const newPluginsMatch = withImport.match(/plugins\s*:\s*\[/)!;
	const insertAt = newPluginsMatch.index! + newPluginsMatch[0].length;
	const trailing = withImport.slice(insertAt);
	const prefix = /^\s*\]/.test(trailing) ? 'tailwindcss()' : 'tailwindcss(), ';
	const updated = withImport.slice(0, insertAt) + prefix + withImport.slice(insertAt);

	fs.writeFileSync(filePath, updated);
	return { applied: true, reason: 'added @tailwindcss/vite plugin' };
}

export function mergeTsconfig(filePath: string): MergeOutcome {
	if (!fs.existsSync(filePath)) {
		return { applied: false, reason: 'tsconfig.json not found' };
	}
	const original = fs.readFileSync(filePath, 'utf8');
	if (/rewriteRelativeImportExtensions/.test(original)) {
		return { applied: false, reason: 'rewriteRelativeImportExtensions already set' };
	}

	const match = original.match(/"compilerOptions"\s*:\s*\{/);
	if (!match || match.index === undefined) {
		return {
			applied: false,
			reason: 'tsconfig.json has no compilerOptions block',
			snippet: `"compilerOptions": { "rewriteRelativeImportExtensions": true }`
		};
	}

	const insertAt = match.index + match[0].length;
	const indent = detectIndent(original, insertAt);
	const updated =
		original.slice(0, insertAt) +
		`\n${indent}"rewriteRelativeImportExtensions": true,` +
		original.slice(insertAt);
	fs.writeFileSync(filePath, updated);
	return { applied: true, reason: 'added rewriteRelativeImportExtensions' };
}

const GITIGNORE_ENTRIES = [
	'.env',
	'.env.*',
	'!.env.example',
	'!.env.test',
	'vite.config.js.timestamp-*',
	'vite.config.ts.timestamp-*'
];

export function mergeGitignore(filePath: string): MergeOutcome {
	const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
	const lines = existing.split('\n').map((l) => l.trim());
	const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.includes(entry));
	if (missing.length === 0) {
		return { applied: false, reason: '.gitignore already has vela entries' };
	}

	const needsNewline = existing.length > 0 && !existing.endsWith('\n');
	const appended = `${existing}${needsNewline ? '\n' : ''}${missing.join('\n')}\n`;
	fs.writeFileSync(filePath, appended);
	return { applied: true, reason: `added ${missing.length} gitignore entries` };
}

function addImport(source: string, importLine: string): string {
	if (source.includes(importLine)) return source;
	const importRegex = /^import\s[^\n]+;?\s*$/gm;
	let lastImportEnd = 0;
	let match: RegExpExecArray | null;
	while ((match = importRegex.exec(source)) !== null) {
		lastImportEnd = match.index + match[0].length;
	}
	if (lastImportEnd === 0) {
		return `${importLine}\n${source}`;
	}
	return source.slice(0, lastImportEnd) + `\n${importLine}` + source.slice(lastImportEnd);
}

function detectIndent(source: string, atOffset: number): string {
	const rest = source.slice(atOffset);
	const nextLine = rest.match(/\n([ \t]+)"/);
	return nextLine ? nextLine[1]! : '\t';
}
