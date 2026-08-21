import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { LEGAL_DIR } from '../../lib/constants.ts';
import { reportResult } from '../../lib/result-report.ts';
import {
	arbitrationBlock,
	contactMethods,
	dmcaBlock,
	escapeHtml,
	list,
	onCancel,
	pageMetaTagsLoader,
	sharedFields,
	titledSection,
	type LegalCoreAnswers
} from './shared.ts';

type TermsAnswers = {
	core: LegalCoreAnswers;
	accounts: 'yes' | 'no';
	userContent: 'yes' | 'no';
	infringementEmail?: string;
	canBuyGoods: 'yes' | 'no';
	subscriptions: 'yes' | 'no';
	freeTrial?: 'yes' | 'no';
	exclusiveContent: 'yes' | 'no';
	feedbackReuse: 'yes' | 'no';
	promotions: 'yes' | 'no';
	mobileApp: Array<'apple' | 'google'>;
	contact: { methods: string[]; details: Record<string, unknown> };
};

type Computed = {
	companyName: string;
	companyLong: string;
	websiteName: string;
	websiteUrl: string;
	governingLocation: string;
	effectiveDate: string;
};

const compute = (a: TermsAnswers): Computed => {
	const effectiveDate = new Date(Date.now()).toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	});
	const websiteName = a.core?.websiteName ?? 'our website';
	const websiteUrl = a.core?.websiteUrl ?? '';
	const companyName =
		a.core?.entityType === 'business'
			? (a.core?.businessName ?? websiteName)
			: (a.core?.websiteName ?? 'the website owner');
	const companyLong =
		a.core?.entityType === 'business'
			? `${escapeHtml(a.core?.businessName ?? websiteName)}${
					a.core?.businessAddress ? `, ${escapeHtml(a.core?.businessAddress)}` : ''
				}`
			: 'the website owner';
	const governingLocation = `${escapeHtml(a.core?.state ?? '')}${a.core?.state ? ', ' : ''}${escapeHtml(
		a.core?.country ?? ''
	)}`;

	return {
		companyName,
		companyLong,
		websiteName,
		websiteUrl,
		governingLocation,
		effectiveDate
	};
};

const sectionHeader = (c: Computed) =>
	`<section class="space-y-3"><h1 class="text-3xl font-semibold">Terms &amp; Conditions</h1><p class="text-base leading-7">Last updated: ${escapeHtml(
		c.effectiveDate
	)}</p><p class="text-base leading-7">These Terms &amp; Conditions ("Terms") govern your access to and use of ${escapeHtml(
		c.websiteName
	)} (${escapeHtml(c.websiteUrl)}) and any related software, mobile applications, content, products, and services (collectively, the "Service"). The Service is provided by ${
		c.companyLong
	} ("Company", "we", "us", or "our").</p><p class="text-base leading-7">By accessing or using the Service, you agree to be bound by these Terms and our Privacy Policy. If you do not agree to these Terms, you must not access or use the Service. Your continued use of the Service after we post or send a notice about changes to these Terms means you accept and agree to the changes.</p></section>`;

const sectionEligibility = () =>
	titledSection(
		'Eligibility and Age',
		'<p>You must be at least 13 years of age to use the Service (or 16 years of age if you are a resident of the European Economic Area, the United Kingdom, or another jurisdiction whose laws require a higher minimum age). By using the Service, you represent and warrant that you meet the minimum age requirement, that you have the legal capacity to enter into a binding agreement, and that you are not prohibited from receiving the Service under the laws of any applicable jurisdiction.</p><p>If you are using the Service on behalf of a company, organization, or other legal entity, you represent that you are authorized to bind that entity to these Terms, in which case "you" and "your" refer to that entity.</p>'
	);

const sectionDefinitions = (c: Computed) =>
	titledSection(
		'Definitions',
		`<p>The following definitions apply throughout these Terms:</p><ul><li><strong>Service</strong> means ${escapeHtml(
			c.websiteName
		)}, our website at <a href="${escapeHtml(
			c.websiteUrl
		)}" rel="external nofollow noopener" target="_blank">${escapeHtml(
			c.websiteUrl
		)}</a>, and any related applications, software, content, and online services we provide.</li><li><strong>Content</strong> means any information, text, graphics, images, music, audio, video, code, or other material that is made available through the Service, whether by us, our licensors, our users, or third parties.</li><li><strong>User Content</strong> means any Content that you or other users submit, upload, post, transmit, or otherwise make available through the Service.</li><li><strong>You</strong> and <strong>your</strong> refer to the individual or entity that accesses or uses the Service.</li></ul>`
	);

