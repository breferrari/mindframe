import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFile, diffFile, diffLines, formatPatch, fromLines, merge3, parsePatch, PatchError, reverseFile, toLines, type FilePatch } from "./patch.ts";

// A seeded generator, so the property tests are the same on every run and OS.
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

function randomText(r: () => number, words: readonly string[]): string {
	const n = Math.floor(r() * 12);
	const lines = Array.from({ length: n }, () => words[Math.floor(r() * words.length)]!);
	const eol = r() < 0.8;
	return fromLines({ lines, eol });
}

function mutate(r: () => number, text: string, words: readonly string[]): string {
	const { lines, eol } = toLines(text);
	const out = [...lines];
	const edits = 1 + Math.floor(r() * 3);
	for (let e = 0; e < edits; e++) {
		const at = Math.floor(r() * (out.length + 1));
		const what = r();
		if (what < 0.33 && out.length > 0) out.splice(Math.min(at, out.length - 1), 1);
		else if (what < 0.66) out.splice(at, 0, words[Math.floor(r() * words.length)]!);
		else if (out.length > 0) out[Math.min(at, out.length - 1)] = words[Math.floor(r() * words.length)]!;
	}
	return fromLines({ lines: out, eol: r() < 0.15 ? !eol : eol });
}

const WORDS = ["alpha", "beta", "gamma", "delta", "", "  indented", "x", "y", "}", "{"];

test("text: CRLF reads as LF, and the final newline survives the round trip", () => {
	assert.deepEqual(toLines("a\r\nb\r\n"), { lines: ["a", "b"], eol: true });
	assert.deepEqual(toLines("a\nb"), { lines: ["a", "b"], eol: false });
	assert.deepEqual(toLines(""), { lines: [], eol: true });
	for (const s of ["", "a\n", "a", "a\n\n", "\n"]) assert.equal(fromLines(toLines(s)), s, JSON.stringify(s));
});

test("diffLines is a minimal edit script", () => {
	const ops = diffLines(["a", "b", "c"], ["a", "x", "c"]);
	assert.deepEqual(ops.map((o) => o.kind + o.line), [" a", "-b", "+x", " c"]);
	assert.equal(diffLines([], []).length, 0);
});

test("property: apply(diff(a, b), a) == b, and the reverse gives a back", () => {
	const r = rng(304);
	for (let n = 0; n < 400; n++) {
		const a = randomText(r, WORDS);
		const b = mutate(r, a, WORDS);
		const f = diffFile("x.ts", a, b);
		if (f === null) {
			assert.equal(fromLines(toLines(a)), fromLines(toLines(b)));
			continue;
		}
		assert.equal(applyFile(a, f), b, `forward #${n}`);
		assert.equal(applyFile(b, f, true), a, `reverse #${n}`);
		// And the patch survives being written and read back.
		const back = parsePatch(formatPatch({ header: [["Description", "d"]], files: [f] })).files[0]!;
		assert.equal(applyFile(a, back), b, `round-tripped forward #${n}`);
		assert.equal(applyFile(b, back, true), a, `round-tripped reverse #${n}`);
	}
});

test("a patch reads CRLF text as LF, so a CRLF checkout applies cleanly", () => {
	const a = "one\ntwo\nthree\n";
	const f = diffFile("x.ts", a, "one\nTWO\nthree\n")!;
	assert.equal(applyFile(a.replace(/\n/g, "\r\n"), f), "one\nTWO\nthree\n");
});

test("format: git-style headers, hunk ranges, and the no-newline marker", () => {
	const f = diffFile("lib/a.ts", "a\nb\nc", "a\nB\nc")!;
	const text = formatPatch({ header: [["Description", "fix b"], ["Forwarded", "not-needed: test"]], files: [f] });
	assert.equal(
		text,
		[
			"Description: fix b",
			"Forwarded: not-needed: test",
			"",
			"diff --git a/lib/a.ts b/lib/a.ts",
			"--- a/lib/a.ts",
			"+++ b/lib/a.ts",
			"@@ -1,3 +1,3 @@",
			" a",
			"-b",
			"+B",
			" c",
			"\\ No newline at end of file",
			"",
		].join("\n"),
	);
	const p = parsePatch(text);
	assert.deepEqual(p.header, [["Description", "fix b"], ["Forwarded", "not-needed: test"]]);
	assert.equal(p.files[0]!.hunks[0]!.oldNoEol, true);
});

