export interface CollectionLike {
	id: string;
	name: string;
	fields: Array<{ type: string; collectionId?: string }>;
}

/**
 * The app's collections with every relation target ahead of what points at it,
 * so records written in this order always find the records they refer to.
 *
 * Otherwise the given order is kept, and a cycle (or a collection relating to
 * itself) is broken where it is met rather than refused: there is no order
 * that satisfies one. System collections (`_superusers` and the like) are left
 * out, as they are not the app's data to save, generate or clear.
 */
export function dependencyOrder(collections: CollectionLike[]): { ids: string[]; names: string[] } {
	const eligible = collections.filter((c) => !c.name.startsWith('_'));
	const byId = new Map(eligible.map((c) => [c.id, c]));
	const seen = new Set<string>();
	const order: CollectionLike[] = [];

	const visit = (collection: CollectionLike) => {
		// Marked on the way in, so a cycle stops at the collection that closes it.
		if (seen.has(collection.id)) return;
		seen.add(collection.id);
		for (const field of collection.fields) {
			if (field.type !== 'relation' || !field.collectionId) continue;
			const target = byId.get(field.collectionId);
			if (target) visit(target);
		}
		order.push(collection);
	};

	for (const collection of eligible) visit(collection);

	return { ids: order.map((c) => c.id), names: order.map((c) => c.name) };
}
