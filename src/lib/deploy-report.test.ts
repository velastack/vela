import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.ts', () => ({
	readApiKey: () => 'key'
}));
vi.mock('./project-config.ts', () => ({
	readProjectConfig: () => ({ projectId: 'p1', projectName: 'app' })
}));
const warn = vi.fn();
vi.mock('@clack/prompts', () => ({ log: { warn: (...args: unknown[]) => warn(...args) } }));
const destroyEnvironment = vi.fn();
vi.mock('./velastack-api.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('./velastack-api.ts')>()),
	destroyEnvironment: (...args: unknown[]) => destroyEnvironment(...args)
}));

import { ApiError } from './velastack-api.ts';
import { reportEnvironmentDestroyed } from './deploy-report.ts';

describe('reportEnvironmentDestroyed', () => {
	beforeEach(() => {
		warn.mockReset();
		destroyEnvironment.mockReset();
	});

	it('retires the environment', async () => {
		destroyEnvironment.mockResolvedValue({ envTag: 'preview--x', status: 'destroyed' });
		await reportEnvironmentDestroyed('/w', 'preview--x');
		expect(destroyEnvironment).toHaveBeenCalledWith('key', 'p1', 'preview--x');
		expect(warn).not.toHaveBeenCalled();
	});

	it('warns when there was no environment to retire', async () => {
		destroyEnvironment.mockRejectedValue(new ApiError(404, 'environment not found'));
		await reportEnvironmentDestroyed('/w', 'preview--x');
		expect(warn).toHaveBeenCalledOnce();
	});

	it('stays quiet about a missing environment with missingOk', async () => {
		destroyEnvironment.mockRejectedValue(new ApiError(404, 'environment not found'));
		await reportEnvironmentDestroyed('/w', 'preview--x', { missingOk: true });
		expect(warn).not.toHaveBeenCalled();
	});

	it('still warns about any other failure with missingOk', async () => {
		destroyEnvironment.mockRejectedValue(new ApiError(500, 'boom'));
		await reportEnvironmentDestroyed('/w', 'preview--x', { missingOk: true });
		expect(warn).toHaveBeenCalledOnce();
	});
});
