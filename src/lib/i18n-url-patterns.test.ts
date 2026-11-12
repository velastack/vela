import { describe, expect, test } from 'vitest';
import {
	coveringPattern,
	readUrlPatterns,
	routeIdToPattern,
	withUrlPatterns
} from './i18n-url-patterns.ts';

/** The config `vela enable i18n` writes. */
const GENERATED = `// @ts-check
import { adapter as svelte } from "@wuchale/svelte";
import { defineConfig } from "wuchale";

export default defineConfig({
  locales: ["en", "es"],
  adapters: {
    main: svelte({
      loader: "sveltekit",
      patterns: [pluralPattern],
      url: { localize: "src/lib/url.ts", patterns: ["/"] },
    }),
  },
});
`;

/** A hand-written one: \`url\` hoisted, tabs, single quotes, comments in the list. */
const HOISTED = `const url = {
	localize: 'src/lib/url.ts',
	patterns: [
		'/',
		// the early-access form, which is a hash on the home page
		'/#early-access',
		'/docs',
		'/docs/**'
	]
};

export default defineConfig({ adapters: { main: svelte({ url }) } });
`;

describe('routeIdToPattern', () => {
	test.each([
		['/', '/'],
		['/(public)', '/'],
		['/(public)/(auth)/login', '/login'],
		['/(public)/blog/[slug]', '/blog/*'],
		['/blog/[slug=word]/edit', '/blog/*/edit'],
		['/docs/[...path]', '/docs/**'],
		['/[[lang]]/about', '/?/about'],
		['/[[lang=locale]]', '/'],
		['/about/[[page]]', '/about/?'],
		['/files/report-[year].pdf', '/files/report-*.pdf'],
		['/[x+2e]well-known/security[x+2e]txt', '/.well-known/security.txt']
	])('%s → %s', (id, pattern) => {
		expect(routeIdToPattern(id)).toBe(pattern);
	});

	test('a literal wildcard character cannot be said', () => {
		expect(routeIdToPattern('/what[x+3f]')).toBeNull();
		expect(routeIdToPattern('/a[x+2a]b')).toBeNull();
	});
});

describe('coveringPattern', () => {
	test('a broader pattern that already matches', () => {
		expect(coveringPattern('/blog/*', ['/', '/blog/**'])).toBe('/blog/**');
		expect(coveringPattern('/docs', ['/docs/**'])).toBe('/docs/**');
		expect(coveringPattern('/a/b/c', ['/**'])).toBe('/**');
		expect(coveringPattern('/blog/hello', ['/blog/*'])).toBe('/blog/*');
	});

	test('nothing when no other pattern matches', () => {
		expect(coveringPattern('/about', ['/', '/blog/**', '/about'])).toBeUndefined();
		expect(coveringPattern('/blog/*/edit', ['/blog/*'])).toBeUndefined();
		expect(coveringPattern('/blog', ['/blog/*'])).toBeUndefined();
		expect(coveringPattern('/about-us', ['/about'])).toBeUndefined();
	});
});

describe('readUrlPatterns', () => {
	test("reads url.patterns, not the adapter's plural patterns", () => {
		expect(readUrlPatterns(GENERATED)).toEqual(['/']);
		expect(readUrlPatterns(HOISTED)).toEqual(['/', '/#early-access', '/docs', '/docs/**']);
	});

	test('null when there is no array to read', () => {
		expect(readUrlPatterns('export default defineConfig({});')).toBeNull();
		expect(readUrlPatterns('const url = { patterns: routes };')).toBeNull();
	});
});

describe('withUrlPatterns', () => {
	test('lays the generated one-line config out with an entry per line', () => {
		const result = withUrlPatterns(GENERATED, ['/about', '/blog/*']);
		expect(result?.changed).toBe(true);
		expect(result?.source).toContain(`      url: {
        localize: "src/lib/url.ts",
        patterns: [
          "/",
          "/about",
          "/blog/*",
        ],
      },
    }),`);
		expect(result?.source).toContain('patterns: [pluralPattern],');
	});

	test('adds to and removes from a hoisted config, keeping its style and comments', () => {
		const result = withUrlPatterns(HOISTED, ['/pricing'], ['/docs']);
		expect(result?.source).toBe(`const url = {
	localize: 'src/lib/url.ts',
	patterns: [
		'/',
		// the early-access form, which is a hash on the home page
		'/#early-access',
		'/docs/**',
		'/pricing'
	]
};

export default defineConfig({ adapters: { main: svelte({ url }) } });
`);
	});

	test('keeps a catch-all last', () => {
		const source = GENERATED.replace('["/"]', '["/", "/**"]');
		expect(readUrlPatterns(withUrlPatterns(source, ['/about'])!.source)).toEqual([
			'/',
			'/about',
			'/**'
		]);
	});

	test('nothing to do is no change', () => {
		expect(withUrlPatterns(GENERATED, ['/'], ['/missing'])).toEqual({
			source: GENERATED,
			changed: false
		});
	});

	test('null when the config has no url.patterns array', () => {
		expect(withUrlPatterns('export default defineConfig({});', ['/about'])).toBeNull();
	});
});