const sectionLicense = () =>
	titledSection(
		'License to Use the Service',
		'<p>Subject to your compliance with these Terms, we grant you a limited, revocable, non-exclusive, non-transferable, non-sublicensable license to access and use the Service for your personal or internal business use. This license does not include any right to: (a) sell, resell, or commercially exploit the Service or its Content; (b) modify, adapt, translate, reverse engineer, decompile, or disassemble any portion of the Service; (c) use the Service or its Content in any manner that infringes our or any third party’s rights; or (d) use any data mining, robots, or similar data gathering or extraction methods. We reserve all rights not expressly granted to you.</p>'
	);

const sectionAccounts = () =>
	titledSection(
		'Accounts',
		'<p>To access certain features of the Service, you may be required to create an account. You agree to provide accurate, complete, and current information at all times and to update your information to keep it accurate, complete, and current. You are responsible for safeguarding your password and for any activities or actions taken under your account, whether or not you have authorized those activities. You agree not to disclose your password to any third party and to notify us immediately upon becoming aware of any breach of security or unauthorized use of your account. We may, in our sole discretion, refuse to grant you an account or suspend or terminate your account at any time.</p>'
	);

const sectionUserContent = () =>
	titledSection(
		'User Content',
		`<p><strong>Your content remains your content.</strong> You retain all rights you have in the User Content you submit, upload, post, transmit, or otherwise make available through the Service. You are solely responsible for your User Content and the consequences of making it available through the Service.</p><p><strong>License to us.</strong> By submitting User Content through the Service, you grant us a worldwide, non-exclusive, royalty-free, fully paid-up, perpetual, irrevocable, sublicensable, and transferable license to use, host, store, cache, reproduce, publish, publicly display, publicly perform, distribute, modify, adapt, translate, and create derivative works of your User Content, solely in connection with operating, providing, promoting, and improving the Service, and to enable our service providers to do the same on our behalf. The license you grant survives termination of these Terms with respect to User Content that has been shared, distributed, or otherwise relied upon by us or third parties before termination.</p><p><strong>Your representations and warranties.</strong> You represent and warrant that: (a) you own or have all necessary rights, licenses, consents, releases, and permissions in your User Content; (b) your User Content does not and will not infringe, misappropriate, or violate any third party’s intellectual property, privacy, publicity, contractual, or other rights, or any applicable law; and (c) your User Content is not unlawful, defamatory, obscene, threatening, harassing, abusive, or otherwise objectionable.</p><p><strong>Right to remove.</strong> We reserve the right, but are not obligated, to review, screen, or remove any User Content at any time, with or without notice, for any reason, including any User Content that we determine, in our sole discretion, violates these Terms or is otherwise objectionable. We are not responsible for any User Content posted by users.</p>`
	);

const sectionDmca = (c: Computed, infringementEmail: string) =>
	titledSection('DMCA Notice and Counter-Notice', dmcaBlock(c.companyName, infringementEmail));

const sectionExclusiveIp = (c: Computed) =>
	titledSection(
		'Intellectual Property of the Company',
		`<p>The Service and its original content (excluding User Content), features, functionality, software, source code, designs, text, graphics, images, logos, trademarks, service marks, trade dress, and trade names are and will remain the exclusive property of ${escapeHtml(
			c.companyName
		)} and its licensors, and are protected by copyright, trademark, and other intellectual property laws. Nothing in these Terms grants you any right or license to use any of our trademarks, service marks, logos, trade names, or trade dress without our prior written permission. All goodwill arising from the use of our trademarks inures to our exclusive benefit.</p>`
	);

const sectionFeedback = () =>
	titledSection(
		'Feedback',
		'<p>If you provide us with any suggestions, ideas, comments, improvements, recommendations, or other feedback regarding the Service ("Feedback"), you grant us a worldwide, perpetual, irrevocable, royalty-free, fully paid-up, sublicensable, and transferable license to use, copy, modify, distribute, and otherwise commercially exploit the Feedback for any purpose, without restriction or compensation to you. You waive any moral rights or similar rights in the Feedback to the maximum extent permitted by applicable law.</p>'
	);

