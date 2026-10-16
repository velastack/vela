/**
 * `vela create --schema <slug>`: start a project from one of the gallery's
 * schemas. Runs after the project's PocketBase superuser exists: boots
 * PocketBase on the project's own data directory, applies the schema in
 * the order the engine plans, and lets automigrate write the migration
 * files. The project is then exactly what the gallery page showed.
 */
import path from 'node:path';
import PocketBase from 'pocketbase';
import {
	apply,
	diff,
	hasErrors,
	lint,
	plan,
	schemaFromPocketBase,
	type Plan,
	type Schema
} from '@velastack/schema';
import { gallery, galleryBySlug, type GallerySchema } from '@velastack/schema/registry';
import { DATA_DIR, MIGRATIONS_DIR } from './constants.ts';
import { authWithRetries, startPocketbaseServe } from './pocketbase.ts';
import { sdkClient } from './schema-editor.ts';
import { listMigrations } from './schema-server.ts';

export const gallerySlugs = (): string[] => gallery.map((g) => g.slug);

export function findGallerySchema(slug: string): GallerySchema {
	const entry = galleryBySlug[slug];
	if (!entry) {
		throw new Error(
			`Unknown schema "${slug}". Choose one of: ${gallerySlugs().join(', ')} (see https://velastack.dev/schemas).`
		);
	}
	return entry;
}

/**
 * The plan that adds a gallery schema to a project as it is: everything the
 * database already holds stays, the gallery's collections join it. Throws
 * when the two do not fit (a name already taken, a lint error).
 */
export function planGallerySchema(base: Schema, entry: GallerySchema): Plan {
	const next: Schema = { collections: [...base.collections, ...entry.schema.collections] };
	const changes = diff(base, next);
	const issues = lint(base, next, changes);
	if (hasErrors(issues)) {
		throw new Error(
			`The ${entry.slug} schema does not fit this project: ${issues
				.filter((i) => i.level === 'error')
				.map((i) => i.message)
				.join(' ')}`
		);
	}
	return plan(base, next, changes);
}

export interface ApplyGalleryResult {
	collections: number;
	/** Migration files written, relative to the project's migrations directory. */
	written: string[];
}

export async function applyGallerySchema(
	projectPath: string,
	entry: GallerySchema,
	credentials: { email: string; password: string }
): Promise<ApplyGalleryResult> {
	const migrationsDir = path.join(projectPath, MIGRATIONS_DIR);
	const { proc, url } = await startPocketbaseServe({
		dataDir: path.join(projectPath, DATA_DIR),
		migrationsDir,
		stdio: 'ignore'
	});
	try {
		const pb = new PocketBase(url);
		await authWithRetries(pb, credentials.email, credentials.password);
		const client = sdkClient(pb);
		const base = schemaFromPocketBase(await client.list());
		const steps = planGallerySchema(base, entry);
		const before = listMigrations(migrationsDir);
		const result = await apply(client, steps);
		if (result.failed) {
			const message =
				result.failed.error instanceof Error
					? result.failed.error.message
					: String(result.failed.error);
			throw new Error(`Could not create ${result.failed.step.name}: ${message}`);
		}
		return {
			collections: entry.schema.collections.length,
			written: listMigrations(migrationsDir).filter((f) => !before.includes(f))
		};
	} finally {
		proc.kill();
	}
}
