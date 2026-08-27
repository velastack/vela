import fs from 'node:fs';
import path from 'node:path';

export interface ProjectConfig {
	projectId: string;
	teamId: string;
	projectName: string;
}

export function projectConfigPath(workspaceRootDir: string): string {
	return path.join(workspaceRootDir, '.vela', 'project.json');
}

export function readProjectConfig(workspaceRootDir: string): ProjectConfig | null {
	const file = projectConfigPath(workspaceRootDir);
	if (!fs.existsSync(file)) return null;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ProjectConfig>;
		if (
			typeof parsed.projectId !== 'string' ||
			typeof parsed.teamId !== 'string' ||
			typeof parsed.projectName !== 'string'
		) {
			return null;
		}
		return {
			projectId: parsed.projectId,
			teamId: parsed.teamId,
			projectName: parsed.projectName
		};
	} catch {
		return null;
	}
}

/**
 * Record the velastack.dev link, keeping everything else in the file.
 *
 * `.vela/project.json` is written by two modules: this one for the link, and
 * `deploy-config.ts` for the app id and target bindings. Replacing the file
 * wholesale here would drop the app id — which server paths, systemd units and
 * databases all hang off — and strand the deployment on the server.
 */
export function writeProjectConfig(workspaceRootDir: string, config: ProjectConfig): void {
	const file = projectConfigPath(workspaceRootDir);
	fs.mkdirSync(path.dirname(file), { recursive: true });

	let existing: Record<string, unknown> = {};
	if (fs.existsSync(file)) {
		try {
			existing = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
		} catch {
			// A corrupt file is replaced rather than merged into.
		}
	}

	fs.writeFileSync(file, JSON.stringify({ ...existing, ...config }, null, 2) + '\n');
}
