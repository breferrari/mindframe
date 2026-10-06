/**
 * The vendor record, VENDOR.json, and the offline check (DESIGN.md rule 11).
 *
 * A vault keeps a copy of the core and its chosen extensions, and the copy
 * is upstream plus patches, nothing else. VENDOR.json records where the copy
 * came from and, per file, the hash of the bytes as vendored (`sha256`), the
 * hash of upstream's bytes at the recorded commit (`upstreamSha256`), and
 * the patches that turn one into the other (`patches`, in apply order).
 * A local change exists only as a patch in `vendor-patches/` beside the
 * record, with a DEP-3 header saying what it does (`Description`) and where
 * it went upstream (`Forwarded`: an issue or PR URL, or
 * `not-needed: <reason>`).
 *
 * `check` needs no network and no pristine copy: it reads the vault's bytes,
 * undoes each patch exactly, last first, and requires the result to hash to
 * `upstreamSha256`.
 *
 * Schema 3 replaces schema 2's `modified` flag and one-line `change` with
 * real patches; every other field keeps its name and meaning. `migrate`
 * converts a schema-2 record. A schema-1 record has no hashes, so nothing it
 * says can be checked.
 *
 * Text and binary. A Windows checkout with core.autocrlf=true has CRLF in
 * its working tree, and a raw hash would call every file edited. So a text
 * file is hashed with CRLF read as LF; a binary file is hashed raw, and
 * can't carry patches. A file is binary when its first 8 KB hold a NUL
 * byte, the same test git uses.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { applyFile, diffFile, formatPatch, merge3, parsePatch, PatchError, type FilePatch, type Patch } from "./patch.ts";

export const SCHEMA_VERSION = 3;
export const DEFAULT_RECORD = ".claude/VENDOR.json";
export const PATCH_DIR = "vendor-patches";

/** How far into a file the binary test looks. */
const BINARY_SNIFF = 8000;

/** A patch file's name: four digits, then a slug. */
export const PATCH_NAME = /^\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.patch$/;

export type FileEntry = {
	readonly upstream: string;
	readonly sha256?: string;
	readonly upstreamSha256?: string;
	/** Schema 3: the patches on this file, in apply order. */
	readonly patches?: readonly string[];
	/** Schema 1 and 2 only. */
	readonly modified?: boolean;
	readonly change?: string;
};

export type VendorRecord = {
	readonly schemaVersion: number;
	readonly repository: string;
	readonly commit: string;
	readonly files: Readonly<Record<string, FileEntry>>;
	readonly sourceRoot?: string;
	readonly [key: string]: unknown;
};

export class VendorError extends Error {}

// ---- bytes --------------------------------------------------------------------

export function isBinary(bytes: Uint8Array): boolean {
	const end = Math.min(bytes.length, BINARY_SNIFF);
	for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
	return false;
}

/** CRLF read as LF; lone CRs are left alone, as git leaves them. */
export function toLf(bytes: Uint8Array): Uint8Array {
	const out = new Uint8Array(bytes.length);
	let n = 0;
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) continue;
		out[n++] = bytes[i]!;
	}
	return out.subarray(0, n);
}

/** The hash a record stores for these bytes: text with CRLF as LF, binary raw. */
export function contentHash(bytes: Uint8Array): string {
	return createHash("sha256")
		.update(isBinary(bytes) ? bytes : toLf(bytes))
		.digest("hex");
}

const textHash = (text: string): string => createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");

// ---- paths --------------------------------------------------------------------

/** A relative POSIX path that stays inside its folder: no `..`, no root, no backslash. */
export function isInsidePath(p: string): boolean {
	return (
		typeof p === "string" &&
		p !== "" &&
		!p.startsWith("/") &&
		!/^[A-Za-z]:/.test(p) &&
		!p.includes("\\") &&
		!p.split("/").includes("..") &&
		!p.split("/").includes(".")
	);
}

/**
 * The file a record path names under `root`, refusing one that leaves the
 * root or passes through a symlink at any depth: a symlink would let the
 * check hash a file outside the vault, or follow a link someone swapped.
 */
export function resolveInside(root: string, rel: string): string {
	if (!isInsidePath(rel)) throw new VendorError(`${rel}: not a relative path inside the vault`);
	let at = root;
	for (const part of rel.split("/")) {
		at = path.join(at, part);
		if (existsSync(at) && lstatSync(at).isSymbolicLink()) throw new VendorError(`${rel}: is or passes through a symlink`);
	}
	return at;
}

