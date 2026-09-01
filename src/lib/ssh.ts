import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { spawn, type StdioOptions } from 'node:child_process';

export interface SshOptions {
	/** Extra identity file, for CI where there is no ~/.ssh/config entry. */
	identityFile?: string;
	port?: number;
	/** Skip host key prompts. CI sets this after seeding known_hosts itself. */
	acceptNewHostKeys?: boolean;
}

/**
 * Whether remote work has to be wrapped in `sudo`. Set once per session after
 * looking at the remote uid, so a `root` alias never pays for sudo and a
 * non-root alias fails early and clearly if it cannot escalate.
 */
export type Elevation = 'none' | 'sudo';

export interface RunOptions {
	/** Stream stdout/stderr to the terminal instead of capturing it. */
	stream?: boolean;
	/** Throw when the remote command exits non-zero. Defaults to true. */
	check?: boolean;
	/** Positional arguments passed to the script as `$1`, `$2`, ... */
	args?: string[];
}

export interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export class RemoteCommandError extends Error {
	exitCode: number;
	stdout: string;
	stderr: string;

	constructor(message: string, result: RunResult) {
		super(message);
		this.name = 'RemoteCommandError';
		this.exitCode = result.exitCode;
		this.stdout = result.stdout;
		this.stderr = result.stderr;
	}
}

/**
 * A connection to one server, multiplexed over a single OpenSSH ControlMaster
 * socket. Everything the CLI does remotely goes through `script()`, which pipes
 * a bash program over stdin — nothing user-supplied ever reaches a remote shell
 * as a concatenated string, and secrets never appear in the remote process list.
 */
export class SshSession {
	readonly target: string;
	elevation: Elevation = 'none';
	private readonly options: SshOptions;
	private controlPath: string | null = null;

	constructor(target: string, options: SshOptions = {}) {
		this.target = target;
		this.options = options;
	}

	private sshArgs(): string[] {
		const args: string[] = [];
		if (this.controlPath) args.push('-o', `ControlPath=${this.controlPath}`);
		if (this.options.identityFile) {
			args.push('-i', this.options.identityFile, '-o', 'IdentitiesOnly=yes');
		}
		if (this.options.port) args.push('-p', String(this.options.port));
		if (this.options.acceptNewHostKeys) args.push('-o', 'StrictHostKeyChecking=accept-new');
		args.push('-o', 'BatchMode=yes');
		return args;
	}

	/** The `ssh` invocation rsync should use, as a single shell word list. */
	rsyncShell(): string {
		const parts = ['ssh', ...this.sshArgs()];
		return parts.map(shellQuote).join(' ');
	}

	async open(): Promise<void> {
		if (this.controlPath) return;
		const dir = path.join(os.tmpdir(), 'vela-ssh');
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		// Socket paths live under a 104-char limit on macOS, so keep it short.
		const socket = path.join(dir, `${crypto.randomBytes(6).toString('hex')}.sock`);
		this.controlPath = socket;

		const args = [
			...this.sshArgs(),
			'-o',
			'ControlMaster=yes',
			'-o',
			'ControlPersist=60',
			'-N',
			'-f',
			this.target
		];
		const result = await spawnCapture('ssh', args);
		if (result.exitCode !== 0) {
			this.controlPath = null;
			throw new Error(
				`Could not connect to ${this.target} over SSH.\n\n${result.stderr.trim() || result.stdout.trim()}`
			);
		}
	}

	async close(): Promise<void> {
		if (!this.controlPath) return;
		const socket = this.controlPath;
		this.controlPath = null;
		await spawnCapture('ssh', ['-o', `ControlPath=${socket}`, '-O', 'exit', this.target]);
	}

