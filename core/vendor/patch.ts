/**
 * The patch engine for vendored files: a line diff, unified-diff patches,
 * exact application forward and back, and a three-way merge.
 *
 * A vault's copy of an upstream file is the upstream bytes plus its
 * patches. `check` proves that by applying the patches in reverse to the
 * vault's bytes and comparing the result with the upstream hash, so
 * application here is exact: every context and removed line must match
 * where the hunk says, with no fuzz. Only `update` merges, and only outside
 * CI.
 *
 * All text is LF: CRLF is read as LF before anything else, the same rule
 * the drift check hashes by. A missing final newline is kept and written
 * the way git writes it ("\ No newline at end of file").
 *
 * Zero dependencies, no git binary.
 */

// ---- text ---------------------------------------------------------------------

/** Text as lines without terminators, and whether it ended with a newline. */
export type Lines = { readonly lines: readonly string[]; readonly eol: boolean };

export function toLines(text: string): Lines {
	const lf = text.replace(/\r\n/g, "\n");
	if (lf === "") return { lines: [], eol: true };
	const eol = lf.endsWith("\n");
	const lines = (eol ? lf.slice(0, -1) : lf).split("\n");
	return { lines, eol };
}

export function fromLines({ lines, eol }: Lines): string {
	if (lines.length === 0) return "";
	return lines.join("\n") + (eol ? "\n" : "");
}

// ---- diff (Myers, O((N+M)D)) ----------------------------------------------------

export type Op = { readonly kind: " " | "-" | "+"; readonly line: string };

/** The shortest edit script turning `a` into `b`, line by line. */
export function diffLines(a: readonly string[], b: readonly string[]): Op[] {
	const n = a.length;
	const m = b.length;
	const max = n + m;
	const offset = max;
	const v = new Array<number>(2 * max + 2).fill(0);
	const trace: number[][] = [];
	outer: for (let d = 0; d <= max; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!);
			let x = down ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) break outer;
		}
	}
	// Walk the trace back from (n, m) to (0, 0).
	const ops: Op[] = [];
	let x = n;
	let y = m;
	for (let d = trace.length - 1; d >= 0; d--) {
		const vd = trace[d]!;
		const k = x - y;
		const down = k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!);
		const prevK = down ? k + 1 : k - 1;
		const prevX = vd[offset + prevK]!;
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			ops.push({ kind: " ", line: a[x - 1]! });
			x--;
			y--;
		}
		if (d > 0) {
			if (down) ops.push({ kind: "+", line: b[y - 1]! });
			else ops.push({ kind: "-", line: a[x - 1]! });
		}
		x = prevX;
		y = prevY;
	}
	return ops.reverse();
}

// ---- unified diffs ----------------------------------------------------------------

export type Hunk = {
	readonly oldStart: number;
	readonly oldLines: number;
	readonly newStart: number;
	readonly newLines: number;
	/** " x", "-x", "+x" */
	readonly lines: readonly string[];
	/** The old or new side's last line here has no newline after it. */
	readonly oldNoEol: boolean;
	readonly newNoEol: boolean;
};

export type FilePatch = { readonly path: string; readonly hunks: readonly Hunk[] };

export type Patch = {
	/** Header fields above the diff, in file order. */
	readonly header: ReadonlyArray<readonly [string, string]>;
	readonly files: readonly FilePatch[];
};

export class PatchError extends Error {}

const CONTEXT = 3;

/** The hunks turning `before` into `after`, with three lines of context. */
export function diffFile(path: string, before: string, after: string): FilePatch | null {
	const a = toLines(before);
	const b = toLines(after);
	// A change in the final newline alone is a change to the last line.
	const aEnds = a.lines.map((l, i) => (i === a.lines.length - 1 && !a.eol ? `${l}\u0000noeol` : l));
	const bEnds = b.lines.map((l, i) => (i === b.lines.length - 1 && !b.eol ? `${l}\u0000noeol` : l));
	const ops = diffLines(aEnds, bEnds);
	if (ops.every((o) => o.kind === " ")) return null;

	const hunks: Hunk[] = [];
	let i = 0;
	let oldNo = 1;
	let newNo = 1;
	// Positions of each op on both sides.
	const pos = ops.map((o) => {
		const p = { o, old: oldNo, new: newNo };
		if (o.kind !== "+") oldNo++;
		if (o.kind !== "-") newNo++;
		return p;
	});
	while (i < pos.length) {
		while (i < pos.length && pos[i]!.o.kind === " ") i++;
		if (i >= pos.length) break;
		let start = Math.max(0, i - CONTEXT);
		let end = i;
		// Extend through changes closer than 2*CONTEXT lines apart.
		for (;;) {
			while (end < pos.length && pos[end]!.o.kind !== " ") end++;
			let run = end;
			while (run < pos.length && pos[run]!.o.kind === " ") run++;
			if (run < pos.length && run - end <= 2 * CONTEXT) {
				end = run;
				continue;
			}
			end = Math.min(pos.length, end + CONTEXT);
			break;
		}
		const slice = pos.slice(start, end);
		const lines = slice.map((p) => p.o.kind + p.o.line.replace(/\u0000noeol$/, ""));
		const oldCount = slice.filter((p) => p.o.kind !== "+").length;
		const newCount = slice.filter((p) => p.o.kind !== "-").length;
		const oldNoEol = slice.some((p) => p.o.kind !== "+" && p.o.line.endsWith("\u0000noeol"));
		const newNoEol = slice.some((p) => p.o.kind !== "-" && p.o.line.endsWith("\u0000noeol"));
		hunks.push({
			oldStart: oldCount === 0 ? slice[0]!.old - 1 : slice.find((p) => p.o.kind !== "+")!.old,
			oldLines: oldCount,
			newStart: newCount === 0 ? slice[0]!.new - 1 : slice.find((p) => p.o.kind !== "-")!.new,
			newLines: newCount,
			lines,
			oldNoEol,
			newNoEol,
		});
		i = end;
		start = end;
	}
	return { path, hunks };
}