/** The patch folder for a record: `vendor-patches/` beside it. */
export const patchDirFor = (recordFile: string): string => path.join(path.dirname(recordFile), PATCH_DIR);

// ---- the record ---------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;

/** Checks a parsed VENDOR.json of schema 1, 2 or 3; returns it typed. */
export function parseRecord(raw: unknown): VendorRecord {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new VendorError("VENDOR.json must be an object");
	const r = raw as Record<string, unknown>;
	if (r.schemaVersion !== 1 && r.schemaVersion !== 2 && r.schemaVersion !== 3) throw new VendorError(`unknown schemaVersion ${String(r.schemaVersion)}`);
	if (typeof r.repository !== "string" || r.repository === "") throw new VendorError("repository is required");
	if (typeof r.commit !== "string" || !/^[0-9a-f]{40}$/.test(r.commit)) throw new VendorError("commit must be a full 40-character commit");
	if (r.sourceRoot !== undefined && (typeof r.sourceRoot !== "string" || !isInsidePath(r.sourceRoot))) {
		throw new VendorError("sourceRoot must be a relative path");
	}
	if (!r.files || typeof r.files !== "object" || Array.isArray(r.files)) throw new VendorError("files must be an object");
	for (const [file, e] of Object.entries(r.files as Record<string, unknown>)) {
		if (!isInsidePath(file)) throw new VendorError(`${file}: not a relative path inside the vault`);
		const entry = e as Record<string, unknown>;
		if (!entry || typeof entry !== "object") throw new VendorError(`${file}: entry must be an object`);
		if (typeof entry.upstream !== "string" || !isInsidePath(entry.upstream)) throw new VendorError(`${file}: upstream must be a relative path`);
		if (r.schemaVersion !== 3) {
			if (typeof entry.modified !== "boolean") throw new VendorError(`${file}: modified must be true or false`);
			if (entry.change !== undefined && (typeof entry.change !== "string" || entry.change === "" || entry.change.includes("\n"))) {
				throw new VendorError(`${file}: change must be one non-empty line`);
			}
		} else {
			if ("modified" in entry || "change" in entry) throw new VendorError(`${file}: schema 3 has patches, not modified or change`);
			if (entry.patches !== undefined) {
				if (!Array.isArray(entry.patches) || !entry.patches.every((p) => typeof p === "string" && PATCH_NAME.test(p))) {
					throw new VendorError(`${file}: patches must be patch file names like 0001-fix-the-thing.patch`);
				}
				if (new Set(entry.patches).size !== entry.patches.length) throw new VendorError(`${file}: a patch is listed twice`);
			}
		}
		if (r.schemaVersion !== 1) {
			for (const k of ["sha256", "upstreamSha256"]) {
				if (typeof entry[k] !== "string" || !HEX64.test(entry[k] as string)) throw new VendorError(`${file}: ${k} must be a sha256 in hex`);
			}
		}
	}
	return r as VendorRecord;
}

/** `value` with every object's keys sorted, at every depth. */
function sortedKeys(value: unknown): unknown {
	if (Array.isArray(value) || value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, sortedKeys((value as Record<string, unknown>)[key])]),
	);
}

/** The record's bytes: keys sorted at every depth, two-space JSON, a trailing newline. */
export function formatRecord(record: VendorRecord): string {
	return `${JSON.stringify(sortedKeys(record), null, 2)}\n`;
}

