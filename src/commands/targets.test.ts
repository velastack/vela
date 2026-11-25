import { describe, expect, test } from 'vitest';
import { instanceId } from '../lib/instance.ts';
import { targetLabel, targetsTable, type Row } from './targets.ts';

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

describe('vela targets', () => {
	test('the default target is shown as production, as everywhere else', () => {
		expect(targetLabel('prod')).toBe('production');
		expect(targetLabel('staging')).toBe('staging');
		expect(targetLabel('preview--fix-copy')).toBe('preview--fix-copy');
	});

	test('the table shows it, with the column as wide as the longer name', () => {
		const rows: Row[] = [
			{ target: 'local', kind: 'local', server: '—', domain: '—', release: '—', reachable: true },
			{
				target: 'prod',
				kind: 'remote',
				server: 'root@203.0.113.7',
				domain: 'example.com',
				release: '20261124T120000Z-ab12',
				reachable: true
			}
		];
		const { header, lines } = targetsTable(rows);
		expect(header.startsWith('TARGET      SERVER')).toBe(true);
		expect(strip(lines[0]!).startsWith('local       —')).toBe(true);
		expect(strip(lines[1]!)).toBe(
			'production  root@203.0.113.7  example.com  20261124T120000Z-ab12'
		);
		// What --json prints, and what the instance is named after, is untouched.
		expect(rows[1]!.target).toBe('prod');
		expect(instanceId('abc123', rows[1]!.target)).toBe('abc123');
	});
});
