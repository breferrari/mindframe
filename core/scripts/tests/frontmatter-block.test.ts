/**
 * One frontmatter rule for every reader in the core (lib/frontmatter-block.ts,
 * #82): an optional BOM, a first line that is `---`, closed by the first later
 * line that is `---`; a delimiter line may end in `\r`, spaces or tabs; an
 * unterminated block is no frontmatter. Each reader is held to a pinned
 * expectation per fixture, not only to the others, so they can't all drift
 * together.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { frontmatterBlock, frontmatterLines } from "../lib/frontmatter-block.ts";
import { countTicketIdWikilinks, shouldSkipFile, validateContent } from "../lib/frontmatter.ts";
import { hardWrappedParagraphs, isVerbatim } from "../lib/prose-width.ts";
import { extractFrontmatterField, stripFrontmatter } from "../lib/session-start.ts";
import { extractAliases, extractWikilinkTargets, lineRegions } from "../lib/wikilinks.ts";
import * as core from "../core/index.ts";

type Fixture = {
	readonly name: string;
	readonly content: string;
	/** null: no frontmatter. Otherwise the yaml lines, \r dropped, and the body that follows. */
	readonly expect: { readonly yaml: string; readonly body: string } | null;
};

const FM = "title: T\naliases: [A]\nverbatim: true";
const FIXTURES: readonly Fixture[] = [
	{ name: "plain", content: `---\n${FM}\n---\nBody line.\n`, expect: { yaml: FM, body: "Body line.\n" } },
	{ name: "a BOM before the opener", content: `\uFEFF---\n${FM}\n---\nBody line.\n`, expect: { yaml: FM, body: "Body line.\n" } },
	{ name: "a first line of ----", content: `----\n${FM}\n---\nBody line.\n`, expect: null },
	{ name: "a first line of ---x", content: `---x\n${FM}\n---\nBody line.\n`, expect: null },
	{ name: "CRLF", content: `---\r\n${FM.replaceAll("\n", "\r\n")}\r\n---\r\nBody line.\r\n`, expect: { yaml: FM, body: "Body line.\r\n" } },
	{ name: "CRLF ending in ---\\r with no final newline", content: `---\r\n${FM.replaceAll("\n", "\r\n")}\r\n---\r`, expect: { yaml: FM, body: "" } },
	{ name: "unterminated", content: `---\n${FM}\nBody line.\n`, expect: null },
	{ name: "trailing spaces and tabs on the delimiters (inferred)", content: `--- \n${FM}\n---\t\nBody line.\n`, expect: { yaml: FM, body: "Body line.\n" } },
	{ name: "a value holding ---", content: "---\ntitle: a --- b\n---\nBody line.\n", expect: { yaml: "title: a --- b", body: "Body line.\n" } },
	{ name: "an empty block", content: "---\n---\nBody line.\n", expect: { yaml: "", body: "Body line.\n" } },
	{ name: "--- further down the body", content: "Intro.\n---\nmore\n", expect: null },
	{ name: "a ---- line inside, then the close", content: `---\n${FM}\n----\n---\nBody line.\n`, expect: { yaml: `${FM}\n----`, body: "Body line.\n" } },
];

const field = (yaml: string, key: string): string | null => {
	const line = yaml.split("\n").find((l) => l.startsWith(`${key}:`));
	return line === undefined ? null : line.slice(key.length + 1).trim();
};

describe("frontmatterBlock: the rule", () => {
	for (const f of FIXTURES) {
		test(f.name, () => {
			const block = frontmatterBlock(f.content);
			if (f.expect === null) return assert.equal(block, null);
			assert.ok(block !== null);
			assert.equal(block.yaml, f.expect.yaml);
			assert.equal(f.content.slice(block.body), f.expect.body);
		});
	}
});

