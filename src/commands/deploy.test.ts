import { describe, expect, test } from 'vitest';
import { nodeVersionAtLeast } from './deploy.ts';

describe('nodeVersionAtLeast', () => {
	test('compares the minor within the same major', () => {
		expect(nodeVersionAtLeast('v22.16.0', 22, 17)).toBe(false);
		expect(nodeVersionAtLeast('v22.17.0', 22, 17)).toBe(true);
		expect(nodeVersionAtLeast('v22.20.1', 22, 17)).toBe(true);
	});

	test('a later major passes whatever its minor', () => {
		expect(nodeVersionAtLeast('v23.0.0', 22, 17)).toBe(true);
		expect(nodeVersionAtLeast('v24.1.0', 22, 17)).toBe(true);
	});

	test('an earlier major fails whatever its minor', () => {
		expect(nodeVersionAtLeast('v20.19.5', 22, 17)).toBe(false);
	});

	test('reads `node -v` output as it arrives', () => {
		expect(nodeVersionAtLeast('v24.0.0\n', 22, 17)).toBe(true);
		expect(nodeVersionAtLeast('22.17.0', 22, 17)).toBe(true);
	});

	test('no Node, or nothing readable, is not enough', () => {
		expect(nodeVersionAtLeast('', 22, 17)).toBe(false);
		expect(nodeVersionAtLeast('bash: node: command not found', 22, 17)).toBe(false);
	});
});
