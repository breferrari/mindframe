/**
 * lineRegions and wikilinkSpans read a note line by line by the same rules
 * the core reads it whole: frontmatter as stripFrontmatter finds it, fences
 * as stripCodeRegions finds them, inline code removed the same way, and
 * every target read as extractWikilinkTargets reads it. The agreement cases
 * pin that.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { stripFrontmatter } from "../lib/session-start.ts";
import { extractWikilinkTargets, lineRegions, wikilinkSpans } from "../lib/wikilinks.ts";
import * as core from "../core/index.ts";

// Backticks built from parts, so this file holds no literal fence of its own.
const tick = "`";
const fence = tick.repeat(3);

describe("lineRegions", () => {
	test("frontmatter to its first closing --- line, then headings and body", () => {
		const lines = ["---", "title: a --- b", "---", "# Title", "", "text", "## Part"];
		assert.deepEqual(lineRegions(lines), ["frontmatter", "frontmatter", "frontmatter", "heading", "body", "body", "heading"]);
	});

	test("CRLF lines split on \\n keep their \\r and read the same", () => {
		const lines = "---\r\ntitle: a\r\n---\r\n# T\r\nbody\r\n".split("\n");
		assert.deepEqual(lineRegions(lines), ["frontmatter", "frontmatter", "frontmatter", "heading", "body", "body"]);
	});

	test("an unterminated block is not frontmatter", () => {
		assert.deepEqual(lineRegions(["---", "a: 1", "text"]), ["body", "body", "body"]);
	});

	test("the opening line follows the core's one rule (#82): a BOM before --- opens, ---- doesn't", () => {
		assert.deepEqual(lineRegions(["\uFEFF---", "a: 1", "---", "x"]), ["frontmatter", "frontmatter", "frontmatter", "body"]);
		assert.deepEqual(lineRegions(["----", "a: 1", "---", "x"]), ["body", "body", "body", "body"]);
	});

	test("a BOM on line 0 is not the note's text: a heading after it is a heading, a fence after it a fence (#107)", () => {
		assert.deepEqual(lineRegions(["\uFEFF# Title", "text"]), ["heading", "body"]);
		assert.deepEqual(lineRegions(["\uFEFF" + fence, "# not a heading", fence, "## Part"]), ["fence", "fence", "fence", "heading"]);
		assert.deepEqual(lineRegions("\uFEFF# Title\r\ntext\r\n## Part\r\n".split("\n")), ["heading", "body", "heading", "body"], "CRLF with a BOM");
		assert.deepEqual(lineRegions("\uFEFF---\r\na: 1\r\n---\r\n# T\r\n".split("\n")), ["frontmatter", "frontmatter", "frontmatter", "heading", "body"], "a BOM before --- still opens frontmatter, CRLF too");
	});

	test("a BOM on a later line is content there, and left alone (#107)", () => {
		assert.deepEqual(lineRegions(["text", "\uFEFF# not a heading"]), ["body", "body"]);
		assert.deepEqual(lineRegions(["\uFEFF\uFEFF# x"]), ["body"], "only the file's one BOM: a second is content");
		assert.deepEqual(lineRegions(["---", "a: 1", "---", "\uFEFF# x"]), ["frontmatter", "frontmatter", "frontmatter", "body"]);
	});

	test("``` and ~~~ fences, a fence that never closes, and #s inside a fence", () => {
		const lines = [fence + "ts", "# not a heading", "[[x]]", fence, "~~~", "a", "~~~", "text", fence, "open to the end"];
		assert.deepEqual(lineRegions(lines), ["fence", "fence", "fence", "fence", "fence", "fence", "fence", "body", "fence", "fence"]);
	});

	test("a heading is up to three spaces, one to six #s, then a space, a tab or the end of the line", () => {
		const lines = ["#tag", "###### six", "####### seven", "   # indented", "#", "    # code-indented", "#\ttab", "#\u00a0nbsp"];
		assert.deepEqual(lineRegions(lines), ["body", "heading", "body", "heading", "heading", "body", "heading", "body"]);
	});

	test("a fence-looking line inside frontmatter is frontmatter, and opens no fence", () => {
		assert.deepEqual(lineRegions(["---", "x: |", "  " + fence, "---", "[[Body]]"]), ["frontmatter", "frontmatter", "frontmatter", "frontmatter", "body"]);
	});
});

describe("wikilinkSpans", () => {
	const spans = (line: string) => wikilinkSpans(line).map(({ target, start, end }) => [target, line.slice(start, end)]);

	test("a plain link, an alias and a heading link: the target clean, the span the whole link", () => {
		assert.deepEqual(spans("see [[A]], [[B|bee]] and [[C#Part]]."), [
			["A", "[[A]]"],
			["B", "[[B|bee]]"],
			["C", "[[C#Part]]"],
		]);
	});

	test("table escapes \\| and &#124; leave the target clean, and the span covers the escape", () => {
		assert.deepEqual(spans("| [[A\\|a]] | [[B&#124;b]] |"), [
			["A", "[[A\\|a]]"],
			["B", "[[B&#124;b]]"],
		]);
	});

	test("an embed's span includes its !", () => {
		assert.deepEqual(spans("![[Note]] and ![[pic.png]]"), [["Note", "![[Note]]"]]);
	});

	test("a link in inline code, single or double backticks, is not a link", () => {
		assert.deepEqual(spans(`${tick}[[A]]${tick} and ${tick}${tick}x ${tick} [[B]]${tick}${tick} but [[C]]`), [["C", "[[C]]"]]);
	});

	test("inline code inside or between a link's brackets is removed, as extraction removes it, and the span covers it", () => {
		assert.deepEqual(spans(`[[Si${tick}x${tick}x]] and [${tick}y${tick}[Joined]]`), [
			["Six", `[[Si${tick}x${tick}x]]`],
			["Joined", `[${tick}y${tick}[Joined]]`],
		]);
	});

	test("a same-note heading link and a placeholder are not links", () => {
		assert.deepEqual(spans("[[#Heading]] [[{{date}}]] [[D]]"), [["D", "[[D]]"]]);
	});

	test("a CRLF line's trailing \\r changes nothing", () => {
		assert.deepEqual(spans("x [[A]]\r"), [["A", "[[A]]"]]);
	});
});

describe("agreement with the whole-note readers", () => {
	const notes = [
		[
			"---",
			"related: \"[[In frontmatter]]\"",
			"x: |",
			"  " + fence,
			"---",
			"# About [[Heading link]]",
			"Body [[One]] and [[Two|two]] and `[[code]]`.",
			fence,
			"[[In a fence]]",
			fence,
			"| [[Three\\|3]] | ![[Four]] | [[#Self]] |",
			"~~~",
			"[[Also fenced]]",
			"~~~",
			`End [[Five#Part]], [[Si${tick}x${tick}x]] and [${tick}y${tick}[Seven]].`,
		].join("\r\n"),
		["----", "a: [[X]]", "---", "[[Y]]"].join("\n"),
		["---", "a: [[X]]", "[[Y]]"].join("\n"),
		["\uFEFF---", "a: 1", "---", "[[Z]]"].join("\n"),
		// A BOM before an indented or quoted fence opener: both readers read past it (#107).
		["\uFEFF    " + fence, "[[a]]", "    " + fence, "[[b]]"].join("\n"),
		["\uFEFF> " + fence, "> [[a]]", "> " + fence, "[[c]]"].join("\n"),
	];

	test("the frontmatter lines are the ones stripFrontmatter removes", () => {
		for (const note of notes) {
			const lines = note.split("\n");
			const kept = lineRegions(lines).filter((r) => r !== "frontmatter").length;
			assert.equal(lines.length - kept, note.split("\n").length - stripFrontmatter(note).split("\n").length, JSON.stringify(note.slice(0, 20)));
		}
	});

	test("the spans on body and heading lines are exactly extractWikilinkTargets' links in the note without its frontmatter", () => {
		const found = notes.map((note) => {
			const lines = note.split("\n");
			const regions = lineRegions(lines);
			const fromSpans = lines.flatMap((line, i) => (regions[i] === "body" || regions[i] === "heading" ? wikilinkSpans(line).map((s) => s.target) : []));
			assert.deepEqual(fromSpans, extractWikilinkTargets(stripFrontmatter(note)), JSON.stringify(note.slice(0, 20)));
			return fromSpans;
		});
		assert.deepEqual(found[0], ["Heading link", "One", "Two", "Three", "Four", "Five", "Six", "Seven"]);
	});
});

test("both are exported to extensions through core/index.ts", () => {
	assert.equal(core.lineRegions, lineRegions);
	assert.equal(core.wikilinkSpans, wikilinkSpans);
});
