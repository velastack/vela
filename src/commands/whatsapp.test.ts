import { beforeEach, describe, expect, test, vi } from 'vitest';

const runPattern = vi.fn();
vi.mock('../lib/pattern-runner.ts', () => ({
	runPattern: (...args: unknown[]) => runPattern(...args)
}));

// Imported on their own, so no parent program and none of its hooks (the
// backend gate) run: these only check what each command hands the pattern.
const { whatsapp: enableWhatsapp } = await import('./enable/whatsapp.ts');
const { whatsapp: disableWhatsapp } = await import('./disable/whatsapp.ts');

describe('whatsapp commands', () => {
	beforeEach(() => {
		runPattern.mockReset();
	});

	test('enable whatsapp runs enable-whatsapp with no argv', async () => {
		await enableWhatsapp.parseAsync([], { from: 'user' });
		expect(runPattern).toHaveBeenCalledOnce();
		expect(runPattern.mock.calls[0][0]).toBe('enable-whatsapp');
		expect(runPattern.mock.calls[0][1]).toEqual([]);
	});

	test('disable whatsapp --yes runs disable-whatsapp without a prompt', async () => {
		await disableWhatsapp.parseAsync(['--yes'], { from: 'user' });
		expect(runPattern).toHaveBeenCalledOnce();
		expect(runPattern.mock.calls[0][0]).toBe('disable-whatsapp');
		// --yes is the command's own option, not forwarded to the pattern
		expect(runPattern.mock.calls[0][1]).toEqual([]);
		expect(runPattern.mock.calls[0][2]).toEqual({ destructive: true });
	});

	// The patterns read no flags, so anything but -y/--yes on disable is a
	// mistake to stop on rather than pass along to be ignored.
	test.each([
		['enable', enableWhatsapp, ['--remote']],
		['disable', disableWhatsapp, ['--yes', '--not-a-flag']]
	] as const)('%s whatsapp refuses an unknown option', async (_family, cmd, argv) => {
		cmd.exitOverride().configureOutput({ writeErr: () => {} });
		await expect(cmd.parseAsync([...argv], { from: 'user' })).rejects.toMatchObject({
			code: 'commander.unknownOption'
		});
		expect(runPattern).not.toHaveBeenCalled();
	});
});
