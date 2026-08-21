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
	applyTypography,
	ccpaCategoriesTable,
	contactMethods,
	escapeHtml,
	gdprRightsBlock,
	internationalTransfersBlock,
	legalBasesBlock,
	list,
	onCancel,
	pageMetaTagsLoader,
	sharedFields,
	subSection,
	titledSection,
	usStateRightsBlock,
	type LegalCoreAnswers
} from './shared.ts';

const mapLabels = {
	personalInfo: {
		email: 'Email address',
		name: 'First name and last name',
		phone: 'Phone number',
		address: 'Address, State, Province, ZIP/Postal code, City',
		social:
			'Social Media Profile information (e.g. from Connect with Facebook, Sign In With Twitter)',
		other: 'Other information you choose to provide'
	},
	tracking: {
		ga: 'Google Analytics',
		firebase: 'Firebase',
		matomo: 'Matomo (formerly Piwik)',
		clicky: 'Clicky',
		statcounter: 'Statcounter',
		flurry: 'Flurry Analytics',
		mixpanel: 'Mixpanel',
		unity: 'Unity Analytics'
	},
	emailPlatforms: {
		mailchimp: 'Mailchimp',
		'constant-contact': 'Constant Contact',
		aweber: 'AWeber',
		getresponse: 'GetResponse'
	},
	ads: {
		adsense: 'Google Ads (AdSense)',
		admob: 'AdMob by Google',
		bing: 'Bing Ads',
		flurry: 'Flurry',
		inmobi: 'InMobi',
		mopub: 'MoPub',
		startapp: 'StartApp',
		adcolony: 'AdColony',
		applovin: 'AppLovin',
		vungle: 'Vungle',
		adbutler: 'AdButler',
		'unity-ads': 'Unity Ads'
	},
	payments: {
		'apple-iap': 'Apple Store In-App Payments',
		'google-iap': 'Google Play In-App Payments',
		paypal: 'PayPal',
		braintree: 'Braintree',
		stripe: 'Stripe',
		fastspring: 'FastSpring',
		shopify: 'Shopify',
		square: 'Square',
		'2checkout': '2Checkout',
		wepay: 'WePay',
		worldpay: 'WorldPay',
		'authorize-net': 'Authorize.net',
		'sage-pay': 'Sage Pay',
		gocardless: 'Go Cardless',
		elavon: 'Elavon',
		verifone: 'Verifone',
		moneris: 'Moneris',
		wechat: 'WeChat',
		alipay: 'Alipay',
		bank: 'Bank Transfer'
	},
	remarketing: {
		'google-ads': 'Google Ads (AdWords)',
		twitter: 'Twitter',
		facebook: 'Facebook',
		bing: 'Bing Ads',
		pinterest: 'Pinterest',
		adroll: 'AdRoll',
		'perfect-audience': 'Perfect Audience',
		appnexus: 'AppNexus'
	},
	providers: {
		recaptcha: 'Invisible reCAPTCHA',
		'google-places': 'Google Places',
		mouseflow: 'Mouseflow',
		freshdesk: 'FreshDesk'
	}
} as const;

type PrivacyAnswers = {
	core: LegalCoreAnswers;
	personalInfo: Array<'phone' | 'address' | 'email' | 'name' | 'social' | 'other'>;
	contact: { methods: string[]; details: Record<string, unknown> };
	tracking: 'yes' | 'no';
	trackingTools?: Array<keyof typeof mapLabels.tracking | string>;
	sendEmails: 'yes' | 'no';
	emailPlatforms?: Array<keyof typeof mapLabels.emailPlatforms | string>;
	showAds: 'yes' | 'no';
	adsPlatforms?: Array<keyof typeof mapLabels.ads | string>;
	canPay: 'yes' | 'no';
	paymentProcessors?: Array<keyof typeof mapLabels.payments | string>;
	remarketing: 'yes' | 'no';
	remarketingPlatforms?: Array<keyof typeof mapLabels.remarketing | string>;
	providers?: Array<keyof typeof mapLabels.providers | string>;
	usStates: 'yes' | 'no';
	gdpr: 'yes' | 'no';
	facebookFanPage?: 'yes' | 'no';
	facebookDetails?: { name: string; url: string };
	kids: 'yes' | 'no';
	retention?: string;
};

type Computed = {
	companyName: string;
	companyAddress: string;
	websiteName: string;
	websiteUrl: string;
	countryText: string;
	effectiveDate: string;
	piLabels: string[];
	hasSocial: boolean;
	trackingTools: string[];
	emailPlatforms: string[];
	adsPlatforms: string[];
	paymentProcessors: string[];
	remarketingPlatforms: string[];
	providers: string[];
	retentionText: string;
};

