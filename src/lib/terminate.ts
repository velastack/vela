import process from 'node:process';

/** The signals that end a command: Ctrl-C, a supervisor's stop, a closed terminal. */
export const TERMINATING_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

type Terminating = (typeof TERMINATING_SIGNALS)[number];

/** Exit codes by convention (128 + the signal number); Ctrl-C has always exited 0 here. */
const EXIT_CODES: Record<Terminating, number> = { SIGINT: 0, SIGTERM: 143, SIGHUP: 129 };

interface ProcessLike {
	on(event: string, listener: (...args: unknown[]) => void): unknown;
	exit(code?: number): never | void;
}

/**
 * Run `cleanup` however the process ends: a normal exit, Ctrl-C, or a SIGTERM
 * or SIGHUP from whatever started it. Node's default for those two signals is
 * to die without running `exit` listeners, which left a child PocketBase
 * running on its port after `vela preview` was stopped by a supervisor.
 */
export function onTerminate(cleanup: () => void, proc: ProcessLike = process): void {
	proc.on('exit', cleanup);
	for (const signal of TERMINATING_SIGNALS) {
		proc.on(signal, () => {
			cleanup();
			proc.exit(EXIT_CODES[signal]);
		});
	}
}
