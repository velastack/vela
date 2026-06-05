import * as p from '@clack/prompts';
import type { CollectionFieldSpec, CollectionSpec } from './ai-client.ts';

const PRIMITIVE_TYPES = new Set(['text', 'number', 'bool', 'email', 'date', 'url', 'file']);

function singularize(name: string): string {
	if (name.endsWith('ies') && name.length > 3) return `${name.slice(0, -3)}y`;
	if (name.endsWith('s') && !name.endsWith('ss')) return name.slice(0, -1);
	return name;
}

function typeArg(field: CollectionFieldSpec): string | null {
	if (field.type === 'select' && field.values && field.values.length > 0) {
		return `select(${field.values.join(',')})`;
	}
	if (field.type === 'relation') {
		if (!field.collectionName) return null;
		return singularize(field.collectionName);
	}
	if (PRIMITIVE_TYPES.has(field.type)) return field.type;
	return null;
}

/**
 * Convert a CollectionSpec to argv for the patterns package.
 * Drops + warns on fields that can't be expressed cleanly.
 */
export function collectionSpecToArgv(spec: CollectionSpec): string[] {
	const argv: string[] = [spec.name];
	for (const field of spec.fields) {
		const type = typeArg(field);
		if (type === null) {
			p.log.warn(`Skipping field "${field.name}" (type "${field.type}" cannot be represented as a pattern argument)`);
			continue;
		}
		const required = field.required ? '!' : '';
		argv.push(`${field.name}:${type}${required}`);
	}
	return argv;
}
