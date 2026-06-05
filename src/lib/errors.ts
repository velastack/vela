type Reason = { id: string; reason: string };

export class UnsupportedError extends Error {
	override name = 'Unsupported Environment';
	reasons: Reason[];
	constructor(reasons: Reason[]) {
		super();
		this.reasons = reasons;
	}
}
