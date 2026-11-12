import { Project, QuoteKind, SyntaxKind, type ArrayLiteralExpression } from 'ts-morph';
import { detectIndentation, matchIndentation } from './config-target.ts';

/**
 * `url.patterns` in `wuchale.config.js`: the paths that exist in every locale.
 *
 * wuchale localizes a link, and the `reroute` hook strips a locale prefix,
 * only for a path one of these patterns matches. A page that is missing here
 * is linked to in the default language from every locale, and answers 404
 * under `/es/...`.
 *
 * A pattern is a path with wuchale's wildcards: `*` for one segment, `?` for
 * an optional one and `**` for any number.
 */

const isGroup = (segment: string) => /^\([^)]+\)$/.test(segment);

/**
 * The wuchale pattern that matches a SvelteKit route id, or null when the id
 * has a literal `*` or `?` in it, which a pattern cannot say.
 *
 *     /(public)/blog/[slug]    /blog/*
 *     /docs/[...path]          /docs/**
 *     /[[lang]]/about          /?/about
 */
export function routeIdToPattern(id: string): string | null {
	const segments: string[] = [];
	for (const raw of id.split('/')) {
		if (raw === '' || isGroup(raw)) continue;
		if (/^\[\[[^\]]+\]\]$/.test(raw)) {
			segments.push('?');
			continue;
		}
		if (/^\[\.\.\.[^\]]+\]$/.test(raw)) {
			segments.push('**');
			continue;
		}
		// What is left between the brackets is literal text, escapes included.
		let literal = true;
		const segment = raw
			.replace(/\[([ux])\+([0-9a-f]+)\]/g, (_match, type: string, code: string) =>
				type === 'x'
					? String.fromCharCode(parseInt(code, 16))
					: String.fromCodePoint(parseInt(code, 16))
			)
			.split(/(\[[^\]]+\])/)
			.map((part) => {
				if (part.startsWith('[')) return '*';
				if (/[*?]/.test(part)) literal = false;
				return part;
			})
			.join('');
		if (!literal) return null;
		segments.push(segment);
	}
	// wuchale does not match `/` with `/?`, so a route that is only an optional
	// parameter is listed as the root, which is the URL it has without one.
	if (segments.length === 1 && segments[0] === '?') return '/';
	return '/' + segments.join('/');
}

function escapeRegExp(text: string): string {
	return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** A pattern as a regular expression over paths, by wuchale's wildcard rules. */
function patternRegExp(pattern: string): RegExp {
	const trimmed = pattern.length > 1 && pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
	const source = trimmed
		.split(/(\/\*\*|\/\*|\*|\/\?|\?)/)
		.map((part) => {
			if (part === '/**') return '(?:/.*)?';
			if (part === '/*') return '/[^/]+';
			if (part === '*') return '.+';
			if (part === '/?') return '(?:/[^/]+)?';
			if (part === '?') return '[^/]*';
			return escapeRegExp(part);
		})
		.join('');
	return new RegExp(`^${source}/?$`);
}

/** A path the pattern matches, to ask whether another pattern matches it too. */
function samplePath(pattern: string): string {
	const sample = pattern
		.replace(/\/\*\*/g, '/x/y')
		.replace(/\/\?/g, '')
		.replace(/\*/g, 'x')
		.replace(/\?/g, '');
	return sample === '' ? '/' : sample;
}

/** The first of `patterns`, other than `pattern` itself, that already matches what `pattern` does. */
export function coveringPattern(pattern: string, patterns: string[]): string | undefined {
	const sample = samplePath(pattern);
	return patterns.find((other) => other !== pattern && patternRegExp(other).test(sample));
}

function parse(source: string) {
	const project = new Project({
		useInMemoryFileSystem: true,
		skipFileDependencyResolution: true,
		compilerOptions: { allowJs: true },
		manipulationSettings: { quoteKind: QuoteKind.Double }
	});
	const sourceFile = project.createSourceFile('wuchale.config.js', source, { overwrite: true });
	matchIndentation(project, sourceFile);
	return sourceFile;
}

/**
 * The `patterns` array of the `url` option, whether `url` is written inline
 * in the adapter (`url: { ... }`) or hoisted (`const url = { ... }`). The
 * adapter has a `patterns` option of its own, for plurals, which is why the
 * object has to be the one named `url`.
 */
function findPatternsArray(source: string): ArrayLiteralExpression | null {
	const sourceFile = parse(source);
	for (const object of sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
		const parent = object.getParent();
		const named =
			parent?.asKind(SyntaxKind.PropertyAssignment)?.getName() ??
			parent?.asKind(SyntaxKind.VariableDeclaration)?.getName();
		if (named !== 'url') continue;
		const property = object.getProperty('patterns');
		const array = property
			?.asKind(SyntaxKind.PropertyAssignment)
			?.getInitializerIfKind(SyntaxKind.ArrayLiteralExpression);
		if (array) return array;
	}
	return null;
}

/** The whitespace the line holding `position` starts with. */
function lineIndent(text: string, position: number): string {
	const lineStart = text.lastIndexOf('\n', position - 1) + 1;
	return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

/**
 * The source with a one-line `patterns` array holding `texts`, one per line. When the
 * `url` object around it is on one line as well, its properties move onto
 * lines of their own first, so the array does not hang off the end of one.
 */
function expandOntoLines(array: ArrayLiteralExpression, texts: string[]): string {
	const sourceFile = array.getSourceFile();
	const full = sourceFile.getFullText();
	const { useTabs, size } = detectIndentation(sourceFile);
	const unit = useTabs ? '\t' : ' '.repeat(size);
	const comma = /,[ \t]*\n\s*[\]})]/.test(full) ? ',' : '';
	const lines = (items: string[], indent: string, open: string, close: string) =>
		`${open}\n${items.map((item) => `${indent}${unit}${item}`).join(',\n')}${comma}\n${indent}${close}`;

	const object = array
		.getParentOrThrow()
		.getParentIfKindOrThrow(SyntaxKind.ObjectLiteralExpression);
	// Spliced as text: ts-morph would indent the replacement a second time.
	const splice = (node: { getStart(): number; getEnd(): number }, text: string) =>
		full.slice(0, node.getStart()) + text + full.slice(node.getEnd());

	if (object.getText().includes('\n')) {
		return splice(array, lines(texts, lineIndent(full, array.getStart()), '[', ']'));
	}
	const indent = lineIndent(full, object.getStart());
	const properties = object.getProperties().map((property) => {
		const initializer = property.asKind(SyntaxKind.PropertyAssignment)?.getInitializer();
		return initializer === array
			? `patterns: ${lines(texts, indent + unit, '[', ']')}`
			: property.getText();
	});
	return splice(object, lines(properties, indent, '{', '}'));
}

