import { beforeEach, describe, expect, it, vi } from 'vitest';

const logged: Array<{ level: string; text: string }> = [];
const notes: Array<{ text: string; title?: string }> = [];

vi.mock('@clack/prompts', () => ({
	log: {
		success: (text: string) => logged.push({ level: 'success', text }),
		warn: (text: string) => logged.push({ level: 'warn', text }),
		info: (text: string) => logged.push({ level: 'info', text })
	},
	note: (text: string, title?: string) => notes.push({ text, title })
}));

import { reportResult } from './result-report.ts';

const levels = () => logged.map((l) => l.level);
const text = () => logged.map((l) => l.text).join('\n');

describe('reportResult', () => {
	beforeEach(() => {
		logged.length = 0;
		notes.length = 0;
	});

	it('reports a plain success with no failures', () => {
		reportResult({ summary: 'Enabled blog.', filesCreated: ['src/routes/blog/+page.svelte'] });
		expect(levels()).toEqual(['success']);
		expect(text()).toContain('Files created:');
		expect(text()).toContain('src/routes/blog/+page.svelte');
	});

	it('prints the remediation snippet for a failed file', () => {
		// The snippet is the entire point of the failure path: a modifier that
		// refuses to touch a file it does not recognise hands back the lines the
		// user should paste in. Swallowing it leaves them with nothing.
		reportResult({
			summary: 'Applied CMS.',
			filesCreated: ['src/lib/server/cms.ts'],
			failures: [
				{
					path: 'src/routes/+layout.server.ts',
					status: 'failed',
					message: 'Add the loadCms call:\n\nconst { cms } = await loadCms(event, { locale });'
				}
			]
		});

		expect(levels()).toEqual(['success', 'warn']);
		const warning = logged.find((l) => l.level === 'warn')!.text;
		expect(warning).toContain('Could not update src/routes/+layout.server.ts');
		expect(warning).toContain('const { cms } = await loadCms(event, { locale });');
	});

	it('never lists a failed file as modified', () => {
		reportResult({
			summary: 'Applied CMS.',
			filesModified: ['vite.config.ts'],
			failures: [
				{ path: 'src/routes/+layout.server.ts', status: 'failed', message: 'do it by hand' }
			]
		});
		const success = logged.find((l) => l.level === 'success')!.text;
		expect(success).toContain('vite.config.ts');
		expect(success).not.toContain('+layout.server.ts');
	});

	it('distinguishes a missing file from one it could not parse', () => {
		reportResult({
			summary: 'Applied CMS.',
			failures: [
				{ path: 'vite.config.ts', status: 'not-found', message: 'Create one.' },
				{ path: 'src/routes/+layout.svelte', status: 'failed', message: 'Edit by hand.' }
			]
		});
		expect(text()).toContain('Could not find vite.config.ts');
		expect(text()).toContain('Could not update src/routes/+layout.svelte');
	});

	it('reports failures even when nothing else happened', () => {
		reportResult({
			summary: 'Applied CMS.',
			failures: [{ path: 'vite.config.ts', status: 'failed', message: 'by hand' }]
		});
		// No bare success line claiming the pattern applied.
		expect(levels()).toEqual(['warn']);
	});

	it('renders next steps as a note when everything applied', () => {
		reportResult({
			summary: 'Applied CMS.',
			filesCreated: ['src/lib/cms.ts'],
			nextSteps: ['Run `vela cms editor add you@example.com`.']
		});
		expect(notes).toHaveLength(1);
		expect(notes[0].title).toBe('Next steps');
		expect(notes[0].text).toContain('- Run `vela cms editor add you@example.com`.');
	});

	it('handles a failure with no message', () => {
		reportResult({
			summary: 'Applied CMS.',
			failures: [{ path: 'vite.config.ts', status: 'failed' }]
		});
		expect(text()).toBe('Could not update vite.config.ts');
	});
});