const compute = (a: PrivacyAnswers): Computed => {
	const effectiveDate = new Date(Date.now()).toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	});

	const piSelections = (a.personalInfo as string[] | undefined) ?? [];
	const piLabels = piSelections.map(
		(v) => mapLabels.personalInfo[v as keyof typeof mapLabels.personalInfo] ?? v
	);

	const lookup = <T extends Record<string, string>>(map: T, vs?: string[]) =>
		(vs ?? []).map((v) => map[v as keyof T] ?? v);

	const companyName =
		a.core?.entityType === 'business'
			? (a.core?.businessName ?? a.core?.websiteName)
			: (a.core?.websiteName ?? 'Our Company');
	const companyAddress = a.core?.entityType === 'business' ? (a.core?.businessAddress ?? '') : '';
	const websiteName = a.core?.websiteName ?? 'our website';
	const websiteUrl = a.core?.websiteUrl ?? '';
	const countryText = `${a.core?.state ?? ''}${a.core?.state ? ', ' : ''}${a.core?.country ?? ''}`;

	return {
		companyName,
		companyAddress,
		websiteName,
		websiteUrl,
		countryText,
		effectiveDate,
		piLabels,
		hasSocial: piSelections.includes('social'),
		trackingTools: lookup(mapLabels.tracking, a.trackingTools as string[] | undefined),
		emailPlatforms: lookup(mapLabels.emailPlatforms, a.emailPlatforms as string[] | undefined),
		adsPlatforms: lookup(mapLabels.ads, a.adsPlatforms as string[] | undefined),
		paymentProcessors: lookup(mapLabels.payments, a.paymentProcessors as string[] | undefined),
		remarketingPlatforms: lookup(
			mapLabels.remarketing,
			a.remarketingPlatforms as string[] | undefined
		),
		providers: lookup(mapLabels.providers, a.providers as string[] | undefined),
		retentionText:
			a.retention && a.retention.trim().length > 0
				? a.retention.trim()
				: 'as long as is necessary to provide the Service and fulfil the purposes outlined in this Privacy Policy, and to comply with our legal obligations, resolve disputes, and enforce our agreements'
	};
};

const sectionHeader = (c: Computed) =>
	`<section class="space-y-3"><h1 class="text-3xl font-semibold">Privacy Policy</h1><p class="text-base leading-7">Last updated: ${escapeHtml(
		c.effectiveDate
	)}</p><p class="text-base leading-7">This Privacy Policy describes the policies and procedures of ${escapeHtml(
		c.companyName
	)} ("we", "us", or "our") regarding the collection, use, and disclosure of your information when you use ${escapeHtml(
		c.websiteName
	)} (the "Service"), and tells you about your privacy rights and how applicable law protects you.</p><p class="text-base leading-7">We use your personal data to provide and improve the Service. By using the Service, you agree to the collection and use of information in accordance with this Privacy Policy. If you do not agree with this Privacy Policy, please do not use the Service.</p></section>`;

const sectionDefinitions = (c: Computed) => {
	const items: string[] = [];
	const def = (term: string, body: string) =>
		items.push(`<li><p class="text-base leading-7"><strong>${term}</strong> ${body}</p></li>`);

	def(
		'Account',
		'means a unique account created for you to access our Service or parts of our Service.'
	);
	def(
		'Affiliate',
		'means an entity that controls, is controlled by, or is under common control with a party, where "control" means ownership of 50% or more of the shares, equity interest, or other securities entitled to vote for election of directors or other managing authority.'
	);
	def(
		'Business',
		`(referred to as either "the Company", "We", "Us", or "Our" in this Agreement) refers to ${escapeHtml(
			c.companyName
		)}${c.companyAddress ? `, ${escapeHtml(c.companyAddress)}` : ''}.`
	);
	def(
		'Consumer',
		'for the purposes of U.S. state privacy laws, means a natural person who is a resident of a U.S. state with a comprehensive consumer privacy law.'
	);
	def(
		'Cookies',
		'are small files that are placed on your computer, mobile device, or any other device by a website, containing details of your browsing history on that website among many other uses.'
	);
	def('Country', `refers to: ${escapeHtml(c.countryText)}.`);
	def(
		'Device',
		'means any device that can access the Service, such as a computer, a cellphone, or a digital tablet.'
	);
	def(
		'Personal Data',
		'or Personal Information is any information that relates to an identified or identifiable individual, including any information that identifies, relates to, describes, or is reasonably capable of being associated with you.'
	);
	def(
		'Sale',
		"for the purposes of California, Colorado, Connecticut, Utah, and Virginia consumer privacy laws, means selling, renting, releasing, disclosing, disseminating, making available, transferring, or otherwise communicating orally, in writing, or by electronic means, a Consumer's Personal Information by the Business to a third party for valuable consideration."
	);
	def(
		'Share',
		'for the purposes of the California Privacy Rights Act ("CPRA"), means sharing, renting, releasing, disclosing, disseminating, making available, transferring, or otherwise communicating orally, in writing, or by electronic or other means, a Consumer\'s Personal Information by the Business to a third party for cross-context behavioral advertising, whether or not for monetary or other valuable consideration.'
	);
	def(
		'Sensitive Personal Information',
		'has the meaning given in applicable U.S. state privacy laws (including the CPRA) and may include, where collected, government-issued identifiers, account log-in credentials, precise geolocation, racial or ethnic origin, religious beliefs, contents of communications, genetic data, biometric data, health information, and information concerning sex life or sexual orientation.'
	);
	def(
		'Service',
		`refers to ${escapeHtml(c.websiteName)}, accessible from <a href="${escapeHtml(
			c.websiteUrl
		)}" rel="external nofollow noopener" target="_blank">${escapeHtml(c.websiteUrl)}</a>.`
	);
	def(
		'Service Provider',
		'means any natural or legal person who processes the data on behalf of the Company, including third-party companies or individuals employed by the Company to facilitate the Service.'
	);
	def(
		'Third-party Social Media Service',
		'refers to any website or any social network website through which a user can log in or create an account to use the Service.'
	);
	def(
		'Usage Data',
		'refers to data collected automatically, either generated by the use of the Service or from the Service infrastructure itself (for example, the duration of a page visit).'
	);
	def(
		'You',
		'means the individual accessing or using the Service, or the company or other legal entity on behalf of which such individual is accessing or using the Service, as applicable.'
	);

	const interpretation =
		'<p class="text-base leading-7">The words of which the initial letter is capitalized have meanings defined under the following conditions. The following definitions shall have the same meaning regardless of whether they appear in singular or in plural.</p>';
	const definitions = `<p class="text-base leading-7">For the purposes of this Privacy Policy:</p><ul class="list-disc pl-6 space-y-1 text-base leading-7">${items.join('')}</ul>`;
	return `<section class="space-y-3"><h2 class="text-xl font-semibold">Interpretation and Definitions</h2><h3 class="text-lg font-semibold">Interpretation</h3>${interpretation}<h3 class="text-lg font-semibold">Definitions</h3>${definitions}</section>`;
};

