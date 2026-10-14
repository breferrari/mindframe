/**
 * The vault's instruction files (obsidian-mind #321). `AGENTS.md` is the one every agent
 * reads. A retired one left at the vault root goes wrong silently, each its
 * own way: Claude Code reads a `CLAUDE.md` in place of `AGENTS.md`, and
 * Gemini, where `.gemini/settings.json` points it at `AGENTS.md`, never loads
 * a `GEMINI.md`, so whatever the user added there is lost; elsewhere
 * `GEMINI.md` is still Gemini's manual (`retiredInVault`, #104). A vault's
 * hygiene scan and upgrade plan read this list (obsidian-mind's do), so a file
 * retired later is retired in one place.
 */

import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { VAULT_MARKER } from "./project-dir.ts";

export const INSTRUCTION_FILE = "AGENTS.md";
export const CLAUDE_MD = "CLAUDE.md";
export const GEMINI_MD = "GEMINI.md";

/**
 * Gemini's settings, whose `context.fileName` (or the older top-level
 * `contextFileName`) points it at `AGENTS.md`. A
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

/** `AGENTS.md` and the retired instruction files: every name an agent loads at the vault root (#91). */
export const INSTRUCTION_FILES: readonly string[] = Object.freeze([INSTRUCTION_FILE, ...RETIRED_INSTRUCTION_FILES]);

/**
 * Whether the platform's filesystem ignores case by default, so `claude.md`
 * opens `CLAUDE.md`: Windows, and macOS, whose default APFS is
 * case-insensitive (#91). A guess where a folder is at hand: WSL on an NTFS
 * mount reports linux but ignores case, and a case-sensitive APFS volume
 * reports darwin, so `vaultIgnoresCase` probes the vault root's filesystem
 * and falls back to this (#112).
 */
export function filesystemIgnoresCase(platform: NodeJS.Platform = process.platform): boolean {
	return platform === "win32" || platform === "darwin";
}

/**
 * Whether the filesystem holding `dir` ignores case, by a stat of the vault
 * marker under a case-swapped spelling (#112): the same file (same device and
 * inode) means it ignores case; missing, or a different file, means case
 * matters. A filesystem that gives no inodes (0) ignores case when the
 * swapped spelling opens at all. Null when it can't tell: no marker, or a
 * stat that fails.
 */
export function probeIgnoresCase(dir: string, stat: typeof statSync = statSync): boolean | null {
	try {
		const marker = stat(join(dir, VAULT_MARKER), { bigint: true, throwIfNoEntry: false });
		if (marker === undefined) return null;
		const swapped = stat(join(dir, VAULT_MARKER.toUpperCase()), { bigint: true, throwIfNoEntry: false });
		if (swapped === undefined) return false;
		if (marker.ino === 0n) return true;
		return swapped.dev === marker.dev && swapped.ino === marker.ino;
	} catch {
		return null;
	}
}

/** Each vault root's probed rule, so the probe runs at most once per vault per process. */
const probed = new Map<string, boolean | null>();

/**
 * Whether the vault root's filesystem ignores case: the probe's answer
 * (`probeIgnoresCase`, once per root per process), else the platform's
 * default (`filesystemIgnoresCase`).
 */
export function vaultIgnoresCase(vaultRoot: string, platform: NodeJS.Platform = process.platform, stat: typeof statSync = statSync): boolean {
	const key = resolve(vaultRoot);
	if (!probed.has(key)) probed.set(key, probeIgnoresCase(key, stat));
	return probed.get(key) ?? filesystemIgnoresCase(platform);
}

/** A name or path folded by a case rule: lowercased where the filesystem ignores case. */
const fold = (p: string, ignoresCase: boolean): string => (ignoresCase ? p.toLowerCase() : p);

/** A name or path as `platform`'s filesystem compares it: lowercased where it ignores case (#91). */
export function foldOnDisk(p: string, platform: NodeJS.Platform = process.platform): string {
	return fold(p, filesystemIgnoresCase(platform));
}

/** Whether two names or paths open the same file on `platform` (#91). */
export function sameOnDisk(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
	return foldOnDisk(a, platform) === foldOnDisk(b, platform);
}

/** Whether `name` is one of `names` as the agent would open it, by a case rule. */
function opensAs(name: string, names: readonly string[], ignoresCase: boolean): boolean {
	return names.some((f) => fold(name, ignoresCase) === fold(f, ignoresCase));
}

/**
 * Whether a root file name is a retired instruction file, matched the way the
 * agent loads it (#91): in any case where the filesystem ignores case, as
 * Windows and macOS resolve `claude.md` as `CLAUDE.md`, and in exact case on
 * Linux, where the agent never loads a `claude.md`. These are the names that
 * can be retired; whether this vault has retired one is `retiredInVault`'s
 * question (#104).
 */
export function isRetiredInstructionFile(name: string, platform: NodeJS.Platform = process.platform): boolean {
	return opensAs(name, RETIRED_INSTRUCTION_FILES, filesystemIgnoresCase(platform));
}

