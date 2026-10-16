/**
 * The local server behind `vela generate migration --ai`: serves the schema
 * editor from @velastack/schema-ui and gives it two routes over a temporary
 * PocketBase, `GET /api/schema` and `POST /api/apply`.
 *
 * Only this machine should be able to drive it. It binds the loopback
 * address, refuses requests whose Host is not its own (DNS rebinding), and
 * every `/api` request must carry the random token the editor was opened
 * with. Without that, any page in the user's browser could write migrations
 * into the project.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
	apply,
	completeSchema,
	diff,
	hasErrors,
	lint,
	plan,
	schemaFromPocketBase,
	type CollectionsClient,
	type Schema
} from '@velastack/schema';

export const TOKEN_HEADER = 'x-vela-schema-token';

export interface SchemaServerOptions {
	/** Collections API of the temporary PocketBase. */
	client: CollectionsClient;
	/** The project's migrations directory, where automigrate writes. */
	migrationsDir: string;
	/** Directory holding the editor's built files; resolved from the UI package when omitted. */
	appDir?: string;
	/** Shown in the editor's title. */
	project?: string;
	/** Called after each successful apply with the files it wrote. */
	onApplied?: (written: string[]) => void;
	host?: string;
}

export interface SchemaServer {
	/** The URL to open; carries the token in its fragment, which never reaches a server log. */
	url: string;
	token: string;
	port: number;
	close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
	'.map': 'application/json'
};

/** Where @velastack/schema-ui keeps the built editor. */
export function resolveAppDir(from: string = import.meta.url): string {
	const require = createRequire(from);
	const pkg = require.resolve('@velastack/schema-ui/package.json');
	return path.join(path.dirname(pkg), 'app');
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify(body));
};

const readBody = (req: http.IncomingMessage, limit = 8 * 1024 * 1024): Promise<string> =>
	new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error('Request body too large'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});

const listMigrations = (dir: string): string[] =>
	fs.existsSync(dir)
		? fs
				.readdirSync(dir)
				.filter((f) => f.endsWith('.js'))
				.sort()
		: [];

export interface HandlerDeps extends Omit<SchemaServerOptions, 'host'> {
	token: string;
	/** `host:port` this server answers as. */
	self: string | (() => string);
}

/**
 * The request handler on its own, so the checks can be tested without a
 * PocketBase: Host must match, `/api` needs the token, `/api/apply` plans
 * from `next` itself and refuses lint errors.
 */
export function createSchemaHandler(deps: HandlerDeps): http.RequestListener {
	const appDir = deps.appDir ?? resolveAppDir();
	let applying = false;

	return async (req, res) => {
		const self = typeof deps.self === 'function' ? deps.self() : deps.self;
		const host = req.headers.host ?? '';
		if (host !== self && host !== self.replace('127.0.0.1', 'localhost')) {
			json(res, 403, { message: 'Forbidden' });
			return;
		}
		const url = new URL(req.url ?? '/', `http://${self}`);

		if (url.pathname.startsWith('/api/')) {
			if (req.headers[TOKEN_HEADER] !== deps.token) {
				json(res, 401, { message: 'Missing or wrong token' });
				return;
			}
			try {
				if (req.method === 'GET' && url.pathname === '/api/schema') {
					const base = schemaFromPocketBase(await deps.client.list());
					json(res, 200, { base, project: deps.project });
					return;
				}
				if (req.method === 'POST' && url.pathname === '/api/apply') {
					if (applying) {
						json(res, 409, { message: 'An apply is already running' });
						return;
					}
					applying = true;
					try {
						const body = JSON.parse(await readBody(req)) as { next?: Schema };
						if (!body.next || !Array.isArray(body.next.collections)) {
							json(res, 400, { message: 'Expected { next: Schema }' });
							return;
						}
						const base = schemaFromPocketBase(await deps.client.list());
						const next = completeSchema(body.next, base);
						const changes = diff(base, next);
						const issues = lint(base, next, changes);
						if (hasErrors(issues)) {
							json(res, 400, { issues });
							return;
						}
						const steps = plan(base, next, changes);
						const before = listMigrations(deps.migrationsDir);
						const result = await apply(deps.client, steps);
						const written = listMigrations(deps.migrationsDir).filter((f) => !before.includes(f));
						if (written.length > 0) deps.onApplied?.(written);
						const after = schemaFromPocketBase(await deps.client.list());
						const describe = (step: (typeof steps.steps)[number]) => ({
							phase: step.phase,
							kind: step.kind,
							name: step.name
						});
						json(res, 200, {
							base: after,
							applied: result.results.map((r) => describe(r.step)),
							written,
							...(result.failed
								? {
										failed: {
											step: describe(result.failed.step),
											message:
												result.failed.error instanceof Error
													? result.failed.error.message
													: String(result.failed.error)
										}
									}
								: {})
						});
						return;
					} finally {
						applying = false;
					}
				}
				json(res, 404, { message: 'Not found' });
			} catch (error) {
				json(res, 500, { message: error instanceof Error ? error.message : String(error) });
			}
			return;
		}

		if (req.method !== 'GET' && req.method !== 'HEAD') {
			json(res, 405, { message: 'Method not allowed' });
			return;
		}
		// Static files; anything without an extension is the SPA shell.
		const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
		const candidate = path.normalize(path.join(appDir, relative));
		const inside = candidate.startsWith(appDir + path.sep) || candidate === appDir;
		const file =
			inside && relative && path.extname(relative) && fs.existsSync(candidate)
				? candidate
				: path.join(appDir, 'index.html');
		if (!fs.existsSync(file)) {
			json(res, 404, { message: 'Editor files not found; is @velastack/schema-ui installed?' });
			return;
		}
		res.writeHead(200, {
			'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
			'cache-control': 'no-store'
		});
		if (req.method === 'HEAD') {
			res.end();
			return;
		}
		fs.createReadStream(file).pipe(res);
	};
}

export async function startSchemaServer(options: SchemaServerOptions): Promise<SchemaServer> {
	const host = options.host ?? '127.0.0.1';
	const token = crypto.randomBytes(16).toString('hex');
	let port = 0;
	const handler = createSchemaHandler({
		...options,
		token,
		self: () => `${host}:${port}`
	});
	const server = http.createServer((req, res) => {
		void handler(req, res);
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, host, () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Could not determine the port');
	port = address.port;
	return {
		url: `http://${host}:${port}/#token=${token}`,
		token,
		port,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			})
	};
}
