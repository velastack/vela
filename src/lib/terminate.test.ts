import process from 'node:process';
import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { x } from 'tinyexec';
import { onTerminate, stopChild } from './terminate.ts';

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

describe('stopChild', () => {
	function fakeChild(state: {
		pid?: number;
		exitCode?: number | null;
		signalCode?: NodeJS.Signals | null;
	}) {
		return {
			pid: state.pid,
			exitCode: state.exitCode ?? null,
			signalCode: state.signalCode ?? null,
			kill: vi.fn(() => true)
		};
	}

	test('kills a child that is still running', () => {
		const child = fakeChild({ pid: 123 });
		stopChild(child);
		expect(child.kill).toHaveBeenCalledOnce();
	});

	test('leaves alone a child that never started or has already ended', () => {
		const never = fakeChild({});
		const exited = fakeChild({ pid: 123, exitCode: 0 });
		const killed = fakeChild({ pid: 123, signalCode: 'SIGTERM' });
		stopChild(undefined);
		stopChild(never);
		stopChild(exited);
		stopChild(killed);
		expect(never.kill).not.toHaveBeenCalled();
		expect(exited.kill).not.toHaveBeenCalled();
		expect(killed.kill).not.toHaveBeenCalled();
	});

	test('stops a real child spawned the way vela runs vite', async () => {
		const run = x(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
		const child = run.process;
		expect(child?.pid).toBeTypeOf('number');
		stopChild(child);
		await run;
		expect(child?.signalCode).toBe('SIGTERM');
	});
});
