import process from 'node:process';
import * as p from '@clack/prompts';

export const sharedFields = {
	websiteUrl: () =>
		p.text({
			message: 'What is your website URL?',
			placeholder: 'http://www.mysite.com',
			validate: (value: string | undefined) => {
				if (!value || !value.startsWith('http')) {
					return 'Please enter a valid URL starting with http or https';
				}
			}
		}),
	websiteName: () =>
		p.text({
			message: 'What is your website name?',
			placeholder: 'My Site',
			validate: (value: string | undefined) => {
				if (!value) {
					return 'Please enter a website name';
				}
			}
		}),
	entityType: () =>
		p.select({
			message: 'Entity type',
			options: [
				{
					value: 'business',
					label: "I'm a Business",
					hint: 'e.g. Corporation, Limited Liability Company, Non-profit, Partnership, Sole Proprietor'
				},
				{ value: 'individual', label: "I'm an Individual" }
			]
		}),
	businessName: ({ results }: { results: { entityType?: 'business' | 'individual' } }) =>
		results?.entityType === 'business'
			? p.text({
					message: 'What is the name of the business?',
					placeholder: 'My Company LLC',
					validate: (value: string | undefined) => {
						if (!value) {
							return 'Please enter a business name';
						}
					}
				})
			: undefined,
	businessAddress: ({ results }: { results: { entityType?: 'business' | 'individual' } }) =>
		results?.entityType === 'business'
			? p.text({
					message: 'What is the address of the business?',
					placeholder: '1 Cupertino, CA 95014',
					validate: (value: string | undefined) => {
						if (!value) {
							return 'Please enter a business address';
						}
					}
				})
			: undefined,
	country: () =>
		p.text({
			message: 'Enter the country',
			validate: (value: string | undefined) => {
				if (!value) {
					return 'Please enter a country';
				}
			}
		}),
	state: () =>
		p.text({
			message: 'Enter the state',
			validate: (value: string | undefined) => {
				if (!value) {
					return 'Please enter a state';
				}
			}
		})
};

export const onCancel = () => {
	p.cancel('Operation cancelled.');
	process.exit(0);
};

export async function contactMethods(type: 'terms' | 'privacy'): Promise<{
	methods: Array<'email' | 'page' | 'phone' | 'mail'>;
	details: Record<string, string>;
}> {
	const selection = await p.multiselect({
		message: `How can users contact you for any questions regarding your ${type === 'privacy' ? 'Privacy Policy' : 'Terms & Conditions'}? Check all that apply`,
		options: [
			{ value: 'email', label: 'By email' },
			{ value: 'page', label: 'By visiting a page on our website' },
			{ value: 'phone', label: 'By phone number' },
			{ value: 'mail', label: 'By sending post mail' }
		]
	});

	if (p.isCancel(selection)) onCancel();

	const contact = selection as Array<'email' | 'page' | 'phone' | 'mail'>;
	const details: Record<string, string> = {};

	if (contact.includes('email')) {
		const email = await p.text({
			message: "What's the email?",
			placeholder: 'office@mycompany.com',
			validate: (value: string | undefined) => {
				if (!value) {
					return 'Please enter an email address';
				}
			}
		});
		if (p.isCancel(email)) onCancel();
		details.email = email as string;
	}
	if (contact.includes('page')) {
		const page = await p.text({
			message: "What's the link?",
			placeholder: 'http://www.mycompany.com/contact',
			validate: (value: string | undefined) => {
				if (!value) {
					return 'Please enter a link';
				}
			}
		});
		if (p.isCancel(page)) onCancel();
		details.page = page as string;
	}
	if (contact.includes('phone')) {
		const phone = await p.text({
			message: "What's the phone number?",
			placeholder: '408.996.1010',
			validate: (value: string | undefined) => {
				if (!value) {
					return 'Please enter a phone number';
				}
			}
		});
		if (p.isCancel(phone)) onCancel();
		details.phone = phone as string;
	}
	if (contact.includes('mail')) {
		const address = await p.text({
			message: "What's the address?",
			placeholder: '767 Fifth Avenue New York, NY 10153, United States',
			validate: (value: string | undefined) => {
				if (!value) {
					return 'Please enter an address';
				}
			}
		});
		if (p.isCancel(address)) onCancel();
		details.address = address as string;
	}

	return { methods: contact, details };
}

export const escapeHtml = (value: unknown) =>
	String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');

export type LegalCoreAnswers = {
	websiteUrl: string;
	websiteName: string;
	entityType: 'business' | 'individual';
	businessName?: string;
	businessAddress?: string;
	country: string;
	state: string;
};

