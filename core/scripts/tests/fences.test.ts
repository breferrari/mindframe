/**
 * One fence rule for every scanner in the core (lib/fences.ts): a run of
 * three or more backticks or tildes opens a fence at any indentation, and
 * only a line that is a run of the same character, at least as long, closes
 * it. Obsidian renders what this calls a fence as code, so a link inside one
 * is not an edge and a wrapped line inside one is not prose.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fenceStep, type OpenFence } from "../lib/fences.ts";
import { hardWrappedParagraphs } from "../lib/prose-width.ts";
import { extractWikilinkTargets, lineRegions } from "../lib/wikilinks.ts";

// Backticks built from parts, so this file holds no literal fence of its own.
const tick = "`";
const ticks = (n: number) => tick.repeat(n);

/** Each line's fenced flag, stepping through `lines` from outside a fence. */
function scan(lines: readonly string[]): boolean[] {
	let open: OpenFence = null;
	return lines.map((line) => {
		const step = fenceStep(line, open);
		open = step.open;
		return step.fenced;
	});
}

describe("fenceStep", () => {
	test("a fence opened by four backticks is not closed by three, and is closed by four or more", () => {
		assert.deepEqual(scan([ticks(4) + "md", ticks(3), "x", ticks(4), "after"]), [true, true, true, true, false]);
		assert.deepEqual(scan([ticks(4), ticks(5), "after"]), [true, true, false]);
	});

	test("a line with an info string inside a fence doesn't close it", () => {
		assert.deepEqual(scan([ticks(3), ticks(3) + "js", "x", ticks(3), "after"]), [true, true, true, true, false]);
	});

	test("tildes don't close a backtick fence, nor backticks a tilde fence", () => {
		assert.deepEqual(scan([ticks(3), "~~~", "x", ticks(3), "after"]), [true, true, true, true, false]);
		assert.deepEqual(scan(["~~~~", ticks(4), "x", "~~~~", "after"]), [true, true, true, true, false]);
	});

	test("a backtick opener whose info string holds a backtick is inline code, not a fence", () => {
		assert.deepEqual(scan([`${ticks(3)} x ${ticks(3)}`, "after"]), [false, false]);
		assert.deepEqual(scan(["~~~ x ~", "inside"]), [true, true], "a tilde opener may hold tildes");
	});

	test("CRLF lines and trailing spaces on the closer change nothing", () => {
		assert.deepEqual(scan([ticks(3) + "\r", "x\r", ticks(3) + "  \r", "after\r"]), [true, true, true, false]);
	});

	test("a fence nested under a list item, indented four spaces, is a fence", () => {
		assert.deepEqual(scan(["- item", "    " + ticks(3), "    [[x]]", "    " + ticks(3), "after"]), [false, true, true, true, false]);
	});

	test("the one case this gets wrong: a top-level indented-code line of three backticks opens a fence", () => {
		// Obsidian renders "    ```" at top level as indented code, one line; a
		// line scanner can't tell it from a list-nested fence, so it opens a fence
		// that runs to a matching close or the end of the note.
		assert.deepEqual(scan(["text", "    " + ticks(3), "swallowed"]), [false, true, true]);
	});

	test("an unclosed fence runs to the end", () => {
		assert.deepEqual(scan([ticks(3), "a", "b"]), [true, true, true]);
	});
});

describe("every scanner follows it", () => {
	const note = [ticks(4) + "md", ticks(3), "[[inside-a-fence]]", "A paragraph", "wrapped here.", ticks(4), "[[after]]"];

	test("extractWikilinkTargets: the link inside the fence is not an edge (#77)", () => {
		assert.deepEqual(extractWikilinkTargets(note.join("\n")), ["after"]);
	});

	test("extractWikilinkTargets: a fence that never closes hides every link after it", () => {
		assert.deepEqual(extractWikilinkTargets(["[[before]]", ticks(3), "[[a]]", ticks(3) + "js", "[[b]]"].join("\n")), ["before"]);
	});

	test("lineRegions: every line up to the four-backtick close is fence", () => {
		assert.deepEqual(lineRegions(note), ["fence", "fence", "fence", "fence", "fence", "fence", "body"]);
	});

	test("prose-width: a wrapped line inside the fence is not prose", () => {
		assert.deepEqual(hardWrappedParagraphs(note.join("\n")), []);
	});

	test("a run indented four or more deeper than its opener is content, not a close", () => {
		const doc = [ticks(3) + "md", "Example:", "    " + ticks(3), "    [[leak]]", "    " + ticks(3), ticks(3), "[[after]]"];
		assert.deepEqual(extractWikilinkTargets(doc.join("\n")), ["after"]);
	});

	test("a fence inside a callout or quote is a fence to every scanner", () => {
		const doc = ["> [!note]", "> " + ticks(3), "> [[example]]", "> wrapped", "> here.", "> " + ticks(3), "[[after]]"];
		assert.deepEqual(extractWikilinkTargets(doc.join("\n")), ["after"]);
		assert.deepEqual(lineRegions(doc), ["body", "fence", "fence", "fence", "fence", "fence", "body"]);
		assert.deepEqual(hardWrappedParagraphs(doc.join("\n")), []);
	});

	test("a quoted run doesn't close a fence opened outside the quote", () => {
		assert.deepEqual(extractWikilinkTargets([ticks(3), "> " + ticks(3), "[[inside]]", ticks(3), "[[after]]"].join("\n")), ["after"]);
	});
});