const sectionPurchases = () =>
	titledSection(
		'Purchases and Payments',
		'<p>We may offer goods, items, or services for purchase through the Service. By placing an order, you represent and warrant that you are legally capable of entering into a binding contract and that the information you provide is accurate, current, and complete.</p><p><strong>Pricing and availability.</strong> Prices, features, and availability are subject to change without notice. We reserve the right to refuse or cancel any order at any time for any reason, including suspected fraud, errors in product or pricing information, or unavailability.</p><p><strong>Taxes.</strong> Unless otherwise stated, prices are exclusive of any applicable taxes, duties, or similar governmental assessments. You are responsible for any such taxes associated with your purchase.</p><p><strong>Payment authorization.</strong> By submitting payment information, you authorize us (or our payment processor) to charge the applicable amount to your selected payment method. You agree to keep your payment information current and accurate.</p><p><strong>Refunds.</strong> Refunds, if available, are described at the point of purchase or in our refund policy. Except where required by law, all sales are final.</p>'
	);

const sectionSubscriptions = (a: TermsAnswers) => {
	const bullets: string[] = [];
	if (a.freeTrial === 'yes') {
		bullets.push(
			'<strong>Free trial.</strong> We may offer a free trial for certain subscription plans. If you do not cancel before the end of the free trial, you will be automatically charged for the applicable plan at the then-current rate. We will provide notice before charging your payment method where required by law.'
		);
	}
	bullets.push(
		'<strong>Recurring billing.</strong> Subscriptions are billed in advance on a recurring and periodic basis (such as weekly, monthly, or annually), depending on the plan you select. Each billing period begins on the date your subscription is established or renewed.',
		'<strong>Automatic renewal.</strong> Your subscription will automatically renew at the end of each billing period at the then-current rate, unless you cancel before the end of the current billing period. By starting a subscription, you authorize us to automatically charge your payment method for each renewal until you cancel. This authorization will continue until you cancel.',
		'<strong>Cancellation.</strong> You may cancel your subscription at any time by following the cancellation instructions in your account settings or by contacting us using the methods listed in the "Contact Us" section. Cancellation will take effect at the end of the current billing period; you will continue to have access to the subscription through the end of that period and will not receive a refund for the current period unless required by law.',
		'<strong>Price changes.</strong> We may change subscription fees and the features included in any subscription plan at any time. Where required by law, we will provide reasonable advance notice of any fee changes. If you do not agree to the changes, you may cancel your subscription before the change takes effect.',
		'<strong>Failed payments.</strong> If we are unable to charge your payment method for any reason, we may suspend or terminate your access to the subscription until payment is successfully processed.'
	);
	const autoRenewalNotice = `<p><strong>Auto-renewal disclosure (California, New York, and other states).</strong> In accordance with the California Automatic Renewal Law (Cal. Bus. &amp; Prof. Code &sect; 17600 et seq.), New York General Business Law &sect; 527-a, and similar laws, you acknowledge that your subscription will continue until cancelled, that we will charge the payment method you provided on a recurring basis at the frequency described at the time of purchase, that your subscription will automatically renew unless you cancel, and that you may cancel at any time using the cancellation methods described above.</p>`;
	return titledSection(
		'Subscriptions and Automatic Renewal',
		`<p>Some parts of the Service may be billed on a subscription basis.</p>${list(bullets)}${autoRenewalNotice}`
	);
};

const sectionPromotions = () =>
	titledSection(
		'Promotions',
		'<p>Any promotions, contests, sweepstakes, or similar offerings ("Promotions") made available through the Service may be governed by rules separate from these Terms. If you participate in any Promotion, please review the applicable rules as well as our Privacy Policy. If the rules for a Promotion conflict with these Terms, the Promotion rules will apply.</p>'
	);

const sectionProhibited = () =>
	titledSection(
		'Prohibited Uses',
		`<p>You agree not to use the Service:</p>${list([
			'In any way that violates any applicable national, state, local, or international law or regulation (including, without limitation, any laws regarding the export of data or software to and from the United States or other countries).',
			'For the purpose of exploiting, harming, or attempting to exploit or harm minors in any way by exposing them to inappropriate content, asking for personally identifiable information, or otherwise.',
			'To transmit, or procure the sending of, any advertising or promotional material, including any "junk mail," "chain letter," "spam," or any other similar solicitation, without our prior written consent.',
			'To impersonate or attempt to impersonate the Company, a Company employee, another user, or any other person or entity.',
			'To engage in any other conduct that restricts or inhibits anyone’s use or enjoyment of the Service, or which, as determined by us, may harm the Company or users of the Service or expose them to liability.',
			'To use the Service in any manner that could disable, overburden, damage, or impair the Service or interfere with any other party’s use of the Service.',
			'To use any robot, spider, or other automatic device, process, or means to access the Service for any purpose, including monitoring or copying any of the material on the Service.',
			'To introduce any viruses, Trojan horses, worms, logic bombs, or other material that is malicious or technologically harmful.',
			'To attempt to gain unauthorized access to, interfere with, damage, or disrupt any parts of the Service, the server on which the Service is stored, or any server, computer, or database connected to the Service.',
			'To attack the Service via a denial-of-service attack or a distributed denial-of-service attack.',
			'To otherwise attempt to interfere with the proper working of the Service.'
		])}`
	);