export function readRecord(file: string): VendorRecord {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (err) {
		throw new VendorError(`cannot read ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
	}
	return parseRecord(raw);
}

// ---- patches ------------------------------------------------------------------

/** A header field's value, or undefined. */
export const headerOf = (p: Patch, key: string): string | undefined => p.header.find(([k]) => k === key)?.[1];

/** `Forwarded` must say where the change went upstream, or why it doesn't go. */
export function forwardedProblem(value: string | undefined): string | null {
	if (value === undefined || value.trim() === "") return "Forwarded is empty: give the upstream issue or PR URL, or not-needed: <reason>";
	if (/^https?:\/\/\S+$/.test(value.trim())) return null;
	if (/^not-needed:\s*\S/.test(value.trim())) return null;
	return `Forwarded is "${value}": give the upstream issue or PR URL, or not-needed: <reason>`;
}

export type PatchSet = ReadonlyMap<string, { readonly patch: Patch | null; readonly error: string | null }>;

/** Every patch file in a folder, parsed; a file that won't parse carries its error. */
export function readPatchDir(dir: string): PatchSet {
	const out = new Map<string, { patch: Patch | null; error: string | null }>();
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir).sort()) {
		if (!name.endsWith(".patch")) continue;
		try {
			out.set(name, { patch: parsePatch(readFileSync(path.join(dir, name), "utf8")), error: null });
		} catch (err) {
			out.set(name, { patch: null, error: err instanceof Error ? err.message : String(err) });
		}
	}
	return out;
}

/** The text a file's patches, undone last first, lead back to. Throws PatchError. */
export function unpatch(file: string, text: string, names: readonly string[], patches: PatchSet): string {
	let at = text;
	for (const name of [...names].reverse()) {
		const p = patches.get(name)?.patch;
		if (!p) throw new PatchError(`${name} is missing or unreadable`);
		const section = p.files.find((f) => f.path === file);
		if (!section) throw new PatchError(`${name} has no change to ${file}`);
		at = applyFile(at, section, true);
	}
	return at;
}

/** The text a file's patches, applied first to last, lead to. Throws PatchError. */
export function repatch(file: string, text: string, names: readonly string[], patches: PatchSet): string {
	let at = text;
	for (const name of names) {
		const p = patches.get(name)?.patch;
		if (!p) throw new PatchError(`${name} is missing or unreadable`);
		const section = p.files.find((f) => f.path === file);
		if (!section) throw new PatchError(`${name} has no change to ${file}`);
		at = applyFile(at, section);
	}
	return at;
}

// ---- record -------------------------------------------------------------------

export type RecordInput = {
	/** The vault root. */
	readonly vault: string;
	/** An upstream checkout at the commit being vendored from. */
	readonly upstreamRoot: string;
	readonly commit: string;
	/** The record so far: an existing VENDOR.json, or the metadata for a new one. */
	readonly base: Omit<VendorRecord, "schemaVersion" | "files" | "commit"> & { readonly files?: VendorRecord["files"] };
	/** Vault paths to (re)record; each maps to upstream at the same path unless the base says otherwise. */
	readonly paths: readonly string[];
	/** The record's patch folder, for files that already carry patches. */
	readonly patches?: PatchSet;
};

/**
 * A schema-3 record for `paths`, hashed from the vault and the upstream
 * checkout. A file that differs from upstream must already carry patches
 * that take it exactly back to upstream; otherwise it is refused, because
 * a local change is made with `vendor patch new`, never recorded bare.
 * Entries not re-recorded keep their hashes only if they already have them.
 */
export function buildRecord(input: RecordInput): VendorRecord {
	const sourceRoot = typeof input.base.sourceRoot === "string" ? input.base.sourceRoot : "";
	const prior = input.base.files ?? {};
	const patchSet = input.patches ?? new Map();
	const files: Record<string, FileEntry> = {};
	const problems: string[] = [];

	for (const [file, entry] of Object.entries(prior)) {
		if (input.paths.includes(file)) continue;
		if (entry.sha256 === undefined || entry.upstreamSha256 === undefined) {
			problems.push(`${file}: in the record without hashes; record it too`);
			continue;
		}
		const { modified: _m, change: _c, ...kept } = entry;
		files[file] = kept;
	}

	for (const file of input.paths) {
		let own: Uint8Array;
		let theirs: Uint8Array;
		const upstream = prior[file]?.upstream ?? file;
		try {
			own = readFileSync(resolveInside(input.vault, file));
		} catch (err) {
			problems.push(err instanceof VendorError ? err.message : `${file}: cannot read it in the vault`);
			continue;
		}
		try {
			const up = sourceRoot === "" ? upstream : `${sourceRoot}/${upstream}`;
			theirs = readFileSync(resolveInside(input.upstreamRoot, up));
		} catch (err) {
			problems.push(err instanceof VendorError ? `upstream ${err.message}` : `${file}: upstream ${upstream} is not in the checkout`);
			continue;
		}
		const sha256 = contentHash(own);
		const upstreamSha256 = contentHash(theirs);
		const names = prior[file]?.patches ?? [];
		if (sha256 === upstreamSha256) {
			if (names.length > 0) problems.push(`${file}: matches upstream, yet lists patches ${names.join(", ")}`);
			else files[file] = { upstream, sha256, upstreamSha256 };
			continue;
		}
		if (names.length === 0 || isBinary(own)) {
			problems.push(`${file}: differs from upstream; make the change a patch with \`vendor patch new\``);
			continue;
		}
		try {
			if (textHash(unpatch(file, Buffer.from(own).toString("utf8"), names, patchSet)) !== upstreamSha256) {
				problems.push(`${file}: its patches don't lead back to upstream`);
				continue;
			}
		} catch (err) {
			problems.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		files[file] = { upstream, sha256, upstreamSha256, patches: names };
	}

	if (problems.length) throw new VendorError(problems.join("\n"));
	const { modified: _m, change: _c, ...base } = input.base as Record<string, unknown>;
	return { ...base, schemaVersion: SCHEMA_VERSION, commit: input.commit, files } as VendorRecord;
}

