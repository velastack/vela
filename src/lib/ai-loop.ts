import * as p from '@clack/prompts';
import type { AiTurn } from './ai-client.ts';

export interface AiLoopCallContext {
	prompt: string;
	history: AiTurn[];
}

export interface AiLoopCallResult<T> {
	result: T;
	turn: AiTurn[];
}

export interface AiLoopOptions<T> {
	initialPrompt: string;
	stageLabel: string;
	refinePlaceholder: string;
	call: (ctx: AiLoopCallContext) => Promise<AiLoopCallResult<T>>;
	renderPreview: (result: T) => void;
}

/**
 * Run a preview-and-refine loop. Calls `call` with the current prompt + history,
 * renders the preview, then asks the user to refine (non-empty input) or apply
 * (empty input). Cancel exits the loop with `null`.
 */
export async function aiLoop<T>(opts: AiLoopOptions<T>): Promise<T | null> {
	let prompt = opts.initialPrompt;
	let history: AiTurn[] = [];
	let attempt = 0;

	while (true) {
		attempt++;
		const spinner = p.spinner();
		spinner.start(`${opts.stageLabel} (${attempt > 1 ? 'iteration ' + attempt : 'first pass'})…`);
		let result: T;
		let turn: AiTurn[];
		try {
			const out = await opts.call({ prompt, history });
			result = out.result;
			turn = out.turn;
			spinner.stop(`${opts.stageLabel} ready.`);
		} catch (e) {
			spinner.stop(`${opts.stageLabel} failed.`);
			throw e;
		}

		opts.renderPreview(result);

		const next = await p.text({
			message: 'Refine the result, or press Enter to apply.',
			placeholder: opts.refinePlaceholder,
			defaultValue: ''
		});

		if (p.isCancel(next)) return null;
		const trimmed = (typeof next === 'string' ? next : '').trim();
		if (trimmed === '') return result;

		history = turn;
		prompt = trimmed;
	}
}