const sectionTermination = () =>
	titledSection(
		'Termination',
		'<p>We may terminate or suspend your account and access to the Service immediately, without prior notice or liability, for any reason, including without limitation if you breach these Terms. Upon termination, your right to use the Service will cease immediately. If you wish to terminate your account, you may simply discontinue using the Service or follow the account-deletion process in your account settings.</p><p>All provisions of these Terms which by their nature should survive termination shall survive, including, without limitation, ownership provisions, warranty disclaimers, indemnity, limitations of liability, and dispute-resolution provisions.</p>'
	);

const sectionDisclaimer = (c: Computed) =>
	titledSection(
		'Disclaimer of Warranties',
		`<p>YOUR USE OF THE SERVICE IS AT YOUR SOLE RISK. THE SERVICE IS PROVIDED ON AN "AS IS" AND "AS AVAILABLE" BASIS, WITH ALL FAULTS. TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, ${escapeHtml(
			c.companyName
		).toUpperCase()} EXPRESSLY DISCLAIMS ALL WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, STATUTORY, OR OTHERWISE, INCLUDING, BUT NOT LIMITED TO, IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, AND ANY WARRANTIES ARISING OUT OF COURSE OF DEALING OR USAGE OF TRADE.</p><p>WITHOUT LIMITING THE FOREGOING, ${escapeHtml(
			c.companyName
		).toUpperCase()} MAKES NO WARRANTY THAT (A) THE SERVICE WILL MEET YOUR REQUIREMENTS, (B) THE SERVICE WILL BE UNINTERRUPTED, TIMELY, SECURE, OR ERROR-FREE, (C) THE RESULTS OBTAINED FROM THE USE OF THE SERVICE WILL BE ACCURATE OR RELIABLE, OR (D) THE QUALITY OF ANY PRODUCTS, SERVICES, INFORMATION, OR OTHER MATERIAL OBTAINED THROUGH THE SERVICE WILL MEET YOUR EXPECTATIONS.</p><p>SOME JURISDICTIONS DO NOT ALLOW THE EXCLUSION OF CERTAIN WARRANTIES, SO SOME OF THE ABOVE EXCLUSIONS MAY NOT APPLY TO YOU. IN SUCH JURISDICTIONS, OUR LIABILITY IS LIMITED TO THE GREATEST EXTENT PERMITTED BY LAW.</p>`
	);

const sectionLimitation = (c: Computed) =>
	titledSection(
		'Limitation of Liability',
		`<p>TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL ${escapeHtml(
			c.companyName
		).toUpperCase()}, ITS DIRECTORS, EMPLOYEES, AGENTS, AFFILIATES, PARTNERS, SUPPLIERS, OR LICENSORS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, INCLUDING WITHOUT LIMITATION LOSS OF PROFITS, REVENUE, DATA, USE, GOODWILL, OR OTHER INTANGIBLE LOSSES, ARISING OUT OF OR RELATING TO YOUR ACCESS TO OR USE OF, OR INABILITY TO ACCESS OR USE, THE SERVICE; ANY CONDUCT OR CONTENT OF ANY THIRD PARTY ON THE SERVICE; ANY CONTENT OBTAINED FROM THE SERVICE; OR UNAUTHORIZED ACCESS, USE, OR ALTERATION OF YOUR TRANSMISSIONS OR CONTENT, WHETHER BASED ON WARRANTY, CONTRACT, TORT (INCLUDING NEGLIGENCE), OR ANY OTHER LEGAL THEORY, AND WHETHER OR NOT WE HAVE BEEN INFORMED OF THE POSSIBILITY OF SUCH DAMAGE.</p><p>TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, OUR TOTAL CUMULATIVE LIABILITY TO YOU FOR ALL CLAIMS ARISING OUT OF OR RELATING TO THESE TERMS OR THE SERVICE WILL NOT EXCEED THE GREATER OF (A) ONE HUNDRED U.S. DOLLARS ($100) OR (B) THE AMOUNTS YOU PAID US IN THE TWELVE (12) MONTHS PRECEDING THE EVENT GIVING RISE TO THE CLAIM.</p><p>THE LIMITATIONS IN THIS SECTION DO NOT APPLY TO LIABILITY THAT CANNOT BE EXCLUDED OR LIMITED UNDER APPLICABLE LAW, INCLUDING LIABILITY FOR GROSS NEGLIGENCE, WILLFUL MISCONDUCT, OR FRAUD. SOME JURISDICTIONS DO NOT ALLOW THE EXCLUSION OR LIMITATION OF CERTAIN DAMAGES, SO THE ABOVE LIMITATIONS MAY NOT APPLY TO YOU.</p>`
	);

