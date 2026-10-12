/**
 * Claiming a filename without losing a write.
 *
 * Extracted because both write paths — memories and work records — need it, and
 * a correctness-critical pattern implemented twice is a fix applied once.
 *
 * WHY NOT check-then-write
 *
 * The obvious version is `while (existsSync(x)) bump(x); writeFileSync(x)`. It
 * is a TOCTOU race, and not a theoretical one: the deployment shape is one
 * server process PER CONSUMING REPO, all writing into one vault. Six processes
 * recording the same title produced FOUR files and SIX success messages — two
 * writes lost silently, reported as recorded, which is the worst outcome
 * available to a layer whose whole job is not losing them.
 *
 * `COPYFILE_EXCL` fails instead of clobbering, so the loser simply takes the
 * next suffix. The temp file also means a crash mid-write cannot leave a
 * half-written note for the indexer to pick up.
 */

import { randomBytes } from "node:crypto";
import { writeFileSync, copyFileSync, renameSync, statSync, unlinkSync, constants } from "node:fs";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

/**
 * Per-module counter, so two in-flight writes cannot share a temp name. A
 * worker thread loads its own copy of this module with the same pid, so a
 * random part keeps their names apart too.
 */
let tmpSeq = 0;

/** `<pid>-<seq>-<8 hex>`: unique within a process and across module copies. */
function tmpTag(): string {
	return `${process.pid}-${++tmpSeq}-${randomBytes(4).toString("hex")}`;
}

/** How much of the note's name the temp name keeps, in characters. */
const TEMP_NAME_CHARS = 40;

/**
 * The temp file for a write to `path`: a dotted sibling, so a write killed
 * before its rename leaves nothing that shows in the vault, and Obsidian and
 * qmd never index a half-written note. It keeps only the start of the
 * note's name, so a note named near the filesystem's limit still gets one.
 */
export function tempPathFor(path: string): string {
	const name = [...basename(path)].slice(0, TEMP_NAME_CHARS).join("");
	return join(dirname(path), `.${name}.${tmpTag()}.tmp`);
}

/** The longest a call is retried in all, in milliseconds: hooks have tight time limits. */
export const RENAME_RETRY_MS = 1_000;

/** The Windows codes for a file another process holds for a moment. */
const HELD = new Set(["EACCES", "EPERM", "EBUSY"]);

/** A synchronous wait, for the synchronous write: nothing ever notifies this cell. */
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number): void => {
	Atomics.wait(SLEEP_CELL, 0, 0, ms);
};

export type HeldDeps = {
	readonly platform?: NodeJS.Platform;
	readonly sleep?: (ms: number) => void;
	readonly now?: () => number;
};

/**
 * Run `op`. On Windows, a virus scanner or the search indexer may hold a
 * just-written file for a moment, and the call then fails with EACCES,
 * EPERM or EBUSY: those are retried, waiting 10, 20, 40 ms and so on (never
 * more than 100 ms at a time), until RENAME_RETRY_MS after the first
 * attempt, counting the calls' own time, then the last error is thrown.
 * Anywhere else, for any other code, or when `lasting()` says the refusal
 * won't pass, the first error is thrown at once.
 */
export function retryHeld(
	op: () => void,
	{ platform = process.platform, sleep = sleepSync, now = () => performance.now() }: HeldDeps = {},
	lasting: () => boolean = () => false,
): void {
	const deadline = now() + RENAME_RETRY_MS;
	for (let wait = 10; ; wait = Math.min(wait * 2, 100)) {
		try {
			op();
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (platform !== "win32" || code === undefined || !HELD.has(code) || now() + wait > deadline || lasting()) throw err;
			sleep(wait);
		}
	}
}

type TargetStat = { isDirectory(): boolean; readonly mode: number };

export type RenameDeps = HeldDeps & {
	readonly rename?: (from: string, to: string) => void;
	readonly stat?: (path: string) => TargetStat | null;
};

const statOrNull = (path: string): TargetStat | null => {
	try {
		return statSync(path);
	} catch {
		return null;
	}
};

/**
 * Rename `from` to `to`, retrying a held file on Windows (retryHeld). A
 * folder or a read-only file at `to` refuses for good, so it is thrown at
 * once instead of costing the hook a second.
 */
export function renameWithRetry(from: string, to: string, { rename = renameSync, stat = statOrNull, ...held }: RenameDeps = {}): void {
	retryHeld(() => rename(from, to), held, () => {
		const target = stat(to);
		return target !== null && (target.isDirectory() || (target.mode & 0o200) === 0);
	});
}

export interface ClaimResult {
	/** The filename that was successfully claimed. */
	readonly name: string;
	/** Its absolute path. */
	readonly full: string;
}

export interface ClaimOptions {
	/** How many suffixed names to try before giving up. */
	readonly maxAttempts?: number;
	/**
	 * Called with each candidate before it is claimed. Throw to refuse it —
	 * used by the capture path to verify containment rather than trust that a
	 * slug stripped every separator.
	 */
	readonly verify?: (full: string) => void;
	/** Message when every attempt collided. */
	readonly exhaustedMessage?: string;
}

/**
 * Write `body` into `dir` under the first free name `nameFor` produces.
 *
 * `nameFor(1)` is the preferred name; higher `n` are the collision fallbacks,
 * so the caller decides whether that looks like `note (2).md` or `note-2.md`.
 */
export function claimFile(
	dir: string,
	body: string,
	nameFor: (n: number) => string,
	{ maxAttempts = 50, verify, exhaustedMessage = "too many colliding files for that name" }: ClaimOptions = {},
): ClaimResult {
	const tmp = join(dir, `.om-${tmpTag()}.tmp`);
	writeFileSync(tmp, body, "utf8");
	try {
		for (let n = 1; n <= maxAttempts; n++) {
			const name = nameFor(n);
			const full = join(dir, name);
			verify?.(full);
			try {
				copyFileSync(tmp, full, constants.COPYFILE_EXCL);
				return { name, full };
			} catch (e) {
				if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
			}
		}
		throw new Error(exhaustedMessage);
	} finally {
		try {
			unlinkSync(tmp);
		} catch {
			/* temp cleanup is best-effort */
		}
	}
}

/**
 * Replace `path` with `text` through a temp file and a rename, so a reader
 * never sees half a file and a process killed mid-write leaves the previous
 * one. Unlike `claimFile`, it overwrites. The temp file is a dotted sibling
 * (tempPathFor), and the rename is retried briefly on Windows
 * (renameWithRetry). Throws if it cannot, after removing its temp file.
 */
export function writeFileAtomic(path: string, text: string): void {
	const tmp = tempPathFor(path);
	try {
		writeFileSync(tmp, text, "utf8");
		renameWithRetry(tmp, path);
	} catch (err) {
		try {
			// The scanner holding the temp file may hold it for this too.
			retryHeld(() => unlinkSync(tmp));
		} catch {
			/* nothing was written, or the temp file is still held */
		}
		throw err;
	}
}