describe("every reader agrees with the rule", () => {
	for (const f of FIXTURES) {
		test(f.name, () => {
			const has = f.expect !== null;
			const yaml = f.expect?.yaml ?? "";
			const lines = f.content.split("\n");
			const span = frontmatterLines(lines);
			assert.equal(span !== null, has, "frontmatterLines");
			assert.equal(stripFrontmatter(f.content), has ? f.expect!.body : f.content, "stripFrontmatter");
			assert.equal(extractFrontmatterField(f.content, "title"), has ? field(yaml, "title") : null, "extractFrontmatterField");
			assert.deepEqual(extractAliases(f.content), has && field(yaml, "aliases") === "[A]" ? ["A"] : [], "extractAliases");
			assert.equal(isVerbatim(f.content), has && field(yaml, "verbatim") === "true", "isVerbatim");
			const regions = lineRegions(lines);
			assert.equal(regions.filter((r) => r === "frontmatter").length, span === null ? 0 : span.close + 1, "lineRegions");
			assert.equal(validateContent(f.content).includes("Missing YAML frontmatter"), !has, "validateContent");
			// A frontmatter block is never prose, so its consecutive yaml lines never read as a hard wrap.
			if (has) assert.ok(hardWrappedParagraphs(f.content).every((n) => n > (span?.close ?? -1) + 1), "hardWrappedParagraphs");
		});
	}
});

describe("frontmatter.ts's other readers (#82)", () => {
	const tick = "`";
	test("an instruction file, current or retired, is not a note; a note merely named like one is", () => {
		for (const name of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) assert.equal(shouldSkipFile(`/v/${name}`), true, name);
		for (const path of ["/v/people/Claude.md", "/v/topics/Gemini.md", "/v/x/agents.md", "/v/notes/Claude notes.md"]) assert.equal(shouldSkipFile(path), false, path);
	});

	test("a fence-looking line inside a yaml value doesn't hide the body's links", () => {
		const note = `---\ndescription: |\n  ${tick.repeat(3)}\n---\n${"Words. ".repeat(60)}\nSee [[Real Link]] and [[PROJ-12]].\n`;
		assert.ok(!validateContent(note).some((w) => /No \[\[wikilinks\]\]/.test(w)), "the body's link is found");
		assert.equal(countTicketIdWikilinks(note), 1);
	});

	test("a ticket link inside code is an example, not a link", () => {
		assert.equal(countTicketIdWikilinks(`See [[PROJ-12]] and ${tick}[[PROJ-34]]${tick}.\n${tick.repeat(3)}\n[[PROJ-56]]\n${tick.repeat(3)}\n`), 1);
	});

	test("a note whose only link is in code has no links", () => {
		const body = `${"Words. ".repeat(60)}\n${tick}[[Only in code]]${tick}\n`;
		assert.ok(validateContent(`---\ntitle: t\n---\n${body}`).some((w) => /wikilink/i.test(w)), "warned");
		assert.ok(!validateContent(`---\ntitle: t\n---\n${body}[[Real]]\n`).some((w) => /wikilink/i.test(w)), "a real link counts");
	});
});

describe("code in frontmatter", () => {
	const tick = "`";
	test("a fence-looking line in a yaml value opens no fence: extraction still finds the body's links", () => {
		assert.deepEqual(extractWikilinkTargets(`---\ndescription: |\n  ${tick.repeat(3)}\n---\nSee [[Body Link]].\n`), ["Body Link"]);
	});

	test("a link inside inline code in a yaml value is no link", () => {
		const note = `---\ndescription: write ${tick}[[PROJ-1]]${tick} as text\n---\nBody.\n`;
		assert.equal(countTicketIdWikilinks(note), 0);
		assert.deepEqual(extractWikilinkTargets(note), []);
	});
});

test("frontmatterBlock is exported to extensions through core/index.ts", () => {
	assert.equal(core.frontmatterBlock, frontmatterBlock);
	assert.deepEqual(core.frontmatterBlock("---\na: 1\n---\nb"), { yaml: "a: 1", body: 13 });
});