const sectionIndemnification = (c: Computed) =>
	titledSection(
		'Indemnification',
		`<p>You agree to defend, indemnify, and hold harmless ${escapeHtml(
			c.companyName
		)}, its affiliates, licensors, and service providers, and its and their respective officers, directors, employees, contractors, agents, licensors, suppliers, successors, and assigns, from and against any claims, liabilities, damages, judgments, awards, losses, costs, expenses, or fees (including reasonable attorneys’ fees) arising out of or relating to (a) your violation of these Terms, (b) your use or misuse of the Service, (c) your User Content, including any claim that your User Content infringes or violates the rights of a third party, or (d) your violation of any applicable law or the rights of any third party.</p>`
	);

const sectionForceMajeure = () =>
	titledSection(
		'Force Majeure',
		'<p>We will not be liable for any failure or delay in performance under these Terms to the extent caused by circumstances beyond our reasonable control, including without limitation acts of God, natural disasters, war, terrorism, riots, civil unrest, governmental actions, labor disputes, epidemics or pandemics, fires, floods, power or telecommunications failures, internet or third-party service failures, or any other event of force majeure.</p>'
	);

const sectionGoverningLaw = (c: Computed) =>
	titledSection(
		'Governing Law',
		`<p>These Terms shall be governed by and construed in accordance with the laws of ${
			c.governingLocation
		}, without regard to its conflict-of-laws provisions. The United Nations Convention on Contracts for the International Sale of Goods does not apply to these Terms. Subject to the "Dispute Resolution" section below, you agree to submit to the personal and exclusive jurisdiction of the courts located in ${
			c.governingLocation
		} for the resolution of any disputes not subject to arbitration.</p>`
	);

const sectionArbitration = (c: Computed) =>
	titledSection(
		'Dispute Resolution; Binding Arbitration; Class-Action Waiver',
		arbitrationBlock(c.companyName, c.governingLocation)
	);

const sectionExport = (c: Computed) =>
	titledSection(
		'Export Controls and Sanctions',
		`<p>The Service may be subject to U.S. and other export-control and economic-sanctions laws and regulations. You may not access, use, export, re-export, or transfer the Service in violation of those laws. You represent and warrant that you are not located in, under the control of, or a national or resident of any country or person subject to U.S. or other applicable economic sanctions or embargoes, and that you are not on any U.S. government list of restricted or prohibited parties. You agree to comply with all applicable export, re-export, and sanctions laws in your use of the Service. ${escapeHtml(
			c.companyName
		)} reserves the right to restrict access to the Service from any jurisdiction at any time.</p>`
	);

const sectionAppleRider = (c: Computed) =>
	titledSection(
		'Additional Terms for Apple App Store',
		`<p>If you accessed or downloaded the Service from the Apple App Store, the following additional terms apply. You acknowledge that these Terms are concluded between you and ${escapeHtml(
			c.companyName
		)}, and not with Apple Inc. ("Apple"), and that ${escapeHtml(
			c.companyName
		)}, not Apple, is solely responsible for the Service and its content.</p><ul><li><strong>Scope of license.</strong> The license granted to you for the Service is limited to a non-transferable license to use the Service on any Apple-branded products that you own or control, as permitted by the Usage Rules in the Apple Media Services Terms and Conditions.</li><li><strong>Maintenance and support.</strong> ${escapeHtml(
			c.companyName
		)} is solely responsible for providing any maintenance and support services, as specified in these Terms or as required under applicable law. Apple has no obligation whatsoever to furnish any maintenance and support services with respect to the Service.</li><li><strong>Warranty.</strong> ${escapeHtml(
			c.companyName
		)} is solely responsible for any product warranties, whether express or implied by law, to the extent not effectively disclaimed. In the event of any failure of the Service to conform to any applicable warranty, you may notify Apple, and Apple will refund the purchase price for the Service to you (if any). To the maximum extent permitted by applicable law, Apple will have no other warranty obligation whatsoever with respect to the Service.</li><li><strong>Product claims.</strong> ${escapeHtml(
			c.companyName
		)}, not Apple, is responsible for addressing any claims by you or any third party relating to the Service, including: (i) product liability claims; (ii) any claim that the Service fails to conform to any applicable legal or regulatory requirement; and (iii) claims arising under consumer protection, privacy, or similar legislation.</li><li><strong>Intellectual property rights.</strong> In the event of any third-party claim that the Service or your possession and use of the Service infringes that third party’s intellectual property rights, ${escapeHtml(
			c.companyName
		)}, not Apple, will be solely responsible for the investigation, defense, settlement, and discharge of any such claim, to the extent required by these Terms.</li><li><strong>Legal compliance.</strong> You represent and warrant that you are not located in a country that is subject to a U.S. Government embargo or that has been designated by the U.S. Government as a "terrorist supporting" country, and that you are not listed on any U.S. Government list of prohibited or restricted parties.</li><li><strong>Third-party beneficiary.</strong> You and ${escapeHtml(
			c.companyName
		)} acknowledge and agree that Apple, and Apple’s subsidiaries, are third-party beneficiaries of these Terms, and that, upon your acceptance of these Terms, Apple will have the right (and will be deemed to have accepted the right) to enforce these Terms against you as a third-party beneficiary thereof.</li><li><strong>Contact.</strong> Any questions, complaints, or claims with respect to the Service should be directed to ${escapeHtml(
			c.companyName
		)} using the methods in the "Contact Us" section.</li></ul>`
	);

