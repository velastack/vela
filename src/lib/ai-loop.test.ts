import { describe, it, expect, vi, beforeEach } from 'vitest';

let textResponses: Array<string | symbol> = [];
const cancelSym = Symbol('clack.cancel');

vi.mock('@clack/prompts', () => ({
	spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
	text: vi.fn(async () => textResponses.shift()),
	isCancel: (v: unknown) => v === cancelSym
}));

import { aiLoop } from './ai-loop.ts';

describe('aiLoop', () => {
	beforeEach(() => {
		textResponses = [];
	});

	it('returns the result on empty input (apply)', async () => {
		textResponses = [''];
		const call = vi.fn().mockResolvedValue({ result: { ok: 1 }, turn: [{ role: 'assistant', content: 'a' }] });
		const out = await aiLoop({
			initialPrompt: 'first',
			stageLabel: 'Designing',
			refinePlaceholder: 'p',
			call,
			renderPreview: () => {}
		});
		expect(out).toEqual({ ok: 1 });
		expect(call).toHaveBeenCalledTimes(1);
		expect(call.mock.calls[0]![0]).toMatchObject({ prompt: 'first', history: [] });
	});

	it('replays history on refinement', async () => {
		textResponses = ['add phone', ''];
		const call = vi
			.fn()
			.mockResolvedValueOnce({
				result: { v: 1 },
				turn: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'a1' }]
			})
			.mockResolvedValueOnce({ result: { v: 2 }, turn: [] });
		const out = await aiLoop({
			initialPrompt: 'first',
			stageLabel: 'Designing',
			refinePlaceholder: 'p',
			call,
			renderPreview: () => {}
		});
		expect(out).toEqual({ v: 2 });
		expect(call).toHaveBeenCalledTimes(2);
		expect(call.mock.calls[1]![0]).toMatchObject({
			prompt: 'add phone',
			history: [
				{ role: 'user', content: 'first' },
				{ role: 'assistant', content: 'a1' }
			]
		});
	});

	it('returns null on cancel', async () => {
		textResponses = [cancelSym];
		const call = vi.fn().mockResolvedValue({ result: { v: 1 }, turn: [] });
		const out = await aiLoop({
			initialPrompt: 'x',
			stageLabel: 'Designing',
			refinePlaceholder: 'p',
			call,
			renderPreview: () => {}
		});
		expect(out).toBeNull();
	});
});