// ---- migrate ------------------------------------------------------------------

export type MigrateInput = {
	readonly vault: string;
	readonly upstreamRoot: string;
	readonly record: VendorRecord;
	/** Names already in the patch folder, so new numbers don't collide. */
	readonly existing: readonly string[];
	/** The Last-Update date, YYYY-MM-DD. */
	readonly today: string;
};

/** A path as a patch slug: the file name without its extension, lowercased. */
export function slugOf(file: string): string {
	const base = path.posix.basename(file).replace(/\.[^.]+$/, "");
	return base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "file";
}

/**
 * Converts a schema-2 record to schema 3. Each `modified` file becomes one
 * patch: the diff from upstream to the vault's bytes, with the old `change`
 * line as its Description and Forwarded left empty. `check` fails until
 * Forwarded is filled, so every local change gets an upstream answer on day
 * one.
 */
export function migrate(input: MigrateInput): { record: VendorRecord; patches: Array<{ name: string; text: string }> } {
	if (input.record.schemaVersion !== 2) throw new VendorError(`migrate converts schema 2; this record is schema ${input.record.schemaVersion}${input.record.schemaVersion === 1 ? " (run record first)" : ""}`);
	const sourceRoot = typeof input.record.sourceRoot === "string" ? input.record.sourceRoot : "";
	let next = Math.max(0, ...input.existing.map((n) => Number(n.slice(0, 4)))) + 1;
	const files: Record<string, FileEntry> = {};
	const patches: Array<{ name: string; text: string }> = [];
	const problems: string[] = [];
	for (const [file, entry] of Object.entries(input.record.files).sort(([a], [b]) => (a < b ? -1 : 1))) {
		const { modified, change, ...rest } = entry;
		if (!modified) {
			files[file] = rest;
			continue;
		}
		const own = readFileSync(resolveInside(input.vault, file));
		const up = sourceRoot === "" ? entry.upstream : `${sourceRoot}/${entry.upstream}`;
		const theirs = readFileSync(resolveInside(input.upstreamRoot, up));
		if (contentHash(theirs) !== entry.upstreamSha256) {
			problems.push(`${file}: the upstream checkout isn't at the recorded commit (its hash differs)`);
			continue;
		}
		if (isBinary(own) || isBinary(theirs)) {
			problems.push(`${file}: a binary file can't carry a patch; vendor it unmodified or keep it out of the record`);
			continue;
		}
		const diff = diffFile(file, Buffer.from(theirs).toString("utf8"), Buffer.from(own).toString("utf8"));
		if (diff === null) {
			files[file] = rest;
			continue;
		}
		const name = `${String(next++).padStart(4, "0")}-${slugOf(file)}.patch`;
		const text = formatPatch({
			header: [
				["Description", change ?? `local change to ${file}`],
				["Forwarded", ""],
				["Last-Update", input.today],
			],
			files: [diff],
		});
		patches.push({ name, text });
		files[file] = { ...rest, patches: [name] };
	}
	if (problems.length) throw new VendorError(problems.join("\n"));
	return { record: { ...input.record, schemaVersion: SCHEMA_VERSION, files } as VendorRecord, patches };
}

// ---- patch new ----------------------------------------------------------------

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The next free patch number in a folder, as four digits. */
export const nextNumber = (existing: readonly string[]): string => String(Math.max(0, ...existing.map((n) => Number(n.slice(0, 4)) || 0)) + 1).padStart(4, "0");