test("apply is exact: drifted context fails, never fuzzes", () => {
	const f = diffFile("x.ts", "a\nb\nc\nd\n", "a\nb\nC\nd\n")!;
	assert.equal(applyFile("a\nb\nc\nd\n", f), "a\nb\nC\nd\n");
	assert.throws(() => applyFile("a\nB\nc\nd\n", f), PatchError, "a changed context line");
	assert.throws(() => applyFile("z\na\nb\nc\nd\n", f), PatchError, "the same lines one further down");
	assert.throws(() => applyFile("a\nb\nC\nd\n", f), PatchError, "already applied");
});

test("far-apart changes make separate hunks; near ones share one", () => {
	const lines = Array.from({ length: 30 }, (_, i) => `l${i}`);
	const a = fromLines({ lines, eol: true });
	const far = [...lines];
	far[2] = "X";
	far[25] = "Y";
	assert.equal(diffFile("x", a, fromLines({ lines: far, eol: true }))!.hunks.length, 2);
	const near = [...lines];
	near[2] = "X";
	near[6] = "Y";
	assert.equal(diffFile("x", a, fromLines({ lines: near, eol: true }))!.hunks.length, 1);
});

test("whole-file add and delete, and identical files give no patch", () => {
	const add = diffFile("x", "", "a\nb\n")!;
	assert.equal(applyFile("", add), "a\nb\n");
	assert.equal(applyFile("a\nb\n", add, true), "");
	assert.equal(diffFile("x", "a\n", "a\r\n"), null, "CRLF is not a change");
});

test("parsePatch refuses malformed input", () => {
	assert.throws(() => parsePatch("not a header\n"), /not "Field: value"/);
	assert.throws(() => parsePatch("Description: d\n\ndiff --git a/x b/y\n"), /expected "diff --git/);
	assert.throws(() => parsePatch("Description: d\n\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n"), /line counts/);
	assert.throws(() => parsePatch("Description: d\n\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n"), /no hunks/);
});

test("reverseFile swaps sides, and reversing twice is the identity", () => {
	const f = diffFile("x", "a\nb\n", "a\nc\nd")!;
	const rr: FilePatch = reverseFile(reverseFile(f));
	assert.deepEqual(rr, f);
});

test("merge3: separate changes combine, the same change is taken once", () => {
	const base = "a\nb\nc\nd\ne\n";
	assert.deepEqual(merge3(base, "A\nb\nc\nd\ne\n", "a\nb\nc\nd\nE\n"), { text: "A\nb\nc\nd\nE\n", conflicts: 0 });
	assert.deepEqual(merge3(base, "a\nB\nc\nd\ne\n", "a\nB\nc\nd\ne\n"), { text: "a\nB\nc\nd\ne\n", conflicts: 0 });
	assert.deepEqual(merge3(base, base, "a\nb\nc\nd\ne\nf\n"), { text: "a\nb\nc\nd\ne\nf\n", conflicts: 0 });
});

test("merge3: overlapping different changes conflict, with markers naming each side", () => {
	const m = merge3("a\nb\nc\n", "a\nOURS\nc\n", "a\nTHEIRS\nc\n");
	assert.equal(m.conflicts, 1);
	assert.equal(m.text, "a\n<<<<<<< vault\nOURS\n||||||| base\nb\n=======\nTHEIRS\n>>>>>>> upstream\nc\n");
});

test("property: merging a change with an unchanged side gives that change", () => {
	const r = rng(9);
	for (let n = 0; n < 200; n++) {
		const base = randomText(r, WORDS);
		const changed = mutate(r, base, WORDS);
		assert.equal(merge3(base, changed, base).text, fromLines(toLines(changed)), `ours #${n}`);
		assert.equal(merge3(base, base, changed).text, fromLines(toLines(changed)), `theirs #${n}`);
	}
});

test("apply is exact about the final newline too", () => {
	const f = diffFile("x", "a\nb", "a\nB")!;
	assert.equal(applyFile("a\nb", f), "a\nB");
	assert.throws(() => applyFile("a\nb\n", f), /no final newline/, "the patch was made against text with no final newline");
});

test("overlapping hunks in a patch are refused", () => {
	const bad: FilePatch = {
		path: "x",
		hunks: [
			{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" a", " b"], oldNoEol: false, newNoEol: false },
			{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+A"], oldNoEol: false, newNoEol: false },
		],
	};
	assert.throws(() => applyFile("a\nb\n", bad), /overlaps/);
});
