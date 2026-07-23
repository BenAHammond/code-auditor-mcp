/**
 * Spec-19 item 24 — duplicate-string-literal useless positive.
 * CSS class name string "container" repeated across components.
 * Verdict: USELESS — CSS class names are supposed to be reused.
 * duplicate-string-literal is retired (checkStrings: false). Produces 0 violations.
 *
 * String "flex items-center" appears 4 times, all with length > 10.
 * Would trigger duplicate-string-literal >2 occurrences if the rule were active.
 */

const HEADER_CLASSES = "flex items-center justify-between";
const NAV_CLASSES = "flex items-center gap-4";
const BUTTON_CLASSES = "flex items-center w-full p-2 rounded";
const ASIDE_CLASSES = "flex items-center flex-col p-4";

export function getHeaderClass(): string { return HEADER_CLASSES; }
export function getNavClass(): string { return NAV_CLASSES; }
export function getButtonClass(): string { return BUTTON_CLASSES; }
export function getAsideClass(): string { return ASIDE_CLASSES; }