const range = (start: number, count: number) => (count === 1 ? `${start}` : `${start},${count}`);

/** A patch as text: its header, a blank line, then a git-style diff per file. */
export function formatPatch(patch: Patch): string {
	const out: string[] = patch.header.map(([k, v]) => `${k}: ${v}`);
	out.push("");
	for (const f of patch.files) {
		out.push(`diff --git a/${f.path} b/${f.path}`, `--- a/${f.path}`, `+++ b/${f.path}`);
		for (const h of f.hunks) {
			out.push(`@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@`);
			// The "no newline" marker follows the last line of the side it belongs to.
			const lastOld = h.lines.map((l, i) => (l[0] !== "+" ? i : -1)).filter((i) => i >= 0).pop();
			const lastNew = h.lines.map((l, i) => (l[0] !== "-" ? i : -1)).filter((i) => i >= 0).pop();
			h.lines.forEach((l, i) => {
				out.push(l);
				const marks = (h.oldNoEol && i === lastOld) || (h.newNoEol && i === lastNew);
				if (marks) out.push("\\ No newline at end of file");
			});
		}
	}
	return out.join("\n") + "\n";
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A patch file read back: header fields, then each file's hunks. */
export function parsePatch(text: string): Patch {
	const rows = text.replace(/\r\n/g, "\n").split("\n");
	if (rows[rows.length - 1] === "") rows.pop();
	const header: Array<[string, string]> = [];
	let i = 0;
	for (; i < rows.length && !rows[i]!.startsWith("diff --git "); i++) {
		const row = rows[i]!;
		if (row === "") continue;
		const m = /^([A-Za-z][A-Za-z-]*):\s?(.*)$/.exec(row);
		if (!m) throw new PatchError(`header line ${i + 1} is not "Field: value": ${row}`);
		header.push([m[1]!, m[2]!]);
	}
	const files: FilePatch[] = [];
	while (i < rows.length) {
		const git = /^diff --git a\/(.+) b\/(.+)$/.exec(rows[i]!);
		if (!git || git[1] !== git[2]) throw new PatchError(`line ${i + 1}: expected "diff --git a/<path> b/<path>"`);
		const path = git[1]!;
		i++;
		if (rows[i] !== `--- a/${path}` || rows[i + 1] !== `+++ b/${path}`) throw new PatchError(`${path}: missing ---/+++ lines`);
		i += 2;
		const hunks: Hunk[] = [];
		while (i < rows.length && rows[i]!.startsWith("@@")) {
			const m = HUNK.exec(rows[i]!);
			if (!m) throw new PatchError(`line ${i + 1}: bad hunk header ${rows[i]}`);
			const oldLines = m[2] === undefined ? 1 : Number(m[2]);
			const newLines = m[4] === undefined ? 1 : Number(m[4]);
			i++;
			const lines: string[] = [];
			let oldNoEol = false;
			let newNoEol = false;
			let olds = 0;
			let news = 0;
			while (i < rows.length && (olds < oldLines || news < newLines || rows[i] === "\\ No newline at end of file")) {
				const row = rows[i]!;
				if (row === "\\ No newline at end of file") {
					const prev = lines[lines.length - 1];
					if (prev === undefined) throw new PatchError(`line ${i + 1}: a no-newline marker with nothing before it`);
					if (prev[0] !== "+") oldNoEol = true;
					if (prev[0] !== "-") newNoEol = true;
					i++;
					continue;
				}
				const kind = row[0];
				if (kind !== " " && kind !== "-" && kind !== "+") throw new PatchError(`line ${i + 1}: expected " ", "-" or "+"`);
				if (kind !== "+") olds++;
				if (kind !== "-") news++;
				lines.push(row);
				i++;
			}
			if (olds !== oldLines || news !== newLines) throw new PatchError(`${path}: a hunk's line counts don't match its header`);
			hunks.push({ oldStart: Number(m[1]), oldLines, newStart: Number(m[3]), newLines, lines, oldNoEol, newNoEol });
		}
		if (hunks.length === 0) throw new PatchError(`${path}: no hunks`);
		files.push({ path, hunks });
	}
	return { header, files };
}

/** The same patch with every hunk turned around: applying it undoes the original. */
export function reverseFile(f: FilePatch): FilePatch {
	return {
		path: f.path,
		hunks: f.hunks.map((h) => ({
			oldStart: h.newStart,
			oldLines: h.newLines,
			newStart: h.oldStart,
			newLines: h.oldLines,
			lines: h.lines.map((l) => (l[0] === "+" ? `-${l.slice(1)}` : l[0] === "-" ? `+${l.slice(1)}` : l)),
			oldNoEol: h.newNoEol,
			newNoEol: h.oldNoEol,
		})),
	};
}

/**
 * Applies one file's hunks to `text`, exactly: each hunk's context and
 * removed lines must sit where its header says, shifted only by what the
 * hunks before it added or removed. Throws PatchError otherwise.
 */
export function applyFile(text: string, f: FilePatch, reverse = false): string {
	const patch = reverse ? reverseFile(f) : f;
	const src = toLines(text);
	const out: string[] = [];
	let at = 0;
	let eol = src.eol;
	for (const [n, h] of patch.hunks.entries()) {
		const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
		if (start < at) throw new PatchError(`${f.path}: hunk ${n + 1} overlaps the one before`);
		out.push(...src.lines.slice(at, start));
		let i = start;
		for (const l of h.lines) {
			if (l[0] === "+") {
				out.push(l.slice(1));
				continue;
			}
			if (src.lines[i] !== l.slice(1)) {
				throw new PatchError(`${f.path}: hunk ${n + 1} doesn't match at line ${i + 1}`);
			}
			if (l[0] === " ") out.push(l.slice(1));
			i++;
		}
		at = i;
		const reachesEnd = at === src.lines.length;
		if (h.oldNoEol && !(reachesEnd && !src.eol)) throw new PatchError(`${f.path}: hunk ${n + 1} expects no final newline`);
		if (reachesEnd) eol = !h.newNoEol;
	}
	out.push(...src.lines.slice(at));
	return fromLines({ lines: out, eol });
}

// ---- three-way merge --------------------------------------------------------------

export type Merge = { readonly text: string; readonly conflicts: number };

/**
 * Merges the changes `ours` and `theirs` each made to `base`. Changes to
 * different lines combine; the same change on both sides is taken once; any
 * other overlap is a conflict, written between git-style markers.
 */
export function merge3(base: string, ours: string, theirs: string, labels = { ours: "vault", theirs: "upstream" }): Merge {
	const b = toLines(base);
	const o = toLines(ours);
	const t = toLines(theirs);
	// For each side: which base lines it keeps, and where.
	const keep = (side: Lines) => {
		const map = new Map<number, number>();
		let bi = 0;
		let si = 0;
		for (const op of diffLines(b.lines, side.lines)) {
			if (op.kind === " ") map.set(bi++, si++);
			else if (op.kind === "-") bi++;
			else si++;
		}
		return map;
	};
	const ko = keep(o);
	const kt = keep(t);
	const out: string[] = [];
	let conflicts = 0;
	let bi = 0;
	let oi = 0;
	let ti = 0;
	const emit = (bEnd: number, oEnd: number, tEnd: number) => {
		const bs = b.lines.slice(bi, bEnd);
		const os = o.lines.slice(oi, oEnd);
		const ts = t.lines.slice(ti, tEnd);
		const same = (x: readonly string[], y: readonly string[]) => x.length === y.length && x.every((l, i) => l === y[i]);
		if (same(os, ts)) out.push(...os);
		else if (same(os, bs)) out.push(...ts);
		else if (same(ts, bs)) out.push(...os);
		else {
			conflicts++;
			out.push(`<<<<<<< ${labels.ours}`, ...os, "||||||| base", ...bs, "=======", ...ts, `>>>>>>> ${labels.theirs}`);
		}
	};
	// Walk the base; a line both sides keep is a stable point.
	for (let x = 0; x <= b.lines.length; x++) {
		const stable = x === b.lines.length || (ko.has(x) && kt.has(x));
		if (!stable) continue;
		const oEnd = x === b.lines.length ? o.lines.length : ko.get(x)!;
		const tEnd = x === b.lines.length ? t.lines.length : kt.get(x)!;
		emit(x, oEnd, tEnd);
		if (x < b.lines.length) out.push(b.lines[x]!);
		bi = x + 1;
		oi = oEnd + 1;
		ti = tEnd + 1;
	}
	// The final newline: taken from whichever side changed it.
	const eol = o.eol === t.eol ? o.eol : o.eol === b.eol ? t.eol : o.eol;
	return { text: fromLines({ lines: out, eol }), conflicts };
}
