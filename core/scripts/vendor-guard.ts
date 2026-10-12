#!/usr/bin/env node
/**
 * PreToolUse on Edit, Write, MultiEdit and NotebookEdit: a vendored file
 * isn't edited in place by accident (DESIGN.md rule 11).
 *
 * A vendored file is upstream plus patches, so an edit made here without a
 * patch is lost on the next update and fails `vendor check`. The hook denies
 * the edit and names the routes: an extension, a fix upstream, or a local
 * patch. `vendor patch begin <file>` allows edits to that file for 30
 * minutes, and `vendor patch new` ends the window.
 *
 * It is a prompt, not a boundary: on any internal error it allows the edit,
 * and CI's `vendor check` stays the guarantee.
 *
 * Records are every `VENDOR.json` under `.claude/` (up to three folders
 * deep). Their paths resolve as `vendor check` is run on them: the default
 * `.claude/VENDOR.json` against the vault root, any other against its own
 * folder (`check --vault .claude/scripts --record VENDOR.json`).
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { debug, readStdinJson } from "./lib/hook-io.ts";
import { resolveProjectDir } from "./lib/project-dir.ts";

export const GUARDED_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** How long `vendor patch begin` allows edits to a file. */
export const BEGIN_WINDOW_MS = 30 * 60 * 1000;

/** Where `vendor patch begin` keeps its windows: a folder that ignores itself, so nothing here is ever committed. */
export const BEGIN_DIR = path.join(".claude", ".vendor-begin");
const BEGIN_FILE = "windows.json";

/** Where to read how to write an extension. */
export const EXTENSIONS_HOW = "https://github.com/breferrari/mindframe/blob/main/docs/DESIGN.md#the-extension-contract";

/** A vendored file, by its path from the vault root. */
export type Vendored = { readonly rel: string };

const posix = (p: string): string => p.replaceAll("\\", "/");
// Windows paths compare without case: `C:/Vault/x` and `c:/vault/x` are one file.
const fold = (p: string, platform: string): string => (platform === "win32" ? p.toLowerCase() : p);

/** Every `VENDOR.json` under `.claude/`, nearest first, skipping dot folders and node_modules. */
export function findRecords(vaultRoot: string): string[] {
	const found: string[] = [];
	const walk = (dir: string, depth: number) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (e.isFile() && e.name === "VENDOR.json") found.push(path.join(dir, e.name));
		}
		if (depth === 0) return;
		for (const e of entries) {
			if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") walk(path.join(dir, e.name), depth - 1);
		}
	};
	walk(path.join(vaultRoot, ".claude"), 3);
	return found;
}

/** The vendored file at `filePath`, or null when no record lists it. */
export function vendoredAt(vaultRoot: string, filePath: string, platform: string = process.platform): Vendored | null {
	const target = fold(posix(path.resolve(vaultRoot, filePath)), platform);
	const defaultRecord = path.join(vaultRoot, ".claude", "VENDOR.json");
	for (const recordFile of findRecords(vaultRoot)) {
		let record: unknown;
		try {
			record = JSON.parse(readFileSync(recordFile, "utf8"));
		} catch {
			debug(`vendor-guard: ${recordFile} isn't JSON`);
			continue;
		}
		if (typeof record !== "object" || record === null) continue;
		const { files } = record as { files?: unknown };
		if (typeof files !== "object" || files === null) continue;
		const root = fold(posix(recordFile), platform) === fold(posix(defaultRecord), platform) ? vaultRoot : path.dirname(recordFile);
		for (const key of Object.keys(files)) {
			if (fold(posix(path.resolve(root, key)), platform) === target) {
				return { rel: posix(path.relative(vaultRoot, path.resolve(root, key))) };
			}
		}
	}
	return null;
}

/**
 * The deny message. Three routes, in this order: an extension, a fix
 * upstream, a local patch. It names no upstream: a vault may not show its
 * upstream's name at runtime.
 */
export function denyMessage(v: Vendored): string {
	return [
		`${v.rel} is vendored: an edit here is lost on update and fails vendor check. Pick a route:`,
		`1. Customising behaviour? Add an extension in .claude/extensions/ instead, with no upstream change. How: ${EXTENSIONS_HOW}`,
		`2. A bug upstream? Fix it there, or run \`vendor patch begin ${v.rel}\`, edit, then \`vendor patch new <slug> ${v.rel} --issue\`.`,
		`3. A deliberate local change? Run \`vendor patch begin ${v.rel}\`, edit, then \`vendor patch new <slug> ${v.rel} --not-needed "<reason>"\`.`,
	].join("\n");
}

type Windows = Record<string, number>;

function readWindows(vaultRoot: string): Windows {
	try {
		const raw: unknown = JSON.parse(readFileSync(path.join(vaultRoot, BEGIN_DIR, BEGIN_FILE), "utf8"));
		if (typeof raw !== "object" || raw === null) return {};
		return Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === "number"));
	} catch {
		return {};
	}
}

function writeWindows(vaultRoot: string, windows: Windows): void {
	const dir = path.join(vaultRoot, BEGIN_DIR);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, ".gitignore"), "*\n");
	const tmp = path.join(dir, `${BEGIN_FILE}.${process.pid}.tmp`);
	writeFileSync(tmp, `${JSON.stringify(windows, null, 2)}\n`);
	renameSync(tmp, path.join(dir, BEGIN_FILE));
}

/** Opens a window for each file (paths from the vault root), dropping any that have closed. */
export function beginEdits(vaultRoot: string, rels: readonly string[], now: number): void {
	const open = Object.fromEntries(Object.entries(readWindows(vaultRoot)).filter(([, until]) => until > now));
	for (const rel of rels) open[posix(rel)] = now + BEGIN_WINDOW_MS;
	writeWindows(vaultRoot, open);
}

/** Closes the windows for these files: the patch is made. */
export function endEdits(vaultRoot: string, rels: readonly string[]): void {
	const windows = readWindows(vaultRoot);
	if (!rels.some((rel) => posix(rel) in windows)) return;
	for (const rel of rels) delete windows[posix(rel)];
	writeWindows(vaultRoot, windows);
}

export function isBegun(vaultRoot: string, rel: string, now: number, platform: string = process.platform): boolean {
	const want = fold(posix(rel), platform);
	return Object.entries(readWindows(vaultRoot)).some(([r, until]) => fold(r, platform) === want && until > now);
}

/** The reason to deny this tool call, or null to allow it. */
export function decide(input: unknown, vaultRoot: string, now: number, platform: string = process.platform): string | null {
	if (typeof input !== "object" || input === null) return null;
	const { tool_name: tool, tool_input: toolInput } = input as { tool_name?: unknown; tool_input?: unknown };
	if (typeof tool !== "string" || !GUARDED_TOOLS.has(tool)) return null;
	if (typeof toolInput !== "object" || toolInput === null) return null;
	const { file_path: filePath, notebook_path: notebookPath } = toolInput as { file_path?: unknown; notebook_path?: unknown };
	const target = typeof filePath === "string" && filePath ? filePath : typeof notebookPath === "string" && notebookPath ? notebookPath : null;
	if (target === null) return null;
	const v = vendoredAt(vaultRoot, target, platform);
	if (v === null || isBegun(vaultRoot, v.rel, now, platform)) return null;
	return denyMessage(v);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const reason = decide(await readStdinJson(), resolveProjectDir(process.cwd()), Date.now());
		if (reason !== null) {
			process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
		}
	} catch (err) {
		debug(`vendor-guard: failing open (${err instanceof Error ? err.message : String(err)})`);
	}
	process.exit(0);
}
