import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import * as tar from 'tar';
import { configDir } from './config.ts';

/**
 * The template registry: an `index.json` describing themed templates and, next
 * to it, one tarball per template. Built-in templates ship inside the CLI;
 * everything else (`vela create --template broadsheet`) is downloaded from here
 * on first use.
 *
 * Paid templates land later. The seam is `resolveDownloadUrl` plus the `headers`
 * option: a priced entry will download through velastack.dev with an API key,
 * and nothing about the tarball, checksum or extraction changes.
 */

const CACHE_DIR_NAME = 'templates';
const INDEX_CACHE_FILE = 'index.json';
const TARBALL_CACHE_DIR = 'cache';

/** How long a fetched index is trusted before it is fetched again. */
export const INDEX_CACHE_TTL_MS = 60 * 60 * 1000;

const DEFAULT_TIMEOUT_MS = 5000;

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
	/** Tarball location, relative to the index URL. */
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
		throw new Error(`${res.status} ${res.statusText}`.trim());
	}
	return new Uint8Array(await res.arrayBuffer());
}

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

/**
 * Where an entry's tarball is downloaded from. Free templates resolve straight
 * against the index; a paid one will go through velastack.dev instead, which is
 * the only place this needs to change.
 */
export function resolveDownloadUrl(entry: RemoteTemplateEntry, indexUrl: string): string {
	return new URL(entry.file, indexUrl).href;
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
		const url = resolveDownloadUrl(entry, indexUrl);
		let fetched: Uint8Array;
		try {
			fetched = await readBytes(url, { timeoutMs, headers: options.headers });
		} catch (e) {
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
