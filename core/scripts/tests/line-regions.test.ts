/**
 * lineRegions and wikilinkSpans read a note line by line by the same rules
 * extractWikilinkTargets reads it whole: fences as stripCodeRegions finds
 * them, inline code masked the same way, and every target through
 * extractWikilinkTargets itself. The agreement case pins that.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { extractWikilinkTargets, lineRegions, wikilinkSpans } from "../lib/wikilinks.ts";
import * as core from "../core/index.ts";

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

	test("a BOM before the opening --- still opens frontmatter", () => {
		assert.deepEqual(lineRegions(["﻿---", "a: 1", "---", "x"]), ["frontmatter", "frontmatter", "frontmatter", "body"]);
	});

	test("an unterminated block is not frontmatter, as frontmatter.ts reads it", () => {
		assert.deepEqual(lineRegions(["---", "a: 1", "text"]), ["body", "body", "body"]);
	});

	test("``` and ~~~ fences, a fence that never closes, and #s inside a fence", () => {
		const lines = [fence + "ts", "# not a heading", "[[x]]", fence, "~~~", "a", "~~~", "text", fence, "open to the end"];
		assert.deepEqual(lineRegions(lines), ["fence", "fence", "fence", "fence", "fence", "fence", "fence", "body", "fence", "fence"]);
	});

	test("a heading needs a space after its #s, and at most six", () => {
		assert.deepEqual(lineRegions(["#tag", "###### six", "####### seven"]), ["body", "heading", "body"]);
	});

	test("a fence-looking line inside frontmatter is frontmatter", () => {
		assert.deepEqual(lineRegions(["---", fence, "---", "x"]), ["frontmatter", "frontmatter", "frontmatter", "body"]);
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

	test("a same-note heading link and a placeholder are not links", () => {
		assert.deepEqual(spans("[[#Heading]] [[{{date}}]] [[D]]"), [["D", "[[D]]"]]);
	});

	test("a CRLF line's trailing \\r changes nothing", () => {
		assert.deepEqual(spans("x [[A]]\r"), [["A", "[[A]]"]]);
	});
});

test("agreement: the spans on body and heading lines are exactly extractWikilinkTargets' links", () => {
	const note = [
		"---",
		"related: \"[[In frontmatter]]\"",
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
		"End [[Five#Part]].",
	].join("\r\n");
	const lines = note.split("\n");
	const regions = lineRegions(lines);
	const fromSpans = lines.flatMap((line, i) => (regions[i] === "body" || regions[i] === "heading" ? wikilinkSpans(line).map((s) => s.target) : []));
	const body = lines.filter((_, i) => regions[i] !== "frontmatter").join("\n");
	assert.deepEqual(fromSpans, extractWikilinkTargets(body));
	assert.deepEqual(fromSpans, ["Heading link", "One", "Two", "Three", "Four", "Five"]);
});

test("both are exported to extensions through core/index.ts", () => {
	assert.equal(core.lineRegions, lineRegions);
	assert.equal(core.wikilinkSpans, wikilinkSpans);
});
