/**
 * The vault's instruction files (obsidian-mind #321). `AGENTS.md` is the one every agent
 * reads. A retired one left at the vault root goes wrong silently, each its
 * own way: Claude Code reads a `CLAUDE.md` in place of `AGENTS.md`, and
 * Gemini, which now reads `AGENTS.md` through `.gemini/settings.json`, never
 * loads a `GEMINI.md`, so whatever the user added there is lost. A vault's
 * hygiene scan and upgrade plan read this list (obsidian-mind's do), so a file
 * retired later is retired in one place.
 */

export const INSTRUCTION_FILE = "AGENTS.md";
export const CLAUDE_MD = "CLAUDE.md";
export const GEMINI_MD = "GEMINI.md";

/**
 * Gemini's settings, whose `context.fileName` points it at `AGENTS.md`. A
 * user's own older copy names no context file, so Gemini reads `GEMINI.md`,
 * which in the old release only says "read CLAUDE.md".
 */
export const GEMINI_SETTINGS = ".gemini/settings.json";

/**
 * The size `AGENTS.md` stays under. Measured 2026-10-06 (obsidian-mind #321): Antigravity
 * 1.3.0 truncated a 36 KB `AGENTS.md` between byte 23,860 and byte 24,305,
 * silently, and Codex CLI 0.160.0 stopped consistent with a 32 KiB cap; this
 * leaves ~2 KB of margin under the first. obsidian-mind's template test
 * fails at it.
 */
export const AGENTS_MD_MAX_BYTES = 22_000;

/**
 * Where a hygiene scan flags a vault's own AGENTS.md: 1 KB above the
 * template's cap, so a user's first additions are not a finding, and still
 * under byte 23,860, the last one Antigravity was seen to read.
 */
export const AGENTS_MD_FLAG_BYTES = 23_000;

/** Frozen: every extension shares one process, so none may change the list the others' checks read. */
export const RETIRED_INSTRUCTION_FILES: readonly string[] = Object.freeze([CLAUDE_MD, GEMINI_MD]);

/**
 * Whether the platform's filesystem ignores case, so `claude.md` opens
 * `CLAUDE.md`: Windows, and macOS, whose default APFS is case-insensitive. A
 * case-sensitive APFS volume is an opt-in exception this doesn't detect; on it
 * a vault is read as macOS's default (#91).
 */
export function filesystemIgnoresCase(platform: NodeJS.Platform = process.platform): boolean {
	return platform === "win32" || platform === "darwin";
}

/** Whether `name` is one of `names` as the agent would open it on `platform`. */
function opensAs(name: string, names: readonly string[], platform: NodeJS.Platform): boolean {
	if (!filesystemIgnoresCase(platform)) return names.includes(name);
	const lower = name.toLowerCase();
	return names.some((f) => f.toLowerCase() === lower);
}

/**
 * Whether a root file name is a retired instruction file, matched the way the
 * agent loads it (#91): in any case where the filesystem ignores case, as
 * Windows and macOS resolve `claude.md` as `CLAUDE.md`, and in exact case on
 * Linux, where the agent never loads a `claude.md`.
 */
export function isRetiredInstructionFile(name: string, platform: NodeJS.Platform = process.platform): boolean {
	return opensAs(name, RETIRED_INSTRUCTION_FILES, platform);
}

/** Whether a root file name is `AGENTS.md` or a retired instruction file, by the same rule (#91). */
export function isInstructionFile(name: string, platform: NodeJS.Platform = process.platform): boolean {
	return opensAs(name, [INSTRUCTION_FILE, ...RETIRED_INSTRUCTION_FILES], platform);
}
