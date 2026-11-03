import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import * as tar from 'tar';
import { configDir } from './config.ts';
import { API_URL } from './constants.ts';

/**
 * The template registry: an `index.json` describing themed templates and, next
 * to it, one tarball per template. Built-in templates ship inside the CLI;
 * everything else (`vela create --template broadsheet`) is downloaded from here
 * on first use.
 *
 * A priced entry downloads through velastack.dev (`resolveDownloadUrl`) with
 * the user's API key, which checks that the template was bought for them, or
 * that they are in an agency, which has every template; nothing about the
 * tarball, checksum or extraction changes.
 */

const CACHE_DIR_NAME = 'templates';
const INDEX_CACHE_FILE = 'index.json';
const TARBALL_CACHE_DIR = 'cache';

/** How long a fetched index is trusted before it is fetched again. */
export const INDEX_CACHE_TTL_MS = 60 * 60 * 1000;

const DEFAULT_TIMEOUT_MS = 5000;

const formFieldSchema = v.object({
	name: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,39}$/)),
	type: v.picklist(['text', 'email', 'tel', 'textarea']),
	required: v.optional(v.boolean())
});

const formSchema = v.object({
	key: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,39}$/)),
	name: v.string(),
	fields: v.array(formFieldSchema)
});

export type TemplateFormField = v.InferOutput<typeof formFieldSchema>;
export type TemplateForm = v.InferOutput<typeof formSchema>;

/**
 * A form this CLI cannot read is dropped on its own, so it never costs the
 * whole entry (and with it the template) a place in the listing.
 */
const formsSchema = v.pipe(
	v.array(v.unknown()),
	v.transform((items) =>
		items.flatMap((item) => {
			const form = v.safeParse(formSchema, item);
			return form.success ? [form.output] : [];
		})
	)
);

const entrySchema = v.object({
	name: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]*$/)),
	description: v.string(),
	backend: v.boolean(),
	title: v.optional(v.string()),
	category: v.optional(v.string()),
	tags: v.optional(v.array(v.string())),
	price: v.optional(v.number()),
	previewUrl: v.optional(v.string()),
	nextSteps: v.optional(v.array(v.string())),
	/** Reads its copy from a hosted CMS through `site.cmsEndpoint`. */
	cms: v.optional(v.boolean()),
	/** A prebuilt static build is published for velastack.dev's instant deploys. */
	instantDeploy: v.optional(v.boolean()),
	/** Hosted forms velastack.dev creates, by `key`, in a project made from this template. */
	forms: v.optional(formsSchema),
	/** The locales its published content ships, the default first; the seed enables them all. */
	locales: v.optional(
		v.pipe(
			v.array(v.unknown()),
			v.transform((items) => items.filter((item): item is string => typeof item === 'string'))
		)
	),
	/** The schema.org type its JSON-LD describes (`ProfessionalService`, `Restaurant`, …). */
	schemaType: v.optional(v.string()),
	/** Tarball location, relative to the index URL; a paid entry's names velastack.dev's download, which `resolveDownloadUrl` derives itself. */
	file: v.string(),
	sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
	size: v.optional(v.number()),
	version: v.optional(v.string())
});

export type RemoteTemplateEntry = v.InferOutput<typeof entrySchema>;

const indexSchema = v.object({
	schemaVersion: v.literal(1),
	templates: v.array(v.unknown())
});

export interface TemplateIndex {
	/** Where the index was fetched from; tarball paths resolve against it. */
	url: string;
	templates: RemoteTemplateEntry[];
	/** Entries the index carried that this CLI could not understand. */
	skipped: number;
}

export interface FetchIndexOptions {
	timeoutMs?: number;
	headers?: HeadersInit;
	/** Skip the on-disk cache entirely (read and write). */
	noCache?: boolean;
	now?: number;
}

export interface FetchIndexResult {
	/** `null` when the registry could not be reached and nothing was cached. */
	index: TemplateIndex | null;
	/** The index came from the cache after a failed fetch. */
	stale: boolean;
	/** Why the fetch failed, when it did. */
	reason?: string;
}

