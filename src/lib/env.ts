import fs from 'node:fs';
import path from 'node:path';

export function addEnvVar(content: string, key: string, value: string): string {
	if (content.includes(`${key}=`)) return content;
	return appendLine(content, `${key}=${value}`);
}

export function addEnvComment(content: string, comment: string): string {
	const commented = `# ${comment}`;
	if (content.includes(commented)) return content;
	return appendLine(content, commented);
}

function appendLine(existing: string, line: string): string {
	const withNewline = !existing.length || existing.endsWith('\n') ? existing : existing + '\n';
	return withNewline + line + '\n';
}

export function writeEnvFile(
	cwd: string,
	vars: Record<string, string>,
	comments: string[] = []
): void {
	const envPath = path.join(cwd, '.env');
	let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
	for (const comment of comments) content = addEnvComment(content, comment);
	for (const [key, value] of Object.entries(vars)) content = addEnvVar(content, key, value);
	fs.writeFileSync(envPath, content);
}
