/**
 * The vendor record, VENDOR.json, and the offline drift check (DESIGN.md
 * rule 11).
 *
 * A vault keeps a copy of the core and its chosen extensions. VENDOR.json
 * records where the copy came from and, per file, two hashes: the bytes as
 * vendored (`sha256`) and upstream's bytes at the recorded commit
 * (`upstreamSha256`). `modified` is computed from the two and never typed
 * by hand, and a modified file carries a one-line `change`. The check then
 * needs no network: a vault file whose bytes differ from `sha256` was edited
 * without a record.
 *
 * Schema 2 is a strict superset of schema 1 (the shape ShardMind's vendored
 * kits and wiki-mind use): every schema-1 field keeps its name and meaning,
 * and schema 2 adds only the two hashes per file. A schema-1 record has no
 * hashes, so the check reports it as unverifiable, never as passing.
 *
 * Text and binary. A Windows checkout with core.autocrlf=true has CRLF in
 * its working tree, and a raw hash would call every file edited. So a text
 * file is hashed with CRLF read as LF; a binary file is hashed raw. A file
 * is binary when its first 8 KB hold a NUL byte, the same test git uses.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

export const SCHEMA_VERSION = 2;
export const DEFAULT_RECORD = ".claude/VENDOR.json";

/** How far into a file the binary test looks. */
const BINARY_SNIFF = 8000;

export type FileEntry = {
	readonly upstream: string;
	readonly modified: boolean;
	readonly change?: string;
	readonly sha256?: string;
	readonly upstreamSha256?: string;
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

// ---- the record ---------------------------------------------------------------

/** Checks a parsed VENDOR.json of schema 1 or 2; returns it typed. */
export function parseRecord(raw: unknown): VendorRecord {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new VendorError("VENDOR.json must be an object");
	const r = raw as Record<string, unknown>;
	if (r.schemaVersion !== 1 && r.schemaVersion !== 2) throw new VendorError(`unknown schemaVersion ${String(r.schemaVersion)}`);
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
		if (typeof entry.modified !== "boolean") throw new VendorError(`${file}: modified must be true or false`);
		if (entry.change !== undefined && (typeof entry.change !== "string" || entry.change === "" || entry.change.includes("\n"))) {
			throw new VendorError(`${file}: change must be one non-empty line`);
		}
		if (r.schemaVersion === 2) {
			for (const k of ["sha256", "upstreamSha256"]) {
				if (typeof entry[k] !== "string" || !/^[0-9a-f]{64}$/.test(entry[k] as string)) throw new VendorError(`${file}: ${k} must be a sha256 in hex`);
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
	/** One-line reasons for modified files, by vault path. */
	readonly changes?: Readonly<Record<string, string>>;
};

/**
 * A schema-2 record for `paths`, hashed from the vault and the upstream
 * checkout. Entries of the base that are not re-recorded keep their hashes
 * only if they already have them; a schema-1 entry left out is refused, so
 * the result is always fully verifiable.
 */
export function buildRecord(input: RecordInput): VendorRecord {
	const sourceRoot = typeof input.base.sourceRoot === "string" ? input.base.sourceRoot : "";
	const prior = input.base.files ?? {};
	const files: Record<string, FileEntry> = {};
	const problems: string[] = [];

	for (const [file, entry] of Object.entries(prior)) {
		if (input.paths.includes(file)) continue;
		if (entry.sha256 === undefined || entry.upstreamSha256 === undefined) {
			problems.push(`${file}: in the record without hashes; record it too`);
			continue;
		}
		files[file] = entry;
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
		const modified = sha256 !== upstreamSha256;
		const change = input.changes?.[file] ?? prior[file]?.change;
		if (modified && change === undefined) {
			problems.push(`${file}: differs from upstream; give its change in one line`);
			continue;
		}
		files[file] = { upstream, modified, sha256, upstreamSha256, ...(modified && change !== undefined ? { change } : {}) };
	}

	if (problems.length) throw new VendorError(problems.join("\n"));
	return { ...input.base, schemaVersion: SCHEMA_VERSION, commit: input.commit, files } as VendorRecord;
}

// ---- check --------------------------------------------------------------------

export type Problem = { readonly file: string | null; readonly problem: string };

/**
 * Every way the vault's vendored files disagree with their record, offline.
 * Empty means the copy is exactly what the record says.
 */
export function checkRecord(vault: string, record: VendorRecord): Problem[] {
	if (record.schemaVersion !== SCHEMA_VERSION) {
		return [{ file: null, problem: `unverifiable: schema ${record.schemaVersion} has no hashes; run record` }];
	}
	const out: Problem[] = [];
	for (const file of Object.keys(record.files).sort()) {
		const e = record.files[file]!;
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
		if (contentHash(bytes) !== e.sha256) out.push({ file, problem: "edited without a record (bytes differ from sha256)" });
		if (e.modified !== (e.sha256 !== e.upstreamSha256)) out.push({ file, problem: `modified is ${e.modified}, but its hashes say ${!e.modified}` });
		if (e.modified && e.change === undefined) out.push({ file, problem: "modified without a change line" });
		if (!e.modified && e.change !== undefined) out.push({ file, problem: "a change line on an unmodified file" });
	}
	return out;
}
