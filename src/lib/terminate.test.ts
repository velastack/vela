import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { onTerminate } from './terminate.ts';

function fakeProcess() {
	const emitter = new EventEmitter();
	const exit = vi.fn();
	return { emitter, exit, proc: { on: emitter.on.bind(emitter), exit } as never };
}

describe('onTerminate', () => {
	test.each([
		['SIGINT', 0],
		['SIGTERM', 143],
		['SIGHUP', 129]
	])('%s runs the cleanup, then exits %i', (signal, code) => {
		const { emitter, exit, proc } = fakeProcess();
		const cleanup = vi.fn();
		onTerminate(cleanup, proc);
		emitter.emit(signal);
		expect(cleanup).toHaveBeenCalledOnce();
		expect(exit).toHaveBeenCalledWith(code);
	});

	test('a normal exit runs the cleanup too', () => {
		const { emitter, proc } = fakeProcess();
		const cleanup = vi.fn();
		onTerminate(cleanup, proc);
		emitter.emit('exit', 0);
		expect(cleanup).toHaveBeenCalledOnce();
	});
});