const sectionCategoriesCollected = (a: PrivacyAnswers, c: Computed) => {
	const pi = (a.personalInfo as string[] | undefined) ?? [];
	const internetActivity = a.tracking === 'yes' || (a.providers ?? []).length > 0;
	const body = ccpaCategoriesTable({
		identifiers: true,
		customerRecords: pi.includes('name') || pi.includes('address') || pi.includes('phone'),
		commercialInfo: a.canPay === 'yes',
		internetActivity,
		geolocation: pi.includes('address'),
		sensitive: false
	});

	const personal = `<h4 class="font-semibold">Personal Data</h4><p class="text-base leading-7">While using our Service, we may ask you to provide us with certain personally identifiable information that can be used to contact or identify you. Personally identifiable information may include, but is not limited to:</p>${list(
		(c.piLabels.length
			? c.piLabels
			: [
					'Email address',
					'First name and last name',
					'Phone number',
					'Address, State, Province, ZIP/Postal code, City',
					'Usage Data'
				]
		).map(escapeHtml)
	)}`;

	const usage = `<h4 class="font-semibold">Usage Data</h4><p class="text-base leading-7">Usage Data is collected automatically when using the Service. It may include information such as your device’s Internet Protocol address (e.g. IP address), browser type and version, the pages of our Service that you visit, the time and date of your visit, the time spent on those pages, unique device identifiers, and other diagnostic data.</p><p class="text-base leading-7">When you access the Service by or through a mobile device, we may collect certain information automatically, including, but not limited to, the type of mobile device you use, your mobile device’s unique ID, the IP address of your mobile device, your mobile operating system, the type of mobile Internet browser you use, unique device identifiers, and other diagnostic data.</p>`;

	let social = '';
	if (c.hasSocial) {
		social = `<h4 class="font-semibold">Information from Third-Party Social Media Services</h4><p class="text-base leading-7">The Company allows you to create an account and log in to use the Service through Third-party Social Media Services such as Google, Facebook, Instagram, X (formerly Twitter), or LinkedIn. If you decide to register through or otherwise grant us access to a Third-party Social Media Service, we may collect personal data associated with your account, such as your name, email address, activities, or contact list.</p><p class="text-base leading-7">You may also have the option of sharing additional information with the Company through your Third-party Social Media Service’s account. If you choose to provide such information and Personal Data, during registration or otherwise, you are giving the Company permission to use, share, and store it in a manner consistent with this Privacy Policy.</p>`;
	}

	return `<section class="space-y-3"><h2 class="text-xl font-semibold">Personal Information We Collect</h2>${applyTypography(
		body
	)}${applyTypography(personal)}${applyTypography(usage)}${applyTypography(social)}</section>`;
};

const sectionSources = () =>
	titledSection(
		'Sources of Personal Information',
		`<p>We collect personal information from the following categories of sources:</p><ul><li><strong>Directly from you</strong> when you provide information to us, for example by creating an account, completing a form, contacting us, or making a purchase.</li><li><strong>Automatically</strong> as you navigate through the Service, including through cookies, log files, and similar tracking technologies.</li><li><strong>From third parties</strong>, such as analytics providers, advertising networks, payment processors, and Third-party Social Media Services that you use to log in.</li><li><strong>From publicly available sources</strong>, such as public records, public profile information, and public databases.</li><li><strong>From service providers and business partners</strong> that help us operate or improve the Service.</li></ul>`
	);

const sectionUse = (a: PrivacyAnswers, c: Computed) => {
	const useBullets: string[] = [
		'<strong>To provide and maintain our Service,</strong> including to monitor the usage of our Service and to detect, prevent, and address technical issues.',
		'<strong>To manage your Account:</strong> to manage your registration as a user of the Service. The Personal Data you provide can give you access to different functionalities of the Service available to you as a registered user.'
	];
	if (a.canPay === 'yes') {
		useBullets.push(
			'<strong>For the performance of a contract:</strong> the development, compliance, and undertaking of the purchase contract for products, items, or services you have purchased or of any other contract with us through the Service.'
		);
	}
	useBullets.push(
		'<strong>To contact you:</strong> to contact you by email, telephone calls, SMS, or other equivalent forms of electronic communication, such as a mobile application’s push notifications, regarding updates or informative communications related to the functionalities, products, or contracted services, including the security updates, when necessary or reasonable for their implementation.'
	);
	if (a.sendEmails === 'yes') {
		useBullets.push(
			'<strong>To provide you</strong> with news, special offers, and general information about goods, services, and events that we offer, unless you have opted not to receive such information.'
		);
	}
	useBullets.push(
		'<strong>To manage your requests:</strong> to attend to and manage your requests to us.',
		'<strong>For business transfers:</strong> we may use your information to evaluate or conduct a merger, divestiture, restructuring, reorganization, dissolution, or other sale or transfer of some or all of our assets, whether as a going concern or as part of bankruptcy, liquidation, or similar proceedings, in which Personal Data held by us about our Service users is among the assets transferred.',
		'<strong>For analytics and improvement:</strong> for data analysis, identifying usage trends, determining the effectiveness of our promotional campaigns, and improving our Service, products, services, marketing, and your experience.',
		'<strong>For security and fraud prevention:</strong> to protect the rights, property, or safety of the Company, our users, or others, including detecting, preventing, and responding to fraud, abuse, security risks, and technical issues.',
		'<strong>To comply with legal obligations:</strong> to comply with applicable laws, lawful requests, court orders, and legal processes.'
	);

	let body = `<p class="text-base leading-7">The Company may use Personal Data for the following purposes:</p>${list(useBullets)}`;
	if (a.showAds === 'yes') {
		body += `<p class="text-base leading-7">We may display advertising on the Service${
			c.adsPlatforms.length ? ' using the following platforms:' : '.'
		}</p>${c.adsPlatforms.length ? list(c.adsPlatforms.map(escapeHtml)) : ''}`;
	}
	if (a.canPay === 'yes' && c.paymentProcessors.length) {
		body += `<p class="text-base leading-7">If you make purchases, we may process payments via the following providers, who handle your payment information in accordance with their own privacy policies:</p>${list(
			c.paymentProcessors.map(escapeHtml)
		)}`;
	}

	return titledSection('How We Use Your Personal Information', body);
};

