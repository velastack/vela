import { describe, expect, test } from 'vitest';
import { dependencyOrder, type CollectionLike } from './collections.ts';

function collection(name: string, ...relations: string[]): CollectionLike {
	return {
		id: `id_${name}`,
		name,
		fields: [
			{ type: 'text' },
			...relations.map((target) => ({ type: 'relation', collectionId: `id_${target}` }))
		]
	};
}

describe('dependencyOrder', () => {
	test('puts a relation target ahead of what points at it', () => {
		const { names, ids } = dependencyOrder([
			collection('comments', 'posts'),
			collection('posts', 'users'),
			collection('users')
		]);

		expect(names).toEqual(['users', 'posts', 'comments']);
		expect(ids).toEqual(['id_users', 'id_posts', 'id_comments']);
	});

	test('keeps the given order where nothing depends on anything', () => {
		const { names } = dependencyOrder([collection('b'), collection('a'), collection('c')]);
		expect(names).toEqual(['b', 'a', 'c']);
	});

	test('orders a diamond with the shared target first and each collection once', () => {
		const { names } = dependencyOrder([
			collection('orders', 'customers', 'products'),
			collection('customers', 'plans'),
			collection('products', 'plans'),
			collection('plans')
		]);

		expect(names).toEqual(['plans', 'customers', 'products', 'orders']);
	});

	test('breaks a cycle instead of looping or dropping a collection', () => {
		const { names } = dependencyOrder([collection('a', 'b'), collection('b', 'a')]);
		expect(names).toEqual(['b', 'a']);
	});

	test('tolerates a collection relating to itself', () => {
		const { names } = dependencyOrder([collection('categories', 'categories'), collection('x')]);
		expect(names).toEqual(['categories', 'x']);
	});

	test('leaves system collections out, even when related to', () => {
		const { names } = dependencyOrder([
			collection('_superusers'),
			collection('audits', '_superusers'),
			collection('missing_target', 'gone')
		]);

		expect(names).toEqual(['audits', 'missing_target']);
	});
});
