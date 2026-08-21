import * as p from '@clack/prompts';
import { withPocketbase } from './pocketbase.ts';
import type { CollectionFieldSpec, CollectionSpec } from './ai-client.ts';

interface PbField {
	name: string;
	type: string;
	system?: boolean;
	required?: boolean;
	values?: string[];
	collectionId?: string;
	maxSelect?: number;
	min?: number;
	max?: number;
}

interface PbCollection {
	id: string;
	name: string;
	type: string;
	system?: boolean;
	fields: PbField[];
}

/**
 * Load existing user-defined collections from the project's PocketBase.
 * Returns [] (with a warning) if PocketBase is unreachable.
 */
export async function loadExistingModels(workspaceRootDir: string): Promise<CollectionSpec[]> {
	let result: CollectionSpec[] = [];
	try {
		await withPocketbase(workspaceRootDir, async (pb) => {
			const all = (await pb.collections.getFullList()) as unknown as PbCollection[];
			const userCollections = all.filter((c) => !c.system);
			const byId = new Map(userCollections.map((c) => [c.id, c.name]));
			result = userCollections.map((c) => ({
				name: c.name,
				type: c.type,
				fields: c.fields
					.filter((f) => !f.system)
					.map<CollectionFieldSpec>((f) => ({
						name: f.name,
						type: f.type,
						required: f.required,
						values: f.values,
						collectionName: f.collectionId ? byId.get(f.collectionId) : undefined,
						maxSelect: f.maxSelect,
						min: f.min,
						max: f.max
					}))
			}));
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		p.log.warn(
			`Could not load existing schema from PocketBase (${msg}). The AI agent will design without that context.`
		);
		return [];
	}
	return result;
}
