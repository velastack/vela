import process from 'node:process';
import * as p from '@clack/prompts';

export interface TaskLog {
	/** A line of progress, or with `raw` a chunk of a child process's output. */
	message(text: string, options?: { raw?: boolean }): void;
	success(message: string): void;
	error(message: string): void;
}

export interface TaskLogOptions {
	title: string;
	/** On a terminal, show only the last half screen of output while the task runs. */
	halfScreen?: boolean;
	spacing?: number;
	retainLog?: boolean;
}

/** How much of the buffered output is printed when a task fails off a terminal. */
export const ERROR_TAIL_LINES = 40;

/** Whether the live, self-erasing task log can be drawn. */
export function isLiveTerminal(): boolean {
	return Boolean(process.stdout.isTTY) && !process.env.CI;
}

/**
 * A task with streaming output: clack's `taskLog` on a terminal, plain lines
 * anywhere else.
 *
 * clack redraws by writing erase sequences on every chunk whether or not
 * stdout is a terminal, and its `limit` comes out as NaN when there are no
 * rows to measure, so the buffer never trims and a piped install prints
 * kilobytes of `\x1b[2K\x1b[1A`. Off a terminal (or under `CI`) the title is
 * printed once, the output is held back, and the end prints the success line,
 * or the last lines of the output and the error line.
 */
export function taskLog(options: TaskLogOptions, live: boolean = isLiveTerminal()): TaskLog {
	if (live) {
		const { halfScreen, ...rest } = options;
		return p.taskLog({
			...rest,
			...(halfScreen ? { limit: Math.ceil((process.stdout.rows ?? 24) / 2) } : {})
		});
	}

	p.log.step(options.title);
	let buffer = '';
	return {
		message(text, { raw = false } = {}) {
			buffer += raw ? text : `${text}\n`;
			// Only the tail is ever printed; do not hold a whole install log.
			if (buffer.length > 200_000) buffer = buffer.slice(-100_000);
		},
		success(message) {
			p.log.success(message);
		},
		error(message) {
			const tail = outputTail(buffer);
			if (tail) p.log.message(tail);
			p.log.error(message);
		}
	};
}

/** The last lines of a task's output, without the escape sequences a child wrote. */
export function outputTail(buffer: string, lines: number = ERROR_TAIL_LINES): string {
	return (
		buffer
			// eslint-disable-next-line no-control-regex
			.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
			.split(/\r?\n|\r/)
			.map((line) => line.trimEnd())
			.filter((line) => line.length > 0)
			.slice(-lines)
			.join('\n')
	);
}