/** A file's upstream path inside an upstream checkout. */
export const upstreamPathOf = (record: VendorRecord, file: string): string => {
	const up = record.files[file]?.upstream ?? file;
	return typeof record.sourceRoot === "string" && record.sourceRoot !== "" ? `${record.sourceRoot}/${up}` : up;
};

export type NewPatchInput = {
	readonly vault: string;
	readonly upstreamRoot: string;
	readonly record: VendorRecord;
	readonly patches: PatchSet;
	readonly slug: string;
	readonly files: readonly string[];
	/** Description, Forwarded and the rest, in order. */
	readonly header: ReadonlyArray<readonly [string, string]>;
};

/**
 * Turns local edits to vendored files into one new patch. Each file's
 * change is measured from upstream plus the patches it already carries, so
 * a new patch stacks on the old ones. Returns the patch and the record with
 * the patch listed and the new hashes; writes nothing.
 */
export function newPatch(input: NewPatchInput): { name: string; text: string; record: VendorRecord } {
	if (input.record.schemaVersion !== SCHEMA_VERSION) throw new VendorError(`the record is schema ${input.record.schemaVersion}; run migrate first`);
	if (!SLUG.test(input.slug)) throw new VendorError(`${input.slug}: a slug is lowercase words joined by dashes`);
	if (input.files.length === 0) throw new VendorError("name the files the patch changes");
	const fwd = forwardedProblem(input.header.find(([k]) => k === "Forwarded")?.[1]);
	if (fwd) throw new VendorError(fwd);
	if (!input.header.find(([k]) => k === "Description")?.[1]?.trim()) throw new VendorError("a patch needs a Description");

	const name = `${nextNumber([...input.patches.keys()])}-${input.slug}.patch`;
	const diffs: FilePatch[] = [];
	const files: Record<string, FileEntry> = { ...input.record.files };
	const problems: string[] = [];
	for (const file of input.files) {
		const entry = input.record.files[file];
		if (!entry) {
			problems.push(`${file}: not in the record; only vendored files take patches`);
			continue;
		}
		const own = readFileSync(resolveInside(input.vault, file));
		const theirs = readFileSync(resolveInside(input.upstreamRoot, upstreamPathOf(input.record, file)));
		if (contentHash(theirs) !== entry.upstreamSha256) {
			problems.push(`${file}: the upstream checkout isn't at the recorded commit (its hash differs)`);
			continue;
		}
		if (isBinary(own) || isBinary(theirs)) {
			problems.push(`${file}: a binary file can't carry a patch`);
			continue;
		}
		let base: string;
		try {
			base = repatch(file, Buffer.from(theirs).toString("utf8"), entry.patches ?? [], input.patches);
		} catch (err) {
			problems.push(`${file}: its existing patches don't apply to upstream: ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		const diff = diffFile(file, base, Buffer.from(own).toString("utf8"));
		if (diff === null) {
			problems.push(`${file}: no change to make a patch of`);
			continue;
		}
		diffs.push(diff);
		files[file] = { ...entry, sha256: contentHash(own), patches: [...(entry.patches ?? []), name] };
	}
	if (problems.length) throw new VendorError(problems.join("\n"));
	const text = formatPatch({ header: input.header, files: diffs });
	return { name, text, record: { ...input.record, files } };
}

/** `owner/repo` from a GitHub URL, for gh's --repo. */
export function repoSlug(repository: string): string {
	const m = /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/.exec(repository);
	if (!m) throw new VendorError(`${repository}: not a GitHub repository URL; give --forward <url> instead`);
	return `${m[1]}/${m[2]}`;
}

/** A patch with one header field set (added at the end when absent). */
export function withHeader(p: Patch, key: string, value: string): Patch {
	const has = p.header.some(([k]) => k === key);
	const header = has ? p.header.map(([k, v]) => (k === key ? ([k, value] as const) : ([k, v] as const))) : [...p.header, [key, value] as const];
	return { ...p, header };
}

// ---- publishing guard ---------------------------------------------------------

/**
 * What must never be posted to a public tracker from a vault: a local
 * absolute path (a user's home or drive path) or a session artifact. The
 * same patterns as CI's artifact grep (.github/workflows/ci.yml).
 */
const PRIVATE = /claude\.ai\/(code\/)?session|^Claude-Session:|(^|[^A-Za-z0-9/])[A-Za-z]:(\\{1,2}|\/)[A-Za-z0-9_.-]+(\\{1,2}|\/)[A-Za-z0-9_.-]+(\\{1,2}|\/)|\/Users\/[^/\s]+\/|\/home\/[^/\s]+\//m;

/** Lines of `text` that would leak a local path or a session artifact. */
export function privateLines(text: string): string[] {
	return text.split("\n").filter((l) => PRIVATE.test(l));
}

/**
 * A Description becomes an issue or PR title, so it must read as the change
 * to make ("Give the meter a trailing newline"), not as a statement about
 * the code ("The meter lacks a newline."). A light check for the obvious
 * statement forms; review catches the rest.
 */
export function statementProblem(description: string): string | null {
	const d = description.trim();
	if (/^(the|it|this|these|there|a|an)\b/i.test(d)) return `Description reads as a statement ("${d}"): write the change to make, verb first, e.g. "Give the meter a trailing newline"`;
	if (d.endsWith(".")) return `Description ends with a period ("${d}"): write it as a title, the change to make, verb first`;
	return null;
}

// ---- update -------------------------------------------------------------------

export type UpdateInput = {
	readonly vault: string;
	/** An upstream checkout at the commit to update to. */
	readonly upstreamRoot: string;
	readonly commit: string;
	readonly record: VendorRecord;
	readonly patches: PatchSet;
	/** Files whose conflict markers have been resolved by hand; their vault bytes are taken as the result. */
	readonly resolved?: readonly string[];
};

export type UpdatePlan = {
	/** The record at the new commit; null when there are conflicts. */
	readonly record: VendorRecord | null;
	/** Vault files to write: the new upstream with patches, or merged text with conflict markers. */
	readonly files: ReadonlyArray<{ readonly file: string; readonly bytes: Uint8Array }>;
	/** Patch files to rewrite, with refreshed hunks or an Applied-Upstream header. */
	readonly patchFiles: ReadonlyArray<{ readonly name: string; readonly text: string }>;
	readonly retired: readonly string[];
	readonly conflicts: readonly string[];
};

/**
 * Moves a vault's vendored files to a new upstream commit, carrying its
 * patches across. For each file, the old upstream is rebuilt by undoing the
 * vault's patches (so no pristine copy is needed); then each patch is
 * re-applied exactly to the new upstream:
 * - it applies: kept, its hunks rewritten for the new line numbers;
 * - it doesn't, but undoing it does: upstream already has it, and it
 *   retires for this file (the two-check rule); a patch retired from every
 *   file it touched gets Applied-Upstream and leaves the record;
 * - neither: a conflict. The file gets a three-way merge (base: the old
 *   upstream, ours: the vault, theirs: the new upstream) with markers, and
 *   nothing else is written.
 * After the markers are resolved, `resolved` names the file: its bytes are
 * taken as the result, and the file's remaining changes are folded into its
 * first conflicting patch.
 * Computes everything; writes nothing.
 */
export function planUpdate(input: UpdateInput): UpdatePlan {
	const { record, patches } = input;
	if (record.schemaVersion !== SCHEMA_VERSION) throw new VendorError(`the record is schema ${record.schemaVersion}; run migrate first`);
	const short = input.commit.slice(0, 7);
	const files: Array<{ file: string; bytes: Uint8Array }> = [];
	const text = (t: string): Uint8Array => Buffer.from(t, "utf8");
	const conflicts: string[] = [];
	const entries: Record<string, FileEntry> = {};
	// Per patch: its sections as they stand after the update, and which files it still changes.
	const sections = new Map<string, Map<string, FilePatch | null>>();
	const setSection = (name: string, file: string, section: FilePatch | null) => {
		if (!sections.has(name)) sections.set(name, new Map());
		sections.get(name)!.set(file, section);
	};
	const problems: string[] = [];

	for (const file of Object.keys(record.files).sort()) {
		const entry = record.files[file]!;
		const names = entry.patches ?? [];
		let ownBytes: Uint8Array;
		let newBytes: Uint8Array;
		try {
			ownBytes = readFileSync(resolveInside(input.vault, file));
		} catch {
			problems.push(`${file}: missing in the vault; run check`);
			continue;
		}
		try {
			newBytes = readFileSync(resolveInside(input.upstreamRoot, upstreamPathOf(record, file)));
		} catch {
			problems.push(`${file}: no longer upstream at ${short}; drop it from the record or vendor its replacement`);
			continue;
		}
		const newHash = contentHash(newBytes);
		if (names.length === 0) {
			if (contentHash(ownBytes) !== entry.upstreamSha256) {
				problems.push(`${file}: edited without a patch; run check`);
				continue;
			}
			entries[file] = { upstream: entry.upstream, sha256: newHash, upstreamSha256: newHash };
			files.push({ file, bytes: newBytes });
			continue;
		}
		const own = Buffer.from(ownBytes).toString("utf8");
		const theirs = Buffer.from(newBytes).toString("utf8");

		/** The patches after the one at `i` that also change this file. */
		const later = (i: number) => names.slice(i + 1).filter((n) => patches.get(n)?.patch?.files.some((p) => p.path === file));
		const combine = (stuck: string, i: number, how: string) =>
			`${file}: ${stuck} ${how}, but the patches after it (${later(i).join(", ")}) also change it; combine them into one patch with "vendor patch new", then update`;
		// Carries the file's patches onto the new upstream, in order. A patch
		// that applies (its lines may have moved; its context must match
		// exactly) is kept and re-anchored; one whose change upstream already
		// has retires for this file. At the first that does neither, the rest of
		// the change, up to `final`, folds into that patch; with no `final`, the
		// carry stops there.
		type Carried = { readonly at: string; readonly kept: string[] } | { readonly stuck: string; readonly index: number };
		const carry = (final: string | null): Carried => {
			let at = theirs;
			const kept: string[] = [];
			for (const [i, name] of names.entries()) {
				const section = patches.get(name)?.patch?.files.find((p) => p.path === file);
				if (!section) continue;
				try {
					const next = applyFile(at, section, false, { offset: true });
					setSection(name, file, diffFile(file, at, next));
					at = next;
					kept.push(name);
					continue;
				} catch {
					/* not as it stands: absorbed, or it needs a merge */
				}
				try {
					applyFile(at, section, true, { offset: true });
					setSection(name, file, null); // upstream has it already
					continue;
				} catch {
					/* upstream doesn't have it either */
				}
				if (final === null) return { stuck: name, index: i };
				setSection(name, file, diffFile(file, at, final));
				kept.push(name);
				return { at: final, kept };
			}
			return { at, kept };
		};
		const settle = (c: { readonly at: string; readonly kept: string[] }, bytes: Uint8Array) => {
			const kept = c.kept.filter((n) => sections.get(n)?.get(file) !== null);
			entries[file] = { upstream: entry.upstream, sha256: contentHash(bytes), upstreamSha256: newHash, ...(kept.length ? { patches: kept } : {}) };
			files.push({ file, bytes });
		};

		if (input.resolved?.includes(file)) {
			if (/^(<<<<<<<|>>>>>>>) /m.test(own) || /^(=======|\|\|\|\|\|\|\| base)$/m.test(own)) {
				problems.push(`${file}: still has conflict markers`);
				continue;
			}
			const first = carry(null);
			if ("stuck" in first && later(first.index).length) {
				problems.push(combine(first.stuck, first.index, "was resolved by hand"));
				continue;
			}
			const done = carry(own);
			if (!("stuck" in done)) settle(done, ownBytes);
			continue;
		}

		let base: string;
		try {
			base = unpatch(file, own, names, patches);
		} catch (err) {
			problems.push(`${file}: its patches don't undo cleanly (${err instanceof Error ? err.message : String(err)}); run check`);
			continue;
		}
		if (textHash(base) !== entry.upstreamSha256) {
			problems.push(`${file}: its patches don't lead back to upstream; run check`);
			continue;
		}
		const tried = carry(null);
		if (!("stuck" in tried)) {
			settle(tried, text(tried.at));
			continue;
		}
		// The three-way merge: base is the old upstream, ours the vault, theirs the new upstream.
		const merged = merge3(base, own, theirs);
		if (merged.conflicts > 0) {
			files.push({ file, bytes: text(merged.text) });
			conflicts.push(file);
			continue;
		}
		if (later(tried.index).length) {
			problems.push(combine(tried.stuck, tried.index, "merged cleanly"));
			continue;
		}
		const done = carry(merged.text);
		if (!("stuck" in done)) settle(done, text(done.at));
	}
	if (problems.length) throw new VendorError(problems.join("\n"));

	if (conflicts.length) {
		return { record: null, files: files.filter((f) => conflicts.includes(f.file)), patchFiles: [], retired: [], conflicts };
	}

	const patchFiles: Array<{ name: string; text: string }> = [];
	const retired: string[] = [];
	for (const [name, bySection] of sections) {
		const p = patches.get(name)!.patch!;
		const files2 = p.files.map((f) => (bySection.has(f.path) ? bySection.get(f.path) : f)).filter((f): f is FilePatch => f !== null && f !== undefined);
		if (files2.length === 0) {
			patchFiles.push({ name, text: formatPatch(withHeader(p, "Applied-Upstream", short)) });
			retired.push(name);
		} else {
			patchFiles.push({ name, text: formatPatch({ ...p, files: files2 }) });
		}
	}
	const next = { ...record, commit: input.commit, files: entries } as VendorRecord;
	return { record: next, files, patchFiles, retired, conflicts };
}

// ---- check --------------------------------------------------------------------

export type Problem = { readonly file: string | null; readonly problem: string };

/**
 * Every way the vault's vendored files disagree with their record and
 * patches, offline. Empty means the copy is exactly upstream plus the
 * recorded patches, and every patch says where it went upstream.
 */
export function checkRecord(vault: string, record: VendorRecord, patches: PatchSet = new Map()): Problem[] {
	if (record.schemaVersion === 1) return [{ file: null, problem: "unverifiable: schema 1 has no hashes; run record" }];
	if (record.schemaVersion === 2) return [{ file: null, problem: "schema 2 records local changes as a flag, not a patch; run migrate" }];
	const out: Problem[] = [];
	const used = new Set<string>();

	for (const file of Object.keys(record.files).sort()) {
		const e = record.files[file]!;
		const names = e.patches ?? [];
		for (const n of names) used.add(n);
		let bytes: Uint8Array;
		try {
			const at = resolveInside(vault, file);
			if (!existsSync(at)) {
				out.push({ file, problem: "missing" });
				continue;
			}
			bytes = readFileSync(at);
		} catch (err) {
			out.push({ file, problem: err instanceof VendorError ? err.message.slice(file.length + 2) : "cannot be read" });
			continue;
		}
		if (contentHash(bytes) !== e.sha256) {
			out.push({ file, problem: "edited without a patch (bytes differ from sha256)" });
			continue;
		}
		if (names.length === 0) {
			if (e.sha256 !== e.upstreamSha256) out.push({ file, problem: "differs from upstream with no patch to explain it" });
			continue;
		}
		if (isBinary(bytes)) {
			out.push({ file, problem: "a binary file can't carry patches" });
			continue;
		}
		try {
			const back = unpatch(file, Buffer.from(bytes).toString("utf8"), names, patches);
			if (textHash(back) !== e.upstreamSha256) out.push({ file, problem: "its patches don't lead back to upstream" });
		} catch (err) {
			out.push({ file, problem: err instanceof Error ? err.message : String(err) });
		}
	}

	for (const [name, { patch, error }] of patches) {
		if (error !== null || patch === null) {
			out.push({ file: null, problem: `${name}: ${error}` });
			continue;
		}
		const retired = headerOf(patch, "Applied-Upstream") !== undefined;
		if (!PATCH_NAME.test(name)) out.push({ file: null, problem: `${name}: name it NNNN-slug.patch` });
		if (retired) {
			if (used.has(name)) out.push({ file: null, problem: `${name}: marked Applied-Upstream but still listed in the record` });
			continue;
		}
		if (!used.has(name)) out.push({ file: null, problem: `${name}: in ${PATCH_DIR}/ but no file lists it (an orphan)` });
		if (!headerOf(patch, "Description")?.trim()) out.push({ file: null, problem: `${name}: Description is missing` });
		const fwd = forwardedProblem(headerOf(patch, "Forwarded"));
		if (fwd) out.push({ file: null, problem: `${name}: ${fwd}` });
		for (const f of patch.files) {
			if (!(record.files[f.path]?.patches ?? []).includes(name)) out.push({ file: null, problem: `${name}: changes ${f.path}, which doesn't list it` });
		}
	}
	for (const name of used) if (!patches.has(name)) out.push({ file: null, problem: `${name}: listed in the record but not in ${PATCH_DIR}/` });
	return out;
}
