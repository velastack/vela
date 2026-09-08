import process from 'node:process';

export const DATA_DIR = 'data';
export const MIGRATIONS_DIR = 'migrations';
export const PUBLIC_DIR = '(public)';
export const APP_DIR = '(app)';
export const LEGAL_DIR = '(legal)';
// Overridable so the CLI can be pointed at a dashboard running locally while
// the two are developed together; nothing else should ever set it.
export const API_URL = (process.env.VELA_API_URL?.trim() || 'https://velastack.dev').replace(
	/\/$/,
	''
);
export const FIXTURE_PREFIX = 'vela';
// The registry `vela create` reads themed templates from. Overridable so a
// templates checkout can be exercised from `file://` or a local server.
export const TEMPLATE_INDEX_URL =
	process.env.VELA_TEMPLATE_INDEX_URL?.trim() || 'https://templates.velastack.app/index.json';
