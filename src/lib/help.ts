import pc from 'picocolors';
import type { Argument, HelpConfiguration, Option } from 'commander';

const NO_PREFIX = '--no-';
let currentOptions: readonly Option[] = [];

function getLongFlag(flags: string) {
	return flags
		.split(',')
		.map((f) => f.trim())
		.find((f) => f.startsWith('--'));
}

function formatDescription(arg: Option | Argument): string {
	let output = arg.description;
	if (arg.defaultValue !== undefined && String(arg.defaultValue)) {
		output += pc.dim(` (default: ${JSON.stringify(arg.defaultValue)})`);
	}
	if (arg.argChoices !== undefined && String(arg.argChoices)) {
		output += pc.dim(` (choices: ${arg.argChoices.join(', ')})`);
	}
	return output;
}

export const helpConfig: HelpConfiguration = {
	argumentDescription: formatDescription,
	optionDescription: formatDescription,
	visibleOptions(cmd) {
		currentOptions = cmd.options;

		const visible = cmd.options.filter((o) => !o.hidden);
		const show: Option[] = [];
		for (const option of visible) {
			const flag = getLongFlag(option.flags);
			if (flag?.startsWith(NO_PREFIX)) {
				const stripped = flag.slice(NO_PREFIX.length);
				const isNoVariant = visible.some((o) => getLongFlag(o.flags)?.startsWith(`--${stripped}`));
				if (isNoVariant) continue;
			}
			show.push(option);
		}
		return show;
	},
	subcommandTerm: (cmd) => {
		return cmd.name() + ' ' + cmd.usage().replace(/\[options\]\s?/, '');
	},
	optionTerm(option) {
		const longFlag = getLongFlag(option.flags);
		const flag = longFlag?.split(' ').at(0);
		if (!flag || !longFlag) return option.flags;

		const noVariant = `--no-${flag.slice(2)}`;
		const hasVariant = currentOptions.some((o) => getLongFlag(o.flags) === noVariant);
		if (hasVariant) {
			return `--[no-]${longFlag.slice(2)}`;
		}

		return option.flags;
	},
	styleTitle: (str) => pc.underline(str),
	styleCommandText: (str) => pc.redBright(str),
	styleDescriptionText: (str) => pc.gray(str),
	styleOptionText: (str) => pc.white(str),
	styleArgumentText: (str) => pc.white(str),
	styleSubcommandText: (str) => pc.redBright(str)
};