const sectionLegalBases = () =>
	titledSection('Legal Bases for Processing (EEA, UK, Switzerland)', legalBasesBlock());

const sectionShare = (a: PrivacyAnswers, c: Computed) => {
	let body =
		'<p>We may share your personal information in the following situations and with the following categories of recipients:</p><ul>';
	body +=
		'<li><strong>With Service Providers:</strong> to monitor and analyze the use of our Service, host the Service, process payments, send emails, provide customer support, and contact you. These providers have access to your Personal Information only to perform these tasks on our behalf and are obligated not to disclose or use it for any other purpose.</li>';
	body +=
		'<li><strong>For business transfers:</strong> we may share or transfer your Personal Information in connection with, or during negotiations of, any merger, sale of Company assets, financing, or acquisition of all or a portion of our business to another company.</li>';
	body +=
		'<li><strong>With Affiliates:</strong> we may share your information with our affiliates, in which case we will require those affiliates to honor this Privacy Policy.</li>';
	body +=
		'<li><strong>With business partners:</strong> we may share your information with our business partners to offer you certain products, services, or promotions.</li>';
	body +=
		'<li><strong>With other users:</strong> when you share personal information or otherwise interact in public areas with other users, such information may be viewed by all users and may be publicly distributed outside.</li>';
	body +=
		'<li><strong>For legal reasons:</strong> we may disclose your information where we believe in good faith that it is necessary to comply with a legal obligation, to protect our rights or property, to prevent fraud or harm, or to enforce our terms.</li>';
	body += '<li><strong>With your consent:</strong> for any other purpose with your consent.</li>';
	body += '</ul>';
	if (c.providers.length) {
		body += `<p>We currently use the following service providers:</p>${list(c.providers.map(escapeHtml))}`;
	}
	void a;
	return titledSection('How We Share or Disclose Personal Information', body);
};

const sectionSaleSharing = (a: PrivacyAnswers, c: Computed) => {
	const sells = a.showAds === 'yes' || a.remarketing === 'yes';
	const intro = sells
		? `<p>For purposes of certain U.S. state privacy laws (including the California Consumer Privacy Act, as amended by the California Privacy Rights Act, and the Virginia, Colorado, Connecticut, Utah, Texas, and Oregon consumer privacy laws), our use of cookies, pixels, and similar advertising and analytics technologies — including for cross-context behavioral advertising and targeted advertising — may be considered a "sale" or "share" of personal information. The categories of personal information involved typically include online identifiers, IP addresses, internet or other electronic network activity information, and inferences derived from this information.</p>`
		: '<p>We do not "sell" your personal information for monetary consideration. We do not "share" your personal information for cross-context behavioral advertising as those terms are defined under the California Privacy Rights Act ("CPRA") or comparable U.S. state privacy laws. We do not knowingly sell or share personal information of consumers under 16 years of age.</p>';

	let recipients = '';
	if (sells) {
		const partners = [...c.adsPlatforms, ...c.remarketingPlatforms];
		const list_ = partners.length
			? `<p>The categories of third parties to which we may disclose personal information for these purposes include advertising networks, analytics providers, and marketing partners, including:</p>${list(
					partners.map(escapeHtml)
				)}`
			: '<p>The categories of third parties to which we may disclose personal information for these purposes include advertising networks, analytics providers, social media platforms, and marketing partners.</p>';
		recipients = list_;
	}

	const optOut = `<p><strong>Your right to opt out.</strong> You have the right to opt out of the sale or sharing of your personal information at any time. To exercise this right, you may use the controls described in the "Tracking Technologies and Cookies" section, change the privacy settings in your browser or mobile device, contact us using the methods listed in the "Contact Us" section, or send an opt-out preference signal — we honor the Global Privacy Control ("GPC") signal as a request to opt out of sale and sharing for the browser or device on which the signal is detected.</p>`;

	return titledSection(
		'Sale or Sharing of Personal Information; Targeted Advertising',
		`${intro}${recipients}${optOut}`
	);
};