const literalValue = (element: ReturnType<ArrayLiteralExpression['getElements']>[number]) =>
	element.isKind(SyntaxKind.StringLiteral) ||
	element.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)
		? element.getLiteralValue()
		: undefined;

/** The patterns the config lists, or null when it has no `url.patterns` array to read. */
export function readUrlPatterns(source: string): string[] | null {
	const array = findPatternsArray(source);
	if (!array) return null;
	return array
		.getElements()
		.map(literalValue)
		.filter((value): value is string => value !== undefined);
}

/**
 * `source` with `add` appended to `url.patterns` and `remove` taken out.
 * Entries named in neither are left as they are, comments included. Null when
 * there is no `url.patterns` array to edit.
 */
export function withUrlPatterns(
	source: string,
	add: string[],
	remove: string[] = []
): { source: string; changed: boolean } | null {
	const array = findPatternsArray(source);
	if (!array) return null;

	let changed = false;
	const elements = array.getElements();
	const quote = elements[0]?.getText().startsWith("'") ? "'" : '"';

	// From the end, so earlier indexes stay valid.
	for (let i = elements.length - 1; i >= 0; i--) {
		const value = literalValue(elements[i]!);
		if (value !== undefined && remove.includes(value)) {
			array.removeElement(i);
			changed = true;
		}
	}

	const present = new Set(array.getElements().map(literalValue));
	const fresh = [...new Set(add)]
		.filter((pattern) => !present.has(pattern))
		.map((pattern) => `${quote}${pattern}${quote}`);
	if (fresh.length > 0) {
		const kept = array.getElements();
		// A catch-all stays last: wuchale takes the first pattern that matches.
		const catchAll = kept.findIndex((element) => literalValue(element) === '/**');
		const at = catchAll === -1 ? kept.length : catchAll;
		if (array.getText().includes('\n')) {
			const trailingComma = /,\s*\]$/.test(array.getText());
			array.insertElements(at, fresh, { useNewLines: true });
			const last = array.getElements().at(-1)!;
			if (trailingComma && !/,\s*\]$/.test(array.getText())) {
				array.getSourceFile().insertText(last.getEnd(), ',');
			}
			return { source: array.getSourceFile().getFullText(), changed: true };
		}
		// A one-line array, as enable-i18n writes it, is laid out again with
		// an entry per line; its `url: { ... }` too when that is one line.
		const texts = kept.map((element) => element.getText());
		texts.splice(at, 0, ...fresh);
		return { source: expandOntoLines(array, texts), changed: true };
	}

	return { source: changed ? array.getSourceFile().getFullText() : source, changed };
}

/** What to paste when the config could not be edited. */
export function urlPatternsHint(patterns: string[]): string {
	return [
		'Add these to `url.patterns` of the svelte adapter in wuchale.config.js:',
		'',
		...patterns.map((pattern) => `  "${pattern}",`)
	].join('\n');
}
