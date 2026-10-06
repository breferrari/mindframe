/**
 * The core's one public entry point (SPEC.md §7.4, the lift's import rule).
 *
 * A vault's extensions import from here and nowhere else in the core or the
 * vendored libraries. That lets the core rename or split its internals,
 * including the library files under ../lib, without breaking any vault.
 * Everything exported here is the core's promise to extensions; anything
 * not exported is free to change.
 */

export type {
	Declaration,
	Detector,
	Extension,
	Failure,
	Finding,
	HookContext,
	HookEvent,
	MaybePromise,
	Point,
	Section,
	Signal,
	ChecklistItem,
	Validator,
	WriteTarget,
} from "./types.ts";
export { HOOK_EVENTS } from "./types.ts";

/** Frontmatter helpers: one-line field values, and the body without its frontmatter. */
export { extractFrontmatterField, stripFrontmatter } from "../lib/session-start.ts";

/** The note names a body links to, with alias tails, fragments and embeds removed. */
export { extractWikilinkTargets } from "../lib/wikilinks.ts";