interface CachedIndex {
	url: string;
	fetchedAt: number;
	index: TemplateIndex;
}

function cacheRoot(): string {
	return path.join(configDir(), CACHE_DIR_NAME);
}

function indexCachePath(): string {
	return path.join(cacheRoot(), INDEX_CACHE_FILE);
}

function readCachedIndex(url: string): CachedIndex | null {
	const file = indexCachePath();
	if (!fs.existsSync(file)) return null;
	try {
		const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as CachedIndex;
		if (cached.url !== url) return null;
		return cached;
	} catch {
		return null;
	}
}

function writeCachedIndex(cached: CachedIndex): void {
	fs.mkdirSync(cacheRoot(), { recursive: true });
	fs.writeFileSync(indexCachePath(), JSON.stringify(cached, null, 2));
}

/**
 * Parse an index document. Entries that fail validation are dropped rather
 * than failing the whole listing: an older CLI must keep working when the
 * registry starts publishing fields it does not know how to check.
 */
export function parseTemplateIndex(text: string, url: string): TemplateIndex {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		throw new Error(`Template index at ${url} is not valid JSON: ${(e as Error).message}`);
	}
	const doc = v.safeParse(indexSchema, parsed);
	if (!doc.success) {
		throw new Error(`Template index at ${url} has an unsupported format`);
	}
	const templates: RemoteTemplateEntry[] = [];
	let skipped = 0;
	for (const raw of doc.output.templates) {
		const entry = v.safeParse(entrySchema, raw);
		if (entry.success) templates.push(entry.output);
		else skipped++;
	}
	return { url, templates, skipped };
}

function isFileUrl(url: string): boolean {
	return url.startsWith('file:');
}

/** Node's `fetch` does not speak `file:`, which a local checkout of the registry uses. */
async function readBytes(url: string, options: { timeoutMs: number; headers?: HeadersInit }) {
	if (isFileUrl(url)) {
		return new Uint8Array(fs.readFileSync(fileURLToPath(url)));
	}
	const res = await fetch(url, {
		headers: options.headers,
		signal: AbortSignal.timeout(options.timeoutMs)
	});
	if (!res.ok) {
		throw new DownloadRefused(res.status, res.statusText, await res.text().catch(() => ''));
	}
	return new Uint8Array(await res.arrayBuffer());
}

const headersObject = (headers: HeadersInit | undefined): Record<string, string> =>
	headers ? Object.fromEntries(new Headers(headers)) : {};

/**
 * The registry index, from the cache when it is fresh, otherwise fetched. A
 * fetch that fails falls back to whatever was cached, however old, so a flaky
 * connection does not hide templates the user has used before.
 */
export async function fetchTemplateIndex(
	url: string,
	options: FetchIndexOptions = {}
): Promise<FetchIndexResult> {
	const now = options.now ?? Date.now();
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const cached = options.noCache ? null : readCachedIndex(url);

	if (cached && now - cached.fetchedAt < INDEX_CACHE_TTL_MS && !isFileUrl(url)) {
		return { index: cached.index, stale: false };
	}

	try {
		const bytes = await readBytes(url, { timeoutMs, headers: options.headers });
		const index = parseTemplateIndex(Buffer.from(bytes).toString('utf8'), url);
		if (!options.noCache && !isFileUrl(url)) {
			writeCachedIndex({ url, fetchedAt: now, index });
		}
		return { index, stale: false };
	} catch (e) {
		const reason = (e as Error).message;
		if (cached) return { index: cached.index, stale: true, reason };
		return { index: null, stale: false, reason };
	}
}

/** A template that has to be bought (or come with an agency) before it downloads. */
export const isPaidEntry = (entry: Pick<RemoteTemplateEntry, 'price'>) => (entry.price ?? 0) > 0;

/**
 * Where an entry's tarball is downloaded from. Free templates resolve straight
 * against the index; a paid one goes through velastack.dev (`VELA_API_URL`,
 * so staging's CLI asks staging), which hands it out to an API key whose
 * account has it.
 */
