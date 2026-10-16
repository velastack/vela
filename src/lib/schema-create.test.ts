import { describe, expect, it } from 'vitest';
import { builtinSchema, type Collection } from '@velastack/schema';
import { galleryBySlug } from '@velastack/schema/registry';
import { findGallerySchema, planGallerySchema } from './schema-create.ts';

const system = (name: string, id: string): Collection => ({
	id,
	name,
	type: 'base',
	system: true,
	indexes: [],
	rules: { list: null, view: null, create: null, update: null, delete: null },
	fields: [{ id: 'text3208210256', name: 'id', type: 'text', system: true }]
});

describe('planGallerySchema', () => {
	it('adds the gallery collections and leaves everything the project has alone', () => {
		const base = builtinSchema();
		base.collections.push(system('_mfas', 'pbc_mfas'), system('_whatsapp', 'pbc_wa'));
		const entry = galleryBySlug['hotel-bookings']!;
		const plan = planGallerySchema(base, entry);
		expect(plan.steps.every((s) => s.kind !== 'delete')).toBe(true);
		expect(new Set(plan.steps.map((s) => s.name))).toEqual(
			new Set(entry.schema.collections.map((c) => c.name))
		);
		expect(plan.steps.filter((s) => s.kind === 'create')).toHaveLength(
			entry.schema.collections.length
		);
	});

	it('refuses when a collection name is already taken', () => {
		const base = builtinSchema();
		base.collections.push({ ...system('rooms', 'pbc_rooms_mine'), system: false });
		expect(() => planGallerySchema(base, galleryBySlug['hotel-bookings']!)).toThrow(/rooms/);
	});

	it('names the choices on an unknown slug', () => {
		expect(() => findGallerySchema('nope')).toThrow(/gym-memberships/);
		expect(findGallerySchema('invoicing').title).toBe('Invoicing');
	});
});