const sectionGoogleRider = (c: Computed) =>
	titledSection(
		'Additional Terms for Google Play',
		`<p>If you accessed or downloaded the Service from Google Play, you acknowledge and agree that:</p><ul><li>${escapeHtml(
			c.companyName
		)}, not Google LLC ("Google"), is solely responsible for the Service and its content.</li><li>Google has no obligation or liability to you with respect to the Service or these Terms.</li><li>Your use of the Service must comply with the then-current Google Play Terms of Service.</li><li>Google is a third-party beneficiary of these Terms only to the extent necessary to enforce its rights under the Google Play Terms of Service.</li></ul>`
	);

const sectionSeverability = () =>
	titledSection(
		'Severability and Waiver',
		'<p><strong>Severability.</strong> If any provision of these Terms is held by a court or other tribunal of competent jurisdiction to be invalid, illegal, or unenforceable for any reason, that provision will be modified to the minimum extent necessary to make it enforceable, or, if it cannot be modified, severed from these Terms. The remaining provisions will continue in full force and effect.</p><p><strong>Waiver.</strong> No waiver by us of any term or condition set forth in these Terms shall be deemed a further or continuing waiver of such term or condition or a waiver of any other term or condition. Our failure to assert a right or provision under these Terms shall not constitute a waiver of such right or provision.</p>'
	);

const sectionEntireAgreement = () =>
	titledSection(
		'Entire Agreement',
		'<p>These Terms, together with our Privacy Policy and any other policies referenced herein, constitute the entire agreement between you and us regarding the Service and supersede all prior and contemporaneous agreements, proposals, or representations, whether written or oral, regarding the Service.</p>'
	);

const sectionAssignment = (c: Computed) =>
	titledSection(
		'Assignment',
		`<p>You may not assign or transfer these Terms, by operation of law or otherwise, without our prior written consent. Any attempt by you to assign or transfer these Terms without such consent will be null and void. ${escapeHtml(
			c.companyName
		)} may freely assign or transfer these Terms without restriction. Subject to the foregoing, these Terms will bind and inure to the benefit of the parties, their successors, and permitted assigns.</p>`
	);

const sectionNotices = () =>
	titledSection(
		'Notices',
		'<p>Any notices or other communications provided by us under these Terms will be given by posting to the Service or by email to the address associated with your account. Notices to us must be sent using the methods listed in the "Contact Us" section. A notice is deemed given on the date received or, if delivery is not accomplished by reason of some fault of the addressee, when tendered.</p>'
	);

const sectionLinks = () =>
	titledSection(
		'Links to Other Websites',
		'<p>The Service may contain links to third-party websites or services that are not owned or controlled by us. We have no control over, and assume no responsibility for, the content, privacy policies, or practices of any third-party websites or services. You acknowledge and agree that we are not responsible or liable, directly or indirectly, for any damage or loss caused or alleged to be caused by or in connection with the use of or reliance on any such content, goods, or services available on or through any such websites or services.</p>'
	);

const sectionChanges = () =>
	titledSection(
		'Changes to These Terms',
		'<p>We may update these Terms from time to time. We will notify you of any changes by posting the new Terms on this page and updating the "Last updated" date at the top. Where required by law, we will provide additional notice (such as by email) and give you the opportunity to review the changes before they take effect. Your continued use of the Service after the updated Terms become effective constitutes your acceptance of the changes. If you do not agree to the new Terms, you must stop using the Service.</p>'
	);