	/**
	 * Run a bash program on the server. The program is piped over stdin, so it can
	 * safely embed anything — quoting, newlines, base64 blobs — and `args` arrive
	 * as ordinary positional parameters.
	 */
	async script(source: string, opts: RunOptions = {}): Promise<RunResult> {
		const shell = this.elevation === 'sudo' ? 'sudo -n bash -s' : 'bash -s';
		// ssh joins its remaining argv with spaces and hands the result to a
		// remote shell, which silently drops empty arguments and splits ones
		// containing spaces. Quoting here means the remote `$@` is exactly what
		// was passed in.
		const remote = [shell, '--', ...(opts.args ?? []).map(shellQuote)].join(' ');
		const args = [...this.sshArgs(), this.target, remote];
		const result = await spawnCapture('ssh', args, {
			stdin: `set -euo pipefail\n${source}`,
			stream: opts.stream
		});
		if (opts.check !== false && result.exitCode !== 0) {
			throw new RemoteCommandError(remoteFailure(this.target, result), result);
		}
		return result;
	}

	/** Attach the terminal to a remote command — used by `vela logs -f`. */
	async interactive(command: string[]): Promise<number> {
		const args = [...this.sshArgs(), '-t', this.target, command.map(shellQuote).join(' ')];
		return await new Promise((resolve) => {
			const child = spawn('ssh', args, { stdio: 'inherit' });
			child.on('close', (code) => resolve(code ?? 1));
		});
	}

	/**
	 * Write a file on the server atomically, with an explicit mode.
	 *
	 * The payload rides inside the piped script as base64, so it never lands in
	 * argv (visible in `ps`) or in a shell history, and binary-unsafe characters
	 * are not an issue.
	 */
	async writeFile(remotePath: string, content: string, mode = '0644'): Promise<void> {
		const payload = Buffer.from(content, 'utf8').toString('base64');
		await this.script(
			`dest="$1"; mode="$2"
mkdir -p "$(dirname "$dest")"
tmp=$(mktemp "$(dirname "$dest")/.vela.XXXXXX")
printf %s ${payload} | base64 -d > "$tmp"
chmod "$mode" "$tmp"
mv -f "$tmp" "$dest"`,
			{ args: [remotePath, mode] }
		);
	}

	/**
	 * Tunnel a local port to a port on the server, through the connection that is
	 * already open. Used to point a local build at the target's database.
	 */
	async forwardLocalPort(localPort: number, remoteHost: string, remotePort: number): Promise<void> {
		if (!this.controlPath) throw new Error('Cannot forward a port without an open session.');
		const spec = `${localPort}:${remoteHost}:${remotePort}`;
		const result = await spawnCapture('ssh', [
			...this.sshArgs(),
			'-O',
			'forward',
			'-L',
			spec,
			this.target
		]);
		if (result.exitCode !== 0) {
			throw new Error(
				`Could not forward port ${spec} to ${this.target}.\n\n${result.stderr.trim()}`
			);
		}
	}

	async cancelForward(localPort: number, remoteHost: string, remotePort: number): Promise<void> {
		if (!this.controlPath) return;
		await spawnCapture('ssh', [
			...this.sshArgs(),
			'-O',
			'cancel',
			'-L',
			`${localPort}:${remoteHost}:${remotePort}`,
			this.target
		]);
	}

	async readFile(remotePath: string): Promise<string | null> {
		const result = await this.script(`cat "$1" 2>/dev/null || exit 44`, {
			args: [remotePath],
			check: false
		});
		if (result.exitCode === 44) return null;
		if (result.exitCode !== 0)
			throw new RemoteCommandError(remoteFailure(this.target, result), result);
		return result.stdout;
	}

	/** rsync a local directory (contents) into a remote directory. */
	async uploadDir(localDir: string, remoteDir: string, extraArgs: string[] = []): Promise<void> {
		const src = localDir.endsWith('/') ? localDir : `${localDir}/`;
		const args = [
			'-az',
			'--delete',
			'-e',
			this.rsyncShell(),
			...this.rsyncPath(),
			...extraArgs,
			src,
			`${this.target}:${remoteDir}`
		];
		const result = await spawnCapture('rsync', args);
		if (result.exitCode !== 0) {
			throw new Error(`rsync to ${this.target}:${remoteDir} failed.\n\n${result.stderr.trim()}`);
		}
	}

	private rsyncPath(): string[] {
		return this.elevation === 'sudo' ? ['--rsync-path=sudo -n rsync'] : [];
	}