const sectionCookies = (a: PrivacyAnswers, c: Computed) => {
	let body = `<p>We use Cookies and similar tracking technologies (such as web beacons, pixels, tags, scripts, and software development kits) to track the activity on our Service and hold certain information.</p><p>Cookies can be "Persistent" or "Session" Cookies. Persistent Cookies remain on your personal computer or mobile device when you go offline, while Session Cookies are deleted as soon as you close your web browser.</p><h4>Categories of Cookies We Use</h4><ul><li><strong>Strictly Necessary Cookies.</strong> These are required for the operation of the Service and to provide functionalities you request, such as logging in or accessing secure areas. The Service cannot function properly without them.</li><li><strong>Performance / Analytics Cookies.</strong> These cookies allow us to count visits and traffic sources so we can measure and improve the performance of the Service.</li><li><strong>Functional Cookies.</strong> These cookies enable enhanced functionality and personalization, such as remembering your preferences.</li><li><strong>Targeting / Advertising Cookies.</strong> These cookies may be set through our Service by our advertising partners to build a profile of your interests and show you relevant advertisements on other sites.</li><li><strong>Cookies Policy / Notice Acceptance Cookies.</strong> These cookies identify whether users have accepted the use of cookies on the Service.</li></ul>`;
	if (a.tracking === 'yes' && c.trackingTools.length) {
		body += `<p>We currently use the following analytics and tracking tools:</p>${list(c.trackingTools.map(escapeHtml))}`;
	}
	body += `<h4>Your Choices About Cookies</h4><p>You can instruct your browser to refuse all Cookies or to indicate when a Cookie is being sent. If you do not accept Cookies, you may not be able to use some parts of our Service. You can also manage your cookie preferences through any cookie banner or preference center we provide.</p><h4>Do Not Track and Global Privacy Control</h4><p>Some browsers transmit "Do Not Track" ("DNT") or Global Privacy Control ("GPC") signals. There is currently no industry standard for responding to DNT signals, but we honor GPC signals as an opt-out of the sale or sharing of personal information for the browser or device on which the signal is detected, as required by applicable law.</p>`;
	return titledSection('Tracking Technologies and Cookies', body);
};

const sectionEmail = (a: PrivacyAnswers, c: Computed) =>
	a.sendEmails === 'yes'
		? titledSection(
				'Email Communications',
				c.emailPlatforms.length
					? `<p>We may send transactional, account-related, and (where you have opted in) marketing emails using the following platforms, who process email information on our behalf as service providers:</p>${list(
							c.emailPlatforms.map(escapeHtml)
						)}<p>You may unsubscribe from marketing emails at any time using the unsubscribe link included in those emails. Even if you unsubscribe from marketing emails, we may still send you transactional or account-related emails (for example, to confirm a purchase or notify you of changes to the Service).</p>`
					: '<p>We may send you transactional, account-related, and (where you have opted in) marketing emails. You may unsubscribe from marketing emails at any time using the unsubscribe link included in those emails.</p>'
			)
		: '';

const sectionRemarketing = (a: PrivacyAnswers, c: Computed) =>
	a.remarketing === 'yes'
		? titledSection(
				'Remarketing and Targeted Advertising',
				c.remarketingPlatforms.length
					? `<p>We use remarketing services to advertise to visitors of our Service on third-party websites and applications after they have visited the Service. These services may use cookies and similar technologies to deliver advertisements based on your past visits. The remarketing services we use include:</p>${list(
							c.remarketingPlatforms.map(escapeHtml)
						)}<p>You may opt out of personalized advertising by visiting the Network Advertising Initiative opt-out page (<a href="https://www.networkadvertising.org/choices/" rel="external nofollow noopener" target="_blank">https://www.networkadvertising.org/choices/</a>), the Digital Advertising Alliance opt-out page (<a href="https://www.aboutads.info/choices/" rel="external nofollow noopener" target="_blank">https://www.aboutads.info/choices/</a>), or the European Interactive Digital Advertising Alliance (<a href="https://www.youronlinechoices.eu" rel="external nofollow noopener" target="_blank">https://www.youronlinechoices.eu</a>).</p>`
					: '<p>We use remarketing services to advertise to visitors of our Service on third-party websites and applications after they have visited the Service.</p>'
			)
		: '';

const sectionRetention = (c: Computed) =>
	titledSection(
		'Retention of Your Personal Information',
		`<p>The Company will retain your Personal Information ${escapeHtml(
			c.retentionText
		)}. We will retain and use your Personal Information to the extent necessary to comply with our legal obligations (for example, if we are required to retain your data to comply with applicable laws), resolve disputes, and enforce our agreements and policies.</p><p>The Company will also retain Usage Data for internal analysis purposes. Usage Data is generally retained for a shorter period of time, except when this data is used to strengthen the security or to improve the functionality of our Service, or we are legally obligated to retain this data for longer periods.</p><p>When we no longer have a legitimate business need to process your Personal Information, we will either delete or anonymize it or, if this is not possible (for example, because your Personal Information has been stored in backup archives), we will securely store your Personal Information and isolate it from any further processing until deletion is possible.</p>`
	);

const sectionTransfers = () =>
	titledSection('International Data Transfers', internationalTransfersBlock());

const sectionSecurity = () =>
	titledSection(
		'Data Security',
		'<p>The security of your Personal Information is important to us, and we use commercially reasonable administrative, technical, and organizational measures designed to protect Personal Information against unauthorized access, alteration, disclosure, or destruction. However, no method of transmission over the Internet or method of electronic storage is 100% secure. While we strive to use commercially acceptable means to protect your Personal Information, we cannot guarantee its absolute security.</p>'
	);

const sectionAutomated = () =>
	titledSection(
		'Automated Decision-Making',
		'<p>We do not use your Personal Information to make decisions based solely on automated processing — including profiling — that produce legal effects concerning you or similarly significantly affect you, except as may be necessary for entering into or performing a contract with you, where authorized by applicable law, or where you have given your explicit consent. If we ever do, we will provide meaningful information about the logic involved and the significance and envisaged consequences of such processing, and you may request human review of any such decision.</p>'
	);

