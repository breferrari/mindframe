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
	Effect,
	EffectTrigger,
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

/** Write a whole file or none of it: a reader never sees half a note, and a process killed mid-write leaves the old one. */
export { writeFileAtomic } from "../lib/atomic-write.ts";

/** The vault root: the agent's project folder, or `fallback`, walked up to the nearest vault-manifest.json; the folder itself outside a vault. */
export { resolveProjectDir } from "../lib/project-dir.ts";

/** A note line by line: each line's region (frontmatter, fence, heading, body), and each wikilink's target and offsets on a line. */
export { lineRegions, wikilinkSpans } from "../lib/wikilinks.ts";
export type { LineRegion, WikilinkSpan } from "../lib/wikilinks.ts";