	/**
	 * rsync one remote path down to a local one.
	 *
	 * No `-z`: the only thing this moves is a backup archive, which is already
	 * compressed, and asking gzip to compress a zip costs CPU on both ends for
	 * nothing. `--partial` keeps what arrived when a large transfer is
	 * interrupted, so retrying resumes rather than starting over.
	 *
	 * The remote path reaches rsync through a login shell, so it is quoted here
	 * even though the paths this is called with are vela's own.
	 */
	async download(remotePath: string, localPath: string, extraArgs: string[] = []): Promise<void> {
		const args = [
			'-a',
			'--partial',
			'-e',
			this.rsyncShell(),
			...this.rsyncPath(),
			...extraArgs,
			`${this.target}:${shellQuote(remotePath)}`,
			localPath
		];
		const result = await spawnCapture('rsync', args);
		if (result.exitCode !== 0) {
			throw new Error(`rsync from ${this.target}:${remotePath} failed.\n\n${result.stderr.trim()}`);
		}
	}

	/** rsync one or more local paths to a remote directory. */
	async upload(localPaths: string[], remoteDir: string, extraArgs: string[] = []): Promise<void> {
		const args = [
			'-az',
			'-e',
			this.rsyncShell(),
			...this.rsyncPath(),
			...extraArgs,
			...localPaths,
			`${this.target}:${remoteDir}`
		];
		const result = await spawnCapture('rsync', args);
		if (result.exitCode !== 0) {
			throw new Error(`rsync to ${this.target}:${remoteDir} failed.\n\n${result.stderr.trim()}`);
		}
	}

	/**
	 * Decide once whether remote commands need `sudo`, and fail with something
	 * actionable if they do but cannot get it.
	 */
	async detectElevation(): Promise<Elevation> {
		const uid = await this.script('id -u', { check: false });
		if (uid.stdout.trim() === '0') {
			this.elevation = 'none';
			return this.elevation;
		}
		const sudo = await this.script('sudo -n true', { check: false });
		if (sudo.exitCode !== 0) {
			throw new Error(
				`${this.target} connects as a non-root user without passwordless sudo.\n\n` +
					`Use an SSH target that logs in as root, or give the user NOPASSWD sudo.`
			);
		}
		this.elevation = 'sudo';
		return this.elevation;
	}
}

function remoteFailure(target: string, result: RunResult): string {
	const detail = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-12).join('\n');
	return `Remote command failed on ${target} (exit ${result.exitCode}).\n\n${detail}`;
}

export async function withSsh<T>(
	target: string,
	options: SshOptions,
	fn: (session: SshSession) => Promise<T>
): Promise<T> {
	const session = new SshSession(target, options);
	await session.open();
	try {
		return await fn(session);
	} finally {
		await session.close();
	}
}

export function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface SpawnOptions {
	stdin?: string;
	/**
	 * Show the child's stderr as it arrives. stdout stays captured either way:
	 * the server scripts put progress on stderr and their machine-readable
	 * result on stdout, so the user sees one and the CLI parses the other.
	 */
	stream?: boolean;
	/** Also echo stdout — for local builds, where stdout is the interesting half. */
	streamStdout?: boolean;
	cwd?: string;
	/** Extra environment for the child, merged over the current process env. */
	env?: Record<string, string | undefined>;
}

export function spawnCapture(
	command: string,
	args: string[],
	opts: SpawnOptions = {}
): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const stdio: StdioOptions = [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'];
		const child = spawn(command, args, {
			stdio,
			cwd: opts.cwd,
			env: opts.env ? { ...process.env, ...opts.env } : undefined
		});
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (chunk) => {
			stdout += chunk;
			if (opts.streamStdout) process.stdout.write(chunk);
		});
		child.stderr?.on('data', (chunk) => {
			stderr += chunk;
			if (opts.stream) process.stderr.write(chunk);
		});
		child.on('error', reject);
		child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
		if (opts.stdin !== undefined) {
			child.stdin!.end(opts.stdin);
		}
	});
}
