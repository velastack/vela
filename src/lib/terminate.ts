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

interface ChildLike {
	readonly pid?: number;
	readonly exitCode: number | null;
	readonly signalCode: NodeJS.Signals | null;
	kill(signal?: NodeJS.Signals): boolean;
}

/**
 * Stop a child process that is still running. One that never started, or has
 * already exited, is left alone.
 *
 * A supervisor's SIGTERM reaches the vela process only, not the children it
 * spawned (a terminal's Ctrl-C signals the whole process group, which is why
 * this goes unnoticed there). A child not stopped here outlives vela: `vite
 * preview` kept its port after `vela preview` was stopped.
 */
export function stopChild(child: ChildLike | undefined): void {
	if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill();
}