const sectionContact = (a: TermsAnswers) => {
	const items: string[] = [];
	if (a.contact?.methods?.includes('email') && a.contact.details.email) {
		items.push(
			`By email: <a href="mailto:${escapeHtml(a.contact.details.email)}">${escapeHtml(
				a.contact.details.email
			)}</a>`
		);
	}
	if (a.contact?.methods?.includes('page') && a.contact.details.page) {
		items.push(
			`By visiting this page on our website: <a href="${escapeHtml(
				a.contact.details.page
			)}" rel="external nofollow noopener" target="_blank">${escapeHtml(a.contact.details.page)}</a>`
		);
	}
	if (a.contact?.methods?.includes('phone') && a.contact.details.phone) {
		items.push(`By phone number: ${escapeHtml(a.contact.details.phone)}`);
	}
	if (a.contact?.methods?.includes('mail') && a.contact.details.address) {
		items.push(`By mail: ${escapeHtml(a.contact.details.address)}`);
	}
	return `<section class="space-y-3"><h2 class="text-xl font-semibold">Contact Us</h2><p class="text-base leading-7">If you have any questions about these Terms, you can contact us:</p>${list(items)}</section>`;
};

export const generateTermsHtml = (answers: TermsAnswers) => {
	const c = compute(answers);
	const sections: string[] = [];

	sections.push(sectionHeader(c));
	sections.push(sectionEligibility());
	sections.push(sectionDefinitions(c));
	sections.push(sectionLicense());
	if (answers.accounts === 'yes') sections.push(sectionAccounts());
	if (answers.userContent === 'yes') sections.push(sectionUserContent());
	if (answers.userContent === 'yes' && answers.infringementEmail) {
		sections.push(sectionDmca(c, answers.infringementEmail));
	}
	if (answers.exclusiveContent === 'yes') sections.push(sectionExclusiveIp(c));
	if (answers.feedbackReuse === 'yes') sections.push(sectionFeedback());
	if (answers.canBuyGoods === 'yes') sections.push(sectionPurchases());
	if (answers.subscriptions === 'yes') sections.push(sectionSubscriptions(answers));
	if (answers.promotions === 'yes') sections.push(sectionPromotions());
	sections.push(sectionProhibited());
	sections.push(sectionTermination());
	sections.push(sectionDisclaimer(c));
	sections.push(sectionLimitation(c));
	sections.push(sectionIndemnification(c));
	sections.push(sectionForceMajeure());
	sections.push(sectionGoverningLaw(c));
	sections.push(sectionArbitration(c));
	sections.push(sectionExport(c));
	if (answers.mobileApp.includes('apple')) sections.push(sectionAppleRider(c));
	if (answers.mobileApp.includes('google')) sections.push(sectionGoogleRider(c));
	sections.push(sectionSeverability());
	sections.push(sectionEntireAgreement());
	sections.push(sectionAssignment(c));
	sections.push(sectionNotices());
	sections.push(sectionLinks());
	sections.push(sectionChanges());
	sections.push(sectionContact(answers));

	return `<section data-role="content">${sections.filter(Boolean).join('')}</section>`;
};