/** Whether a root file name is `AGENTS.md` or a retired instruction file, by the same rule (#91). */
export function isInstructionFile(name: string, platform: NodeJS.Platform = process.platform): boolean {
	return opensAs(name, INSTRUCTION_FILES, filesystemIgnoresCase(platform));
}

/**
 * The context files the vault's `.gemini/settings.json` names
 * (`context.fileName`, or the older top-level `contextFileName` Gemini still
 * migrates; a string or a list), or [] when there is none. The file is parsed
 * as gemini-cli 51617c1 parses it: comments are dropped by strip-json-comments'
 * scan (`stripJsonComments`), then a strict `JSON.parse`. A file that doesn't
 * parse names nothing, because Gemini applies none of it either. A BOM is
 * kept, so a BOM'd file doesn't parse, as Gemini refuses it (#119). What Gemini
 * does after parsing is left out: `$VAR` expansion in values, skipping an
 * untrusted folder's settings, and merging the user, system and
 * system-default settings. Lifted from obsidian-mind's
 * hygiene scan (#104), which falls back to a narrow read of the raw text at
 * the recorded commit; dropping comments instead, the v1 key, and keeping the
 * BOM are mindframe's changes to it (obsidian-mind #377 keeps the BOM too).
 */
export function geminiContextFiles(vaultRoot: string): string[] {
	const path = join(vaultRoot, GEMINI_SETTINGS);
	try {
		// Only a regular file: a FIFO at that path would block the hook on read.
		if (statSync(path, { throwIfNoEntry: false })?.isFile() !== true) return [];
		const text = stripJsonComments(readFileSync(path, "utf8"));
		const settings = JSON.parse(text) as { context?: { fileName?: unknown }; contextFileName?: unknown } | null;
		const names = settings?.context?.fileName ?? settings?.contextFileName;
		// Gemini trims each name, so " AGENTS.md" names AGENTS.md there too.
		return (Array.isArray(names) ? names : [names]).filter((n): n is string => typeof n === "string").map((n) => n.trim());
	} catch {
		return [];
	}
}

/**
 * A settings file's text with its comments gone, by strip-json-comments 3.1.1's
 * scan, as gemini-cli reads settings through it: a double quote with an even
 * run of backslashes before it opens or closes a string, so `\"` stays inside
 * one and `\\"` closes it; outside a string, a line comment runs to the line's
 * end and a block comment to its close, or to the end of the file; each comment
 * becomes a space, so `true` split by an empty block comment stays two tokens.
 * A string that never closes runs to the end. One pass, so a damaged file costs
 * no more than a sound one.
 */
function stripJsonComments(text: string): string {
	let out = "";
	let from = 0;
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '"') {
			let slashes = 0;
			for (let j = i - 1; j >= from && text[j] === "\\"; j--) slashes++;
			if (slashes % 2 === 0) inString = !inString;
			continue;
		}
		if (inString) continue;
		const two = text.slice(i, i + 2);
		if (two !== "//" && two !== "/*") continue;
		const close = two === "//" ? text.indexOf("\n", i) : text.indexOf("*/", i + 2);
		const end = close === -1 ? text.length : two === "//" ? close : close + 2;
		out += `${text.slice(from, i)} `;
		from = end;
		i = end - 1;
	}
	return out + text.slice(from);
}

/**
 * Whether the vault's Gemini settings point Gemini at `AGENTS.md` and not at
 * `GEMINI.md`, the names matched as Gemini opens them, by the vault root's
 * case rule (#91, #112): only then is a `GEMINI.md` retired. Without
 * settings, or with a user's own that name no context file, `GEMINI.md` is
 * still Gemini's manual (#104).
 */
export function geminiReadsAgentsMd(
	vaultRoot: string,
	platform: NodeJS.Platform = process.platform,
	ignoresCase: boolean = vaultIgnoresCase(vaultRoot, platform),
): boolean {
	const names = geminiContextFiles(vaultRoot);
	return opensAs(INSTRUCTION_FILE, names, ignoresCase) && !opensAs(GEMINI_MD, names, ignoresCase);
}

/**
 * Whether a root file name is retired in this vault: `CLAUDE.md` always, and
 * `GEMINI.md` only where Gemini reads `AGENTS.md` (#104), each matched by the
 * vault root's case rule (#91: probed, #112, with `platform` the fallback,
 * or `ignoresCase` when given). The settings are read once, when this is
 * called; the returned check reads nothing. `isRetiredInstructionFile` stays
 * vault-free: the frozen list of the names that can be retired.
 */
export function retiredInVault(
	vaultRoot: string,
	platform: NodeJS.Platform = process.platform,
	ignoresCase: boolean = vaultIgnoresCase(vaultRoot, platform),
): (name: string) => boolean {
	const geminiRetired = geminiReadsAgentsMd(vaultRoot, platform, ignoresCase);
	return (name) => opensAs(name, RETIRED_INSTRUCTION_FILES, ignoresCase) && (geminiRetired || !opensAs(name, [GEMINI_MD], ignoresCase));
}
