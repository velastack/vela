export interface CollectionLike {
	id: string;
	name: string;
	fields: Array<{ type: string; collectionId?: string }>;
}

export function dependencyOrder(
	collections: CollectionLike[],
	startingCollectionId?: string
): { ids: string[]; names: string[] } {
	const order: string[] = [];
	const visited: Record<string, boolean> = {};
	const queue: string[] = [];

	const eligible = collections.filter((c) => !c.name.startsWith('_'));

	if (startingCollectionId) {
		queue.push(startingCollectionId);
	} else {
		for (const collection of eligible) {
			if (!visited[collection.id]) {
				visited[collection.id] = true;
				queue.push(collection.id);
			}
		}
	}

	while (queue.length > 0) {
		const collectionId = queue.shift();
		if (!collectionId) continue;
		order.push(collectionId);

		const source = collections.find((c) => c.id === collectionId);
		for (const field of source?.fields ?? []) {
			if (field.type === 'relation' && field.collectionId && !visited[field.collectionId]) {
				visited[field.collectionId] = true;
				queue.push(field.collectionId);
			}
		}
	}

	const nameById = Object.fromEntries(collections.map((c) => [c.id, c.name]));
	return { ids: order, names: order.map((id) => nameById[id]!) };
}
