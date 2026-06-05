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

export function writeProjectConfig(workspaceRootDir: string, config: ProjectConfig): void {
	const file = projectConfigPath(workspaceRootDir);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}