async function termsAction(): Promise<void> {
	const { workspaceRootDir, publicRoutesDir } = await getWorkspace();

	const core = await p.group(
		{
			websiteUrl: sharedFields.websiteUrl,
			websiteName: sharedFields.websiteName,
			entityType: sharedFields.entityType,
			businessName: sharedFields.businessName,
			businessAddress: sharedFields.businessAddress,
			country: sharedFields.country,
			state: sharedFields.state
		},
		{ onCancel }
	);

	const accounts = await p.select({
		message: 'Can users create accounts?',
		options: [
			{ value: 'yes', label: 'Yes, users can create accounts' },
			{ value: 'no', label: 'No' }
		]
	});
	if (p.isCancel(accounts)) onCancel();

	const userContent = await p.select({
		message: 'Can users create and/or upload content (ie. text, images)?',
		options: [
			{ value: 'yes', label: 'Yes, users can create and/or upload content' },
			{ value: 'no', label: 'No' }
		]
	});
	if (p.isCancel(userContent)) onCancel();

	let infringementEmail: string | undefined;
	if (userContent === 'yes') {
		const email = await p.text({
			message: "What's the email address where you will receive infringements notices?",
			placeholder: 'dmca@website.com',
			validate: (value: string | undefined) => {
				if (!value) {
					return 'Please enter an email address';
				}
			}
		});
		if (p.isCancel(email)) onCancel();
		infringementEmail = email as string;
	}

	const canBuyGoods = await p.select({
		message: 'Can users buy goods (products, items)?',
		options: [
			{
				value: 'yes',
				label: 'Yes, users can buy goods, items or services (one-time payments only)'
			},
			{ value: 'no', label: 'No' }
		]
	});
	if (p.isCancel(canBuyGoods)) onCancel();

	const subscriptions = await p.select({
		message: 'Do you offer subscription plans?',
		options: [
			{ value: 'yes', label: 'Yes, we offer subscription plans' },
			{ value: 'no', label: 'No' }
		]
	});
	if (p.isCancel(subscriptions)) onCancel();

	let freeTrial: 'yes' | 'no' | undefined;
	if (subscriptions === 'yes') {
		const ft = await p.select({
			message: 'Do you offer a free trial?',
			options: [
				{ value: 'yes', label: 'Yes' },
				{ value: 'no', label: 'No' }
			]
		});
		if (p.isCancel(ft)) onCancel();
		freeTrial = ft as 'yes' | 'no';
	}

	const exclusiveContent = await p.select({
		message:
			'Do you want to make it clear that your own content & trademarks are your exclusive property?',
		options: [
			{
				value: 'yes',
				label: 'Yes, our content (logo, visual design, trademarks etc.) is our exclusive property'
			},
			{ value: 'no', label: 'No' }
		]
	});
	if (p.isCancel(exclusiveContent)) onCancel();

	const feedbackReuse = await p.select({
		message:
			'If users provide you feedback & suggestions, do you want to use this feedback without compensation or credits given?',
		options: [
			{ value: 'yes', label: 'Yes, we may implement any feedback or suggestions we receive' },
			{ value: 'no', label: 'No' }
		]
	});
	if (p.isCancel(feedbackReuse)) onCancel();

	const promotions = await p.select({
		message: 'Do you plan to offer promotions, contests, sweepstakes?',
		options: [
			{ value: 'yes', label: 'Yes, we may offer promotions, contests, sweepstakes' },
			{ value: 'no', label: 'No' }
		]
	});
	if (p.isCancel(promotions)) onCancel();

	const mobileAppRaw = await p.multiselect({
		message: 'Is the Service distributed through any mobile app stores? Check all that apply',
		options: [
			{ value: 'apple', label: 'Apple App Store' },
			{ value: 'google', label: 'Google Play' }
		],
		required: false
	});
	if (p.isCancel(mobileAppRaw)) onCancel();
	const mobileApp = (mobileAppRaw ?? []) as Array<'apple' | 'google'>;

	const contact = await contactMethods('terms');

	const html = generateTermsHtml({
		core,
		accounts: accounts as 'yes' | 'no',
		userContent: userContent as 'yes' | 'no',
		infringementEmail,
		canBuyGoods: canBuyGoods as 'yes' | 'no',
		subscriptions: subscriptions as 'yes' | 'no',
		freeTrial,
		exclusiveContent: exclusiveContent as 'yes' | 'no',
		feedbackReuse: feedbackReuse as 'yes' | 'no',
		promotions: promotions as 'yes' | 'no',
		mobileApp,
		contact
	});

	const termsPage = path.join(
		workspaceRootDir,
		publicRoutesDir,
		LEGAL_DIR,
		'terms',
		'+page.svelte'
	);
	const termsPageTs = path.join(workspaceRootDir, publicRoutesDir, LEGAL_DIR, 'terms', '+page.ts');
	fs.mkdirSync(path.dirname(termsPage), { recursive: true });
	fs.writeFileSync(termsPage, html);
	fs.writeFileSync(
		termsPageTs,
		pageMetaTagsLoader('Terms of Service', `Terms of Service for ${core.websiteName}`)
	);

	const relativeTermsPage = path.relative(workspaceRootDir, termsPage);
	const relativeTermsPageTs = path.relative(workspaceRootDir, termsPageTs);
	reportResult({
		summary: 'Generated placeholder terms and conditions.',
		filesCreated: [relativeTermsPage, relativeTermsPageTs],
		nextSteps: [
			`Review the generated copy in ${relativeTermsPage} and replace placeholder sections with details for your business.`,
			'Have the final document reviewed by a lawyer before publishing — this is a starter template, not legal advice.',
			'Link to /terms from your footer and sign-up flow.'
		]
	});
}

export const terms = new Command('terms')
	.description('generate placeholder terms and conditions')
	.configureHelp(helpConfig)
	.action(() => runCommand(termsAction, 'Failed to generate terms and conditions.'));
