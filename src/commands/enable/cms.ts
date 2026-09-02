import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';

const EDITABLE = 'Wrap page copy in `<CmsText>` and images in `<CmsImage>` to make them editable.';

/**
 * Without `--endpoint`, an app with a backend hosts the CMS itself. With it,
 * the app reads from a hosted CMS and the admin bar signs in there — the only
 * shape a static site can use, since it has no server for the backend. The
 * pattern decides, and says so when a static site is missing the flag.
 */
export const cms = new Command('cms')
	.description('enable an inline-editing CMS with an admin bar')
	.option(
		'--endpoint <url>',
		'read from a hosted CMS at this URL instead of running the backend in the app — required for a static site'
	)
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action((options: { endpoint?: string }, cmd) =>
		runCommand(
			() =>
				runPattern(
					'enable-cms',
					cmd.args,
					{ endpoint: options.endpoint },
					{
						summary: 'Enabled CMS.',
						nextSteps: options.endpoint
							? [
									'Run `vela dev`, open any page with `?edit` on the URL, and sign in with an editor of the hosted CMS.',
									EDITABLE,
									'Run `vela build` to prerender the published content and download its media.'
								]
							: [
									'Run `vela cms editor add you@example.com` to create the first editor login.',
									'Run `vela dev`, open any page with `?edit` on the URL, and sign in from the admin bar.',
									EDITABLE
								],
						task: {
							title: 'Enabling CMS',
							success: 'Enabled CMS',
							error: 'Failed to enable CMS'
						}
					}
				),
			'Failed to enable CMS.'
		)
	);