export function resolveDownloadUrl(
	entry: RemoteTemplateEntry,
	indexUrl: string,
	apiUrl: string = API_URL
): string {
	if (isPaidEntry(entry)) return `${apiUrl}/v1/templates/${entry.name}/download`;
	return new URL(entry.file, indexUrl).href;
}

/** What velastack.dev answers a download it refuses with. */
class DownloadRefused extends Error {
	status: number;
	body: string;
	constructor(status: number, statusText: string, body: string) {
		super(`${status} ${statusText}`.trim());
		this.status = status;
		this.body = body;
	}
}

/**
 * Why a paid template did not download, in the user's terms: not bought (402,
 * with where to buy it), a key velastack.dev no longer accepts (401), or
 * anything else as it came.
 */
function paidDownloadMessage(entry: RemoteTemplateEntry, error: DownloadRefused): string {
	const title = entry.title ?? entry.name;
	if (error.status === 402) {
		let url = `https://velabase.dev/templates/${entry.name}`;
		try {
			const parsed = JSON.parse(error.body) as { url?: string };
			if (typeof parsed.url === 'string') url = parsed.url;
		} catch {
			// a plain-text answer; the default page is right
		}
		return `${title} is a paid template (US$${entry.price}). Buy it for your team at ${url}, then run this again.`;
	}
	if (error.status === 401) {
		return `velastack.dev did not accept your login. Run \`vela login\` and try again.`;
	}
	return error.message;
}

function sha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function tarballCachePath(entry: RemoteTemplateEntry): string {
	return path.join(
		cacheRoot(),
		TARBALL_CACHE_DIR,
		`${entry.name}-${entry.sha256.slice(0, 12)}.tgz`
	);
}

export interface DownloadOptions {
	timeoutMs?: number;
	headers?: HeadersInit;
	/** The velastack.dev API key a paid template is fetched with. */
	apiKey?: string | null;
	apiUrl?: string;
}

/**
 * Fetch an entry's tarball (or reuse a cached copy whose checksum still
 * matches) and unpack it into a fresh temporary directory laid out exactly like
 * a built-in template, so the same copy step serves both.
 *
 * The caller owns the returned directory and removes it when done.
 */
export async function downloadTemplate(
	entry: RemoteTemplateEntry,
	indexUrl: string,
	options: DownloadOptions = {}
): Promise<string> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS * 6;
	const cacheFile = tarballCachePath(entry);

	let haveTarball = false;
	if (fs.existsSync(cacheFile)) {
		const cached = new Uint8Array(fs.readFileSync(cacheFile));
		haveTarball = sha256(cached) === entry.sha256;
	}

	if (!haveTarball) {
		const paid = isPaidEntry(entry);
		if (paid && !options.apiKey) {
			throw new Error(
				`${entry.title ?? entry.name} is a paid template. Run \`vela login\` (or set VELA_API_KEY) so velastack.dev can check it was bought for you.`
			);
		}
		const url = resolveDownloadUrl(entry, indexUrl, options.apiUrl);
		const headers = paid
			? { ...headersObject(options.headers), Authorization: `Bearer ${options.apiKey}` }
			: options.headers;
		let fetched: Uint8Array;
		try {
			fetched = await readBytes(url, { timeoutMs, headers });
		} catch (e) {
			if (paid && e instanceof DownloadRefused) throw new Error(paidDownloadMessage(entry, e));
			throw new Error(`Could not download template ${entry.name}: ${(e as Error).message}`);
		}
		const digest = sha256(fetched);
		if (digest !== entry.sha256) {
			throw new Error(
				`Downloaded template ${entry.name} did not match its checksum (expected ${entry.sha256}, got ${digest}). ` +
					'Try again, or set VELA_TEMPLATE_INDEX_URL to a registry you trust.'
			);
		}
		fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
		fs.writeFileSync(cacheFile, fetched);
	}

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vela-template-${entry.name}-`));
	try {
		// Archives hold a single top-level directory named after the template.
		await tar.extract({ file: cacheFile, cwd: dir, strip: 1 });
	} catch (e) {
		fs.rmSync(dir, { recursive: true, force: true });
		throw new Error(`Could not unpack template ${entry.name}: ${(e as Error).message}`);
	}
	return dir;
}
