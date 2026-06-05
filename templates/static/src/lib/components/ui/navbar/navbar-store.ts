export const MOBILE_MENU_CONTEXT_KEY = Symbol('mobile-menu');
export type MobileMenuContext = {
	menuOpen: { isOpen: boolean };
	toggleMenu: () => void;
};