const sectionRights = (a: PrivacyAnswers, c: Computed) => {
	const intro =
		'<p>This section describes your privacy rights under applicable laws and how to exercise them. Even if a particular section does not apply to you, you may always contact us using the methods in the "Contact Us" section to ask about your privacy choices.</p>';
	let body = intro;
	if (a.usStates === 'yes') {
		body += subSection('U.S. State Privacy Rights', usStateRightsBlock(c.companyName));
	}
	if (a.gdpr === 'yes') {
		const fan =
			a.facebookFanPage === 'yes' && a.facebookDetails
				? { name: a.facebookDetails.name ?? '', url: a.facebookDetails.url ?? '' }
				: null;
		body += subSection(
			'EEA, UK, and Swiss Privacy Rights (GDPR)',
			gdprRightsBlock(c.companyName, fan)
		);
	}
	body += subSection(
		'Right to Delete',
		'<p>You have the right to delete or request that we assist in deleting Personal Information that we have collected about you. Our Service may give you the ability to delete certain information from within the Service. You may also contact us to request access to, correct, or delete any personal information that you have provided to us. We may need to retain certain information when we have a legal obligation or lawful basis to do so.</p>'
	);
	return titledSection('Your Privacy Rights', body);
};

const sectionChildren = (a: PrivacyAnswers) => {
	let body =
		'<p>Our Service is not directed to children under the age of 13 (or such higher age threshold as required by applicable law, including 16 for residents of certain jurisdictions). We do not knowingly collect Personal Information from children under 13. If you are a parent or guardian and you become aware that your child has provided us with Personal Information without your consent, please contact us so that we can take appropriate action. If we become aware that we have collected Personal Information from a child under 13 without verification of parental consent, we will take steps to remove that information from our servers.</p><p>For users in the European Economic Area, the United Kingdom, or other jurisdictions where consent from a parent or legal guardian is required for the processing of personal data of minors, we will not knowingly collect or process such data without the appropriate consent.</p>';
	if (a.kids === 'yes') {
		body +=
			'<p><strong>Verifiable parental consent.</strong> Where we knowingly collect Personal Information from a child under 13, we will obtain verifiable parental consent before collection in accordance with the Children’s Online Privacy Protection Act ("COPPA"). Parents may review the Personal Information collected from their child, request that we delete such information, and refuse to permit further collection or use of the child’s Personal Information by contacting us using the methods in the "Contact Us" section.</p>';
	}
	return titledSection('Children’s Privacy', body);
};

const sectionLinks = () =>
	titledSection(
		'Links to Other Websites',
		'<p>Our Service may contain links to other websites that are not operated by us. If you click on a third-party link, you will be directed to that third party’s site. We strongly advise you to review the privacy policy of every site you visit. We have no control over and assume no responsibility for the content, privacy policies, or practices of any third-party sites or services.</p>'
	);

const sectionChanges = () =>
	titledSection(
		'Changes to This Privacy Policy',
		'<p>We may update this Privacy Policy from time to time. We will notify you of any material changes by posting the new Privacy Policy on this page and updating the "Last updated" date at the top of this Privacy Policy. Where required by law, we will provide a more prominent notice or seek your consent. You are advised to review this Privacy Policy periodically for any changes. Changes to this Privacy Policy are effective when they are posted on this page.</p>'
	);

const sectionContact = (a: PrivacyAnswers) => {
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
	return `<section class="space-y-3"><h2 class="text-xl font-semibold">Contact Us</h2><p class="text-base leading-7">If you have any questions about this Privacy Policy, you can contact us:</p>${list(items)}</section>`;
};

export const generatePrivacyHtml = (answers: PrivacyAnswers) => {
	const c = compute(answers);

	const sections: string[] = [
		sectionHeader(c),
		sectionDefinitions(c),
		sectionCategoriesCollected(answers, c),
		sectionSources(),
		sectionUse(answers, c),
		sectionLegalBases(),
		sectionShare(answers, c),
		sectionSaleSharing(answers, c),
		sectionCookies(answers, c),
		sectionEmail(answers, c),
		sectionRemarketing(answers, c),
		sectionRetention(c),
		sectionTransfers(),
		sectionSecurity(),
		sectionAutomated(),
		sectionRights(answers, c),
		sectionChildren(answers),
		sectionLinks(),
		sectionChanges(),
		sectionContact(answers)
	].filter(Boolean);

	return `<section data-role="content">${sections.join('')}</section>`;
};

async function promptWithCustom(
	message: string,
	options: Array<{ value: string; label: string }>,
	customMessage: string
): Promise<string[]> {
	const selection = await p.multiselect({ message, options });
	if (p.isCancel(selection)) onCancel();
	const values = selection as string[];
	if (values.includes('custom')) {
		const custom = await p.text({ message: customMessage });
		if (p.isCancel(custom)) onCancel();
		const idx = values.indexOf('custom');
		if (idx !== -1) values.splice(idx, 1);
		if (custom) values.push(String(custom));
	}
	return values;
}

