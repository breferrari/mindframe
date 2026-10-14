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
/** The parsed manifest an extension receives as `ctx.manifest`: frozen, or null. */
export type { ManifestObject } from "../lib/manifest.ts";
export { HOOK_EVENTS } from "./types.ts";

/** Frontmatter helpers: one-line field values, and the body without its frontmatter. */
export { extractFrontmatterField, stripFrontmatter } from "../lib/session-start.ts";

/** Where a note's frontmatter is, by the core's one rule: its yaml and where the body starts, or null. */
export { frontmatterBlock } from "../lib/frontmatter-block.ts";

/** The note names a body links to, with alias tails, fragments and embeds removed. */
export { extractWikilinkTargets } from "../lib/wikilinks.ts";

/** Write a whole file or none of it: a reader never sees half a note, and a process killed mid-write leaves the old one. */
export { writeFileAtomic } from "../lib/atomic-write.ts";

/** A trace line on stderr when HOOK_DEBUG=1, and nothing otherwise: hooks print nothing else of their own. */
export { debug } from "../lib/hook-io.ts";

/**
 * A warning on stderr, always: for a standalone script an extension ships
 * (the qmd extension's bootstrap, #96), never for a hook, whose output is
 * the core's to write. Use `debug` in a hook.
 */
export { warn } from "../lib/hook-io.ts";

/** A string as a literal inside a RegExp: for an extension that builds a pattern from a name (the qmd extension's ignore and collection rules, #96). */
export { escapeRegex } from "../lib/regex.ts";

/** The manifest a script read as text, parsed as openVault parses it: for a standalone script that runs outside a hook (the qmd extension's bootstrap, #96). */
export { manifestOf } from "../lib/manifest.ts";

/** The vault root, walked up from the agent's project folder or a fallback (documented on the function). */
export { resolveProjectDir } from "../lib/project-dir.ts";

/**
 * The vault's instruction file (AGENTS.md), the retired ones (a frozen list)
 * and a check for them, which of them this vault has retired (GEMINI.md only
 * where Gemini reads AGENTS.md, #104), the platform's case rule for names and
 * paths, and AGENTS.md's measured size caps.
 */
export {
	AGENTS_MD_FLAG_BYTES,
	AGENTS_MD_MAX_BYTES,
	CLAUDE_MD,
	GEMINI_MD,
	GEMINI_SETTINGS,
	INSTRUCTION_FILE,
	RETIRED_INSTRUCTION_FILES,
	filesystemIgnoresCase,
	probeIgnoresCase,
	vaultIgnoresCase,
	geminiContextFiles,
	geminiReadsAgentsMd,
	isInstructionFile,
	isRetiredInstructionFile,
	retiredInVault,
	sameOnDisk,
} from "../lib/instruction-files.ts";

/** A note line by line: each line's region (frontmatter, fence, heading, body), and each wikilink's target and offsets on a line. */
export { lineRegions, wikilinkSpans } from "../lib/wikilinks.ts";
export type { LineRegion, WikilinkSpan } from "../lib/wikilinks.ts";