export const applyTypography = (html: string) =>
	html
		.replaceAll('<p>', '<p class="text-base leading-7">')
		.replaceAll('<ul>', '<ul class="list-disc pl-6 space-y-1 text-base leading-7">')
		.replaceAll('<h3>', '<h3 class="text-lg font-semibold">')
		.replaceAll('<h4>', '<h4 class="font-semibold">');

export const list = (items: string[]) =>
	items.length
		? `<ul class="list-disc pl-6 space-y-1 text-base leading-7">${items
				.map((i) => `<li>${i}</li>`)
				.join('')}</ul>`
		: '';

export const titledSection = (title: string, body: string) =>
	body
		? `<section class="space-y-3"><h2 class="text-xl font-semibold">${escapeHtml(
				title
			)}</h2>${applyTypography(body)}</section>`
		: '';

export const subSection = (title: string, body: string) =>
	body
		? `<div class="space-y-2"><h3 class="text-lg font-semibold">${escapeHtml(
				title
			)}</h3>${applyTypography(body)}</div>`
		: '';

const jsString = (s: string) =>
	`'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;

export const pageMetaTagsLoader = (title: string, description: string) =>
	`import { definePageMetaTags } from 'svelte-meta-tags';

export const load = async ({ parent }) => {
\tawait parent();

\tconst { pageMetaTags } = definePageMetaTags({
\t\ttitle: ${jsString(title)},
\t\tdescription: ${jsString(description)}
\t});

\treturn { pageMetaTags };
};
`;

export const ccpaCategoriesTable = (collected: {
	identifiers: boolean;
	customerRecords: boolean;
	commercialInfo: boolean;
	internetActivity: boolean;
	geolocation: boolean;
	sensitive: boolean;
}) => {
	const rows: Array<[string, string, boolean]> = [
		[
			'A. Identifiers',
			'A real name, alias, postal address, unique personal identifier, online identifier, IP address, email address, account name, or similar identifiers.',
			collected.identifiers
		],
		[
			'B. Personal information categories listed in the California Customer Records statute (Cal. Civ. Code § 1798.80(e))',
			'A name, signature, address, telephone number, education, employment, employment history, financial information, or similar information. Some personal information included in this category may overlap with other categories.',
			collected.customerRecords
		],
		[
			'C. Protected classification characteristics under California or federal law',
			'Age, race, color, ancestry, national origin, citizenship, religion, marital status, sex (including gender identity, gender expression), sexual orientation, veteran or military status, genetic information, or disability.',
			false
		],
		[
			'D. Commercial information',
			'Records and history of products or services purchased or considered.',
			collected.commercialInfo
		],
		[
			'E. Biometric information',
			'Genetic, physiological, behavioral, and biological characteristics.',
			false
		],
		[
			'F. Internet or other similar network activity',
			'Browsing history, search history, interaction with our Service, advertisements, or other websites.',
			collected.internetActivity
		],
		['G. Geolocation data', 'Approximate physical location.', collected.geolocation],
		[
			'H. Sensory data',
			'Audio, electronic, visual, thermal, olfactory, or similar information.',
			false
		],
		[
			'I. Professional or employment-related information',
			'Current or past job history or performance evaluations.',
			false
		],
		[
			'J. Non-public education information',
			'Education records directly related to a student maintained by an educational institution or party acting on its behalf, such as grades, transcripts, class lists, schedules, identification codes, financial information, or disciplinary records.',
			false
		],
		[
			'K. Inferences drawn from other personal information',
			'Profile reflecting a person’s preferences, characteristics, predispositions, behavior, attitudes, intelligence, abilities, and aptitudes.',
			collected.internetActivity
		]
	];
	const items = rows.map(
		([cat, desc, yes]) =>
			`<li><p class="text-base leading-7"><strong>${escapeHtml(cat)}</strong> &mdash; ${escapeHtml(
				desc
			)} <em>Collected: ${yes ? 'Yes' : 'No'}.</em></p></li>`
	);
	let body = `<p class="text-base leading-7">In the past twelve (12) months, we may have collected the following categories of personal information:</p><ul class="list-disc pl-6 space-y-1 text-base leading-7">${items.join('')}</ul>`;
	if (collected.sensitive) {
		body += `<p class="text-base leading-7"><strong>Sensitive Personal Information.</strong> We may collect a limited subset of sensitive personal information (such as account log-in credentials in combination with required security or access codes) as defined by the California Privacy Rights Act ("CPRA"). We do not use or disclose sensitive personal information for purposes other than those permitted under Cal. Civ. Code § 1798.121.</p>`;
	}
	return body;
};

export const legalBasesBlock = () =>
	`<p class="text-base leading-7">If you are a resident of the European Economic Area ("EEA"), the United Kingdom, or Switzerland, our legal basis for collecting and using the personal information described in this Privacy Policy depends on the personal information we collect and the specific context in which we collect it. We may process your personal information because:</p><ul class="list-disc pl-6 space-y-1 text-base leading-7"><li><p class="text-base leading-7"><strong>Performance of a contract:</strong> processing is necessary to perform a contract with you or to take steps at your request before entering into a contract (Article 6(1)(b) GDPR).</p></li><li><p class="text-base leading-7"><strong>Legitimate interests:</strong> processing is necessary for our legitimate interests or those of a third party, provided your interests and fundamental rights do not override those interests (Article 6(1)(f) GDPR). Our legitimate interests include securing the Service, preventing fraud, improving the Service, and direct marketing where permitted.</p></li><li><p class="text-base leading-7"><strong>Compliance with legal obligation:</strong> processing is necessary for compliance with a legal obligation to which we are subject (Article 6(1)(c) GDPR).</p></li><li><p class="text-base leading-7"><strong>Consent:</strong> we have your consent to do so for a specific purpose (Article 6(1)(a) GDPR). You may withdraw consent at any time by contacting us.</p></li><li><p class="text-base leading-7"><strong>Vital interests:</strong> processing is necessary to protect your vital interests or those of another natural person (Article 6(1)(d) GDPR).</p></li><li><p class="text-base leading-7"><strong>Public interest:</strong> processing is necessary for the performance of a task carried out in the public interest (Article 6(1)(e) GDPR).</p></li></ul>`;

export const internationalTransfersBlock = () =>
	`<p class="text-base leading-7">Your information, including personal data, may be processed at our operating offices and in any other places where the parties involved in the processing are located. This means that this information may be transferred to — and maintained on — computers located outside of your state, province, country, or other governmental jurisdiction where the data protection laws may differ from those of your jurisdiction.</p><p class="text-base leading-7">If we transfer personal information from the European Economic Area, the United Kingdom, or Switzerland to a country that has not been determined by the European Commission or the relevant authority to provide an adequate level of protection, we rely on appropriate safeguards. These safeguards include the European Commission’s Standard Contractual Clauses (and the UK International Data Transfer Addendum, where applicable), supplementary technical and organizational measures, and, where appropriate, your explicit consent.</p><p class="text-base leading-7">Your submission of personal information represents your agreement to that transfer. We will take all steps reasonably necessary to ensure that your data is treated securely and in accordance with this Privacy Policy and applicable law.</p>`;

export const usStateRightsBlock = (companyName: string) =>
	`<p class="text-base leading-7">Residents of certain U.S. states (including California, Virginia, Colorado, Connecticut, Utah, Texas, Oregon, and others with comprehensive consumer privacy laws) have specific rights regarding their personal information. Subject to the requirements and exceptions of the applicable law, you may have the right to:</p><ul class="list-disc pl-6 space-y-1 text-base leading-7"><li><p class="text-base leading-7"><strong>Right to know / access:</strong> request that we disclose the categories and specific pieces of personal information we have collected about you, the categories of sources, the business or commercial purpose for collection, and the categories of third parties with whom we share your information.</p></li><li><p class="text-base leading-7"><strong>Right to delete:</strong> request that we delete personal information we have collected from you, subject to certain exceptions.</p></li><li><p class="text-base leading-7"><strong>Right to correct:</strong> request that we correct inaccurate personal information we maintain about you.</p></li><li><p class="text-base leading-7"><strong>Right to opt out of sale or sharing:</strong> opt out of the sale of your personal information or sharing of your personal information for cross-context behavioral advertising.</p></li><li><p class="text-base leading-7"><strong>Right to limit the use of sensitive personal information:</strong> direct us to limit our use and disclosure of sensitive personal information to those uses necessary to perform the services or provide the goods reasonably expected by an average consumer who requests them.</p></li><li><p class="text-base leading-7"><strong>Right to non-discrimination:</strong> not be subjected to discriminatory treatment for exercising your privacy rights.</p></li><li><p class="text-base leading-7"><strong>Right to appeal:</strong> if we deny your request, you may appeal our decision by contacting us. If your appeal is denied, you may contact your state attorney general.</p></li></ul><p class="text-base leading-7"><strong>How to exercise your rights.</strong> You may submit a verifiable consumer request by contacting us using the methods listed in the "Contact Us" section. We will need to verify your identity before responding to your request. You may use an authorized agent to submit a request on your behalf, provided you give the agent written permission and verify your identity directly with us.</p><p class="text-base leading-7"><strong>"Do Not Sell or Share My Personal Information" and Global Privacy Control.</strong> You may opt out of the "sale" or "sharing" of your personal information at any time. We honor opt-out preference signals, including the Global Privacy Control ("GPC"), as a valid request to opt out of sale and sharing for the browser or device on which the signal is detected.</p><p class="text-base leading-7"><strong>California "Shine the Light" (Cal. Civ. Code &sect; 1798.83).</strong> California residents may request information about our disclosures of personal information to third parties for their direct marketing purposes once per calendar year. To make such a request, please contact us using the information in the "Contact Us" section.</p><p class="text-base leading-7"><strong>CalOPPA disclosures.</strong> ${escapeHtml(
		companyName
	)} does not track its users over time and across third-party websites or services. We respond to Do Not Track ("DNT") signals as described above. We will notify users of material changes to this Privacy Policy by posting an updated policy on this page.</p>`;

export const gdprRightsBlock = (
	companyName: string,
	facebookFanPage: { name: string; url: string } | null
) => {
	let body = `<p class="text-base leading-7">If you are a resident of the European Economic Area ("EEA"), the United Kingdom, or Switzerland, you have the following rights under the General Data Protection Regulation ("GDPR") and the UK GDPR:</p><ul class="list-disc pl-6 space-y-1 text-base leading-7"><li><p class="text-base leading-7"><strong>Right of access:</strong> request a copy of the personal data we hold about you and information about how we process it.</p></li><li><p class="text-base leading-7"><strong>Right to rectification:</strong> request that we correct inaccurate or complete incomplete personal data.</p></li><li><p class="text-base leading-7"><strong>Right to erasure ("right to be forgotten"):</strong> request that we delete your personal data, where there is no compelling reason for us to continue processing it.</p></li><li><p class="text-base leading-7"><strong>Right to restrict processing:</strong> request that we restrict the processing of your personal data in certain circumstances.</p></li><li><p class="text-base leading-7"><strong>Right to data portability:</strong> receive the personal data you provided to us in a structured, commonly used, machine-readable format and have it transmitted to another controller.</p></li><li><p class="text-base leading-7"><strong>Right to object:</strong> object to our processing of your personal data based on legitimate interests, including for direct marketing.</p></li><li><p class="text-base leading-7"><strong>Right to withdraw consent:</strong> where processing is based on consent, withdraw that consent at any time without affecting the lawfulness of prior processing.</p></li><li><p class="text-base leading-7"><strong>Right not to be subject to automated decision-making:</strong> not to be subject to a decision based solely on automated processing, including profiling, that produces legal effects concerning you or similarly significantly affects you.</p></li><li><p class="text-base leading-7"><strong>Right to lodge a complaint:</strong> lodge a complaint with the supervisory authority in your country of residence, place of work, or place of the alleged infringement.</p></li></ul><p class="text-base leading-7">To exercise any of these rights, please contact us using the methods listed in the "Contact Us" section. We will respond within one month, subject to any extensions permitted by law.</p>`;
	if (facebookFanPage) {
		const name = escapeHtml(facebookFanPage.name);
		const url = escapeHtml(facebookFanPage.url);
		body += `<p class="text-base leading-7"><strong>Facebook Fan Page — Joint Controller.</strong> ${escapeHtml(
			companyName
		)} operates the Facebook Fan Page${name ? ` "${name}"` : ''}${
			url ? ` at <a href="${url}" rel="external nofollow noopener" target="_blank">${url}</a>` : ''
		}. As a result of the decision of the Court of Justice of the European Union in Case C-210/16, ${escapeHtml(
			companyName
		)} and Meta Platforms Ireland Limited are joint controllers in respect of personal data collected through the Page Insights service. The agreement between the parties governing this joint controllership is available on Meta’s website. You may exercise your rights under the GDPR with either party.</p>`;
	}
	return body;
};

export const arbitrationBlock = (companyName: string, governingLocation: string) =>
	`<p class="text-base leading-7"><strong>Informal resolution first.</strong> Before filing a claim against ${escapeHtml(
		companyName
	)}, you agree to try to resolve the dispute informally by contacting us. We will attempt to resolve the dispute by contacting you via email. If a dispute is not resolved within thirty (30) days of submission, you or ${escapeHtml(
		companyName
	)} may bring a formal proceeding.</p><p class="text-base leading-7"><strong>Binding arbitration.</strong> Except for claims that may be properly brought in a small claims court of competent jurisdiction, all controversies, disputes, or claims arising out of or relating to these Terms or the Service shall be resolved by final and binding arbitration administered by the American Arbitration Association ("AAA") under its applicable rules then in effect (or, for users outside the United States, by an equivalent recognized arbitration body). The arbitration shall take place in ${escapeHtml(
		governingLocation
	)} or, at your election, by telephone or written submissions. The arbitrator’s decision shall be final and binding, and judgment on the award may be entered in any court of competent jurisdiction.</p><p class="text-base leading-7"><strong>Class-action waiver.</strong> You and ${escapeHtml(
		companyName
	)} agree that each may bring claims against the other only in your or its individual capacity and not as a plaintiff or class member in any purported class or representative proceeding. Unless both parties agree otherwise in writing, the arbitrator may not consolidate more than one person’s claims and may not otherwise preside over any form of a representative or class proceeding.</p><p class="text-base leading-7"><strong>Jury trial waiver.</strong> By agreeing to these Terms and to arbitration, you and ${escapeHtml(
		companyName
	)} are each waiving the right to a trial by jury or to participate in a class action.</p><p class="text-base leading-7"><strong>30-day right to opt out.</strong> You may opt out of these arbitration and class-action waiver provisions by sending written notice of your decision to opt out to the contact address listed in the "Contact Us" section, postmarked within thirty (30) days of first accepting these Terms. Your notice must include your name, address, the email associated with your account, and a clear statement that you wish to opt out of arbitration. Opting out will not affect the other terms of this agreement.</p><p class="text-base leading-7"><strong>Severability of class waiver.</strong> If the class-action waiver is found unenforceable in a particular case, then that proceeding shall be severed from any arbitration and brought in a court of competent jurisdiction; the remainder of these arbitration provisions shall continue to apply.</p>`;

export const dmcaBlock = (companyName: string, infringementEmail: string) =>
	`<p class="text-base leading-7">${escapeHtml(
		companyName
	)} respects the intellectual property rights of others and expects users of the Service to do the same. We respond to clear notices of alleged copyright infringement that comply with the U.S. Digital Millennium Copyright Act ("DMCA"), 17 U.S.C. &sect; 512.</p><p class="text-base leading-7"><strong>Submitting a notice of infringement.</strong> If you believe that material on the Service infringes your copyright, please send a written notice to our designated agent at <a href="mailto:${escapeHtml(
		infringementEmail
	)}">${escapeHtml(
		infringementEmail
	)}</a>. To be effective under 17 U.S.C. &sect; 512(c)(3)(A), your notice must include substantially the following:</p><ul class="list-disc pl-6 space-y-1 text-base leading-7"><li><p class="text-base leading-7">A physical or electronic signature of a person authorized to act on behalf of the owner of an exclusive right that is allegedly infringed.</p></li><li><p class="text-base leading-7">Identification of the copyrighted work claimed to have been infringed, or, if multiple copyrighted works are covered by a single notification, a representative list of such works.</p></li><li><p class="text-base leading-7">Identification of the material that is claimed to be infringing or to be the subject of infringing activity, with information reasonably sufficient to permit us to locate the material (such as a URL).</p></li><li><p class="text-base leading-7">Information reasonably sufficient to permit us to contact you, such as an address, telephone number, and an email address.</p></li><li><p class="text-base leading-7">A statement that you have a good-faith belief that use of the material in the manner complained of is not authorized by the copyright owner, its agent, or the law.</p></li><li><p class="text-base leading-7">A statement that the information in the notification is accurate, and under penalty of perjury, that you are authorized to act on behalf of the owner of an exclusive right that is allegedly infringed.</p></li></ul><p class="text-base leading-7"><strong>Counter-notice.</strong> If you believe that your content was removed or disabled by mistake or misidentification, you may submit a written counter-notice to the same address. Under 17 U.S.C. &sect; 512(g)(3), the counter-notice must include your physical or electronic signature, identification of the material removed and its prior location, a statement under penalty of perjury that you have a good-faith belief that the material was removed or disabled as a result of mistake or misidentification, your name, address, telephone number, and a statement that you consent to the jurisdiction of the federal district court for your judicial district (or, if outside the United States, of any judicial district in which we may be found) and that you will accept service of process from the person who provided the original notification or an agent of such person.</p><p class="text-base leading-7"><strong>Repeat infringers.</strong> It is our policy, in appropriate circumstances and at our sole discretion, to disable or terminate the accounts of users who are repeat infringers. Submitting false or misleading notices or counter-notices may result in liability for damages under 17 U.S.C. &sect; 512(f).</p>`;
