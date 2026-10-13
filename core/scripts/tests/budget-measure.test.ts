/**
 * The budget's measure, absorbed from obsidian-mind #340 and #341 (#102): a
 * budget can be held in a JSON envelope's size, a degradable level fits its
 * body by asking whether the whole render fits, and the ceiling leaves room
 * for the SessionStart envelope. obsidian-mind's own tests of these drive
 * its hook entry points, so these test the library alone.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { HOOK_OUTPUT_MAX_CHARS, envelopedLimit } from "../lib/hook-io.ts";
import {
	INJECTION_CEILING_BYTES,
	METER_HEADROOM,
	applyInjectionBudget,
	enveloped,
	topHeadlines,
	utf8Bytes,
	type BudgetSection,
} from "../lib/session-start.ts";

describe("enveloped: a text's size inside a JSON envelope", () => {
	test("escapes count: a newline is two characters on the wire", () => {
		assert.equal(utf8Bytes("a\nb"), 3);
		assert.equal(enveloped("a\nb"), JSON.stringify("a\nb").length);
	});

	test("never less than the UTF-8 bytes: multi-byte text keeps its byte size", () => {
		assert.equal(enveloped("ééé"), utf8Bytes("ééé"));
		assert.ok(enveloped("ééé") >= JSON.stringify("ééé").length);
	});
});

describe("applyInjectionBudget's measure", () => {
	const quoted = '"x"\n'.repeat(40);
	const sections: BudgetSection[] = [
		{ header: "", body: "## Session Context", priority: 0 },
		{ header: "### Quotes", body: quoted, priority: 5, fallback: "Quotes: on demand." },
	];

	test("held to the enveloped size, a section that fits as bytes is given up", () => {
		const bytes = applyInjectionBudget(sections, 200);
		const json = applyInjectionBudget(sections, 200, enveloped);
		assert.deepEqual(bytes.collapsed, [], "as UTF-8 bytes it fits");
		assert.deepEqual(json.collapsed, ["Quotes"], "escaped, it doesn't");
		assert.equal(json.bytes, enveloped(json.text), "the result's size is in the budget's measure");
	});

	test("a level's fit is handed a test of the whole render, by the budget's measure", () => {
		const items = Array.from({ length: 30 }, (_, i) => `- "item ${i}"`);
		const seen: unknown[] = [];
		const ladder: BudgetSection = {
			header: "### Items",
			body: items.join("\n"),
			priority: 5,
			fallback: "Items: on demand.",
			levels: [
				{
					name: "first items",
					fit: (fits) => {
						seen.push(typeof fits);
						for (let n = items.length - 1; n >= 1; n--) if (fits(items.slice(0, n).join("\n"))) return items.slice(0, n).join("\n");
						return null;
					},
				},
			],
		};
		const result = applyInjectionBudget([{ header: "", body: "## Session Context", priority: 0 }, ladder], 260, enveloped);
		assert.deepEqual(seen, ["function"]);
		assert.deepEqual(result.degraded, [{ section: "Items", level: "first items" }]);
		assert.ok(result.bytes <= 260, `${result.bytes}`);
	});
});

test("topHeadlines keeps the most headlines the test accepts, and says how many more there are", () => {
	const headlines = ["One", "Two", "Three", "Four"];
	const body = topHeadlines(headlines, (b) => b.split("\n").length <= 3);
	assert.ok(body !== null);
	assert.match(body, /\+2 more goals/);
	assert.equal(topHeadlines(headlines, () => false), null);
});

test("the ceiling leaves room for the SessionStart envelope (obsidian-mind #341)", () => {
	assert.equal(INJECTION_CEILING_BYTES, envelopedLimit("SessionStart").max - METER_HEADROOM);
	assert.ok(INJECTION_CEILING_BYTES < HOOK_OUTPUT_MAX_CHARS - METER_HEADROOM, "below the plain-stdout ceiling by the envelope's size");
});