async function privacyAction(): Promise<void> {
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

	const personalInfo = await p.multiselect({
		message: 'What kind of personal information do you collect from users? Check all that apply',
		options: [
			{ value: 'email', label: 'Email address' },
			{ value: 'name', label: 'First name and last name' },
			{ value: 'phone', label: 'Phone number' },
			{ value: 'address', label: 'Address, State, Province, ZIP/Postal code, City' },
			{
				value: 'social',
				label:
					'Social Media Profile information (ie. from Connect with Facebook, Sign In With Twitter)'
			},
			{ value: 'other', label: 'Others' }
		],
		required: false
	});
	if (p.isCancel(personalInfo)) onCancel();

	const contact = await contactMethods('privacy');

	const tracking = await p.select({
		message: 'Do you use tracking and/or analytics tools, such as Google Analytics?',
		options: [
			{ value: 'yes', label: 'Yes, we use Google Analytics or other related tools' },
			{ value: 'no', label: 'No' }
		]
	});
	if (p.isCancel(tracking)) onCancel();

	let trackingTools: string[] | undefined;
	if (tracking === 'yes') {
		trackingTools = await promptWithCustom(
			'Select the tools you use for tracking and/or analytics',
			[
				{ value: 'ga', label: 'Google Analytics' },
				{ value: 'firebase', label: 'Firebase' },
				{ value: 'matomo', label: 'Matomo (formely Piwik)' },
				{ value: 'clicky', label: 'Clicky' },
				{ value: 'statcounter', label: 'Statcounter' },
				{ value: 'flurry', label: 'Flurry Analytics' },
				{ value: 'mixpanel', label: 'Mixpanel' },
				{ value: 'unity', label: 'Unity Analytics' },
				{ value: 'custom', label: 'Add your own' }
			],
			'Enter your custom tracking/analytics tool name'
		);
	}

	const sendEmails = await p.select({
		message: 'Do you send emails to users?',
		options: [
			{
				value: 'yes',
				label: 'Yes, we send emails to users or users can opt-in to receive emails from us'
			},
			{ value: 'no', label: 'No' }
		]
	});
	if (p.isCancel(sendEmails)) onCancel();

	let emailPlatforms: string[] | undefined;
	if (sendEmails === 'yes') {
		emailPlatforms = await promptWithCustom(
			'Select the platforms you use to send emails',
			[
				{ value: 'mailchimp', label: 'Mailchimp' },
				{ value: 'constant-contact', label: 'Constant Contact' },
				{ value: 'aweber', label: 'AWeber' },
				{ value: 'getresponse', label: 'GetResponse' },
				{ value: 'custom', label: 'Add your own' }
			],
			'Enter your custom email platform'
		);
	}

	const showAds = await p.select({
		message: 'Do you show ads?',
		options: [
			{ value: 'yes', label: 'Yes, we show ads' },
			{ value: 'no', label: 'No' }
		]
	});
	if (p.isCancel(showAds)) onCancel();

	let adsPlatforms: string[] | undefined;
	if (showAds === 'yes') {
		adsPlatforms = await promptWithCustom(
			'Select the platforms you use to show ads',
			[
				{ value: 'adsense', label: 'Google Ads (AdSense)' },
				{ value: 'admob', label: 'AdMob by Google' },
				{ value: 'bing', label: 'Bing Ads' },
				{ value: 'flurry', label: 'Flurry' },
				{ value: 'inmobi', label: 'InMobi' },
				{ value: 'mopub', label: 'MoPub' },
				{ value: 'startapp', label: 'StartApp' },
				{ value: 'adcolony', label: 'AdColony' },
				{ value: 'applovin', label: 'AppLovin' },
				{ value: 'vungle', label: 'Vungle' },
				{ value: 'adbutler', label: 'AdButler' },
				{ value: 'unity-ads', label: 'Unity Ads' },
				{ value: 'custom', label: 'Add your own' }
			],
			'Enter your custom ads platform'
		);
	}

	const canPay = await p.select({
		message: 'Can users pay for products or services?',
		options: [
			{ value: 'yes', label: 'Yes, users can pay for our products/services' },
			{
				value: 'no',
				label: 'No, we do not sell anything or allow users to pay for products/services'
			}
		]
	});
	if (p.isCancel(canPay)) onCancel();

	let paymentProcessors: string[] | undefined;
	if (canPay === 'yes') {
		paymentProcessors = await promptWithCustom(
			'Select the payment processors/methods',
			[
				{ value: 'apple-iap', label: 'Apple Store In-App Payments' },
				{ value: 'google-iap', label: 'Google Play In-App Payments' },
				{ value: 'paypal', label: 'PayPal' },
				{ value: 'braintree', label: 'Braintree' },
				{ value: 'stripe', label: 'Stripe' },
				{ value: 'fastspring', label: 'FastSpring' },
				{ value: 'shopify', label: 'Shopify' },
				{ value: 'square', label: 'Square' },
				{ value: '2checkout', label: '2Checkout' },
				{ value: 'wepay', label: 'WePay' },
				{ value: 'worldpay', label: 'WorldPay' },
				{ value: 'authorize-net', label: 'Authorize.net' },
				{ value: 'sage-pay', label: 'Sage Pay' },
				{ value: 'gocardless', label: 'Go Cardless' },
				{ value: 'elavon', label: 'Elavon' },
				{ value: 'verifone', label: 'Verifone' },
				{ value: 'moneris', label: 'Moneris' },
				{ value: 'wechat', label: 'WeChat' },
				{ value: 'alipay', label: 'Alipay' },
				{ value: 'bank', label: 'Bank Transfer' },
				{ value: 'custom', label: 'Add your own' }
			],
			'Enter your custom payment processor/method'
		);
	}

	const remarketing = await p.select({
		message: 'Do you use remarketing services for marketing & advertising purposes?',
		options: [
			{ value: 'yes', label: 'Yes, we use remarketing services to advertise our business' },
			{ value: 'no', label: 'No' }
		]
	});
	if (p.isCancel(remarketing)) onCancel();

	let remarketingPlatforms: string[] | undefined;
	if (remarketing === 'yes') {
		remarketingPlatforms = await promptWithCustom(
			'Select the platforms you use for remarketing purposes',
			[
				{ value: 'google-ads', label: 'Google Ads (AdWords)' },
				{ value: 'twitter', label: 'Twitter' },
				{ value: 'facebook', label: 'Facebook' },
				{ value: 'bing', label: 'Bing Ads' },
				{ value: 'pinterest', label: 'Pinterest' },
				{ value: 'adroll', label: 'AdRoll' },
				{ value: 'perfect-audience', label: 'Perfect Audience' },
				{ value: 'appnexus', label: 'AppNexus' },
				{ value: 'custom', label: 'Add your own' }
			],
			'Enter your custom remarketing platform'
		);
	}

	const providersRaw = await p.multiselect({
		message: 'Select if you use any of the following providers',
		options: [
			{ value: 'recaptcha', label: 'Invisible reCAPTCHA' },
			{ value: 'google-places', label: 'Google Places' },
			{ value: 'mouseflow', label: 'Mouseflow' },
			{ value: 'freshdesk', label: 'FreshDesk' },
			{ value: 'custom', label: 'Add your own' }
		],
		required: false
	});
	if (p.isCancel(providersRaw)) onCancel();

	const providers = providersRaw as string[];
	if (providers.includes('custom')) {
		const custom = await p.text({ message: 'Enter your custom provider' });
		if (p.isCancel(custom)) onCancel();
		const idx = providers.indexOf('custom');
		if (idx !== -1) providers.splice(idx, 1);
		if (custom) providers.push(String(custom));
	}

	const usStates = await p.select({
		message:
			'Include U.S. state privacy rights (CCPA/CPRA, VCDPA, CPA, CTDPA, UCPA, TX, OR, etc.)?',
		options: [
			{
				value: 'yes',
				label: 'Yes. Include comprehensive U.S. state privacy rights and disclosures'
			},
			{ value: 'no', label: 'No' }
		],
		initialValue: 'yes'
	});
	if (p.isCancel(usStates)) onCancel();

	const gdpr = await p.select({
		message: 'Do you want your Privacy Policy to include GDPR / UK GDPR wording?',
		options: [
			{ value: 'yes', label: 'Yes. Include GDPR rights for EEA, UK, and Swiss residents' },
			{ value: 'no', label: 'No' }
		]
	});
	if (p.isCancel(gdpr)) onCancel();

	let facebookFanPage: 'yes' | 'no' = 'no';
	const facebookDetails: { name: string; url: string } = { name: '', url: '' };
	if (gdpr === 'yes') {
		const fan = await p.select({
			message: 'Do you have a Facebook Fan Page?',
			options: [
				{ value: 'yes', label: 'Yes, we have a Facebook Fan Page' },
				{ value: 'no', label: 'No' }
			]
		});
		if (p.isCancel(fan)) onCancel();
		facebookFanPage = fan as 'yes' | 'no';
		if (facebookFanPage === 'yes') {
			const name = await p.text({
				message: 'What is the name of the Facebook Fan Page?',
				placeholder: 'My Facebook Page'
			});
			if (p.isCancel(name)) onCancel();
			facebookDetails.name = name as string;
			const url = await p.text({
				message: 'What is the URL of the Facebook Fan Page?',
				placeholder: 'https://facebook.com/my-facebook-page'
			});
			if (p.isCancel(url)) onCancel();
			facebookDetails.url = url as string;
		}
	}

	const kids = await p.select({
		message: 'Do you collect information from kids under the age of 13?',
		options: [
			{ value: 'yes', label: 'Yes. We collect information from children under the age of 13' },
			{ value: 'no', label: 'No' }
		]
	});
	if (p.isCancel(kids)) onCancel();

	const retention = await p.text({
		message: 'How long do you retain personal information? (leave blank for default wording)',
		placeholder: 'e.g. 12 months after account closure'
	});
	if (p.isCancel(retention)) onCancel();

	const html = generatePrivacyHtml({
		core,
		personalInfo: (personalInfo ?? []) as Array<
			'phone' | 'address' | 'email' | 'name' | 'social' | 'other'
		>,
		contact,
		tracking: tracking as 'yes' | 'no',
		trackingTools: tracking === 'yes' ? trackingTools : [],
		sendEmails: sendEmails as 'yes' | 'no',
		emailPlatforms: sendEmails === 'yes' ? emailPlatforms : [],
		showAds: showAds as 'yes' | 'no',
		adsPlatforms: showAds === 'yes' ? adsPlatforms : [],
		canPay: canPay as 'yes' | 'no',
		paymentProcessors: canPay === 'yes' ? paymentProcessors : [],
		remarketing: remarketing as 'yes' | 'no',
		remarketingPlatforms: remarketing === 'yes' ? remarketingPlatforms : [],
		providers,
		usStates: usStates as 'yes' | 'no',
		gdpr: gdpr as 'yes' | 'no',
		facebookFanPage,
		facebookDetails,
		kids: kids as 'yes' | 'no',
		retention: retention as string | undefined
	});

	const privacyPage = path.join(
		workspaceRootDir,
		publicRoutesDir,
		LEGAL_DIR,
		'privacy',
		'+page.svelte'
	);
	const privacyPageTs = path.join(
		workspaceRootDir,
		publicRoutesDir,
		LEGAL_DIR,
		'privacy',
		'+page.ts'
	);
	fs.mkdirSync(path.dirname(privacyPage), { recursive: true });
	fs.writeFileSync(privacyPage, html);
	fs.writeFileSync(
		privacyPageTs,
		pageMetaTagsLoader('Privacy Policy', `Privacy Policy for ${core.websiteName}`)
	);

	const relativePrivacyPage = path.relative(workspaceRootDir, privacyPage);
	const relativePrivacyPageTs = path.relative(workspaceRootDir, privacyPageTs);
	reportResult({
		summary: 'Generated placeholder privacy policy.',
		filesCreated: [relativePrivacyPage, relativePrivacyPageTs],
		nextSteps: [
			`Review the generated copy in ${relativePrivacyPage} and fill in company-specific details (data processors, retention, contact info).`,
			'Have the final document reviewed by a lawyer before publishing — this is a starter template, not legal advice.',
			'Link to /privacy from your footer and sign-up flow.'
		]
	});
}

export const privacy = new Command('privacy')
	.description('generate placeholder privacy policy')
	.configureHelp(helpConfig)
	.action(() => runCommand(privacyAction, 'Failed to generate privacy policy.'));
