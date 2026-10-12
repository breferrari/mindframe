/**
 * Every manifest reader in lib/session-start.ts has a form that takes the
 * parsed manifest, so an entry point parses vault-manifest.json once (openVault
 * does) and passes the result (#52). The string forms stay, as thin wrappers:
 * each must answer exactly as its object form does on the same manifest.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	infraRootFilenamesOf,
	injectionBudgetOf,
	instructionBudgetOf,
	listingCollapseThresholdOf,
	manifestOf,
	parseInfraRootFilenames,
	parseInjectionBudget,
	parseInstructionBudget,
	parseListingCollapseThreshold,
	parseQmdIndex,
	parseQmdMinVersion,
	qmdIndexOf,
	qmdMinVersionOf,
	resolveQmdIndex,
	resolveQmdIndexOf,
	type ManifestObject,
} from "../lib/session-start.ts";

const FULL = JSON.stringify({
	eager_layer_budget_bytes: 4000,
	eager_layer_instruction_budget_bytes: 12000,
	listing_collapse_threshold: 30,
	qmd_index: "my-vault",
	qmd_min_version: "2.0.0",
	template: "obsidian-mind",
	infrastructure: ["AGENTS.md", "README.*.md", ".claude/**", 4],
});

const SOURCES: readonly (string | null)[] = [
	null,
	"",
	"not json",
	"[]",
	"null",
	"7",
	"{}",
	FULL,
	JSON.stringify({ eager_layer_budget_bytes: 0, eager_layer_instruction_budget_bytes: -5, listing_collapse_threshold: 2.5 }),
	JSON.stringify({ eager_layer_budget_bytes: "4000", qmd_index: "../escape", qmd_min_version: "", template: 3 }),
	JSON.stringify({ qmd_index: 7, qmd_min_version: 2, template: "shared-template" }),
];

describe("manifestOf", () => {
	test("an object manifest is parsed; absent, malformed and non-object ones are null", () => {
		assert.deepEqual(manifestOf('{"a":1}'), { a: 1 });
		for (const s of [null, "", "not json", "[]", "null", "7", '"text"']) assert.equal(manifestOf(s), null, String(s));
	});
});

describe("each object form answers as its string form", () => {
	const pairs: ReadonlyArray<readonly [string, (s: string | null) => unknown, (m: ManifestObject) => unknown]> = [
		["injection budget", parseInjectionBudget, injectionBudgetOf],
		["instruction budget", parseInstructionBudget, instructionBudgetOf],
		["listing collapse threshold", parseListingCollapseThreshold, listingCollapseThresholdOf],
		["qmd index", parseQmdIndex, qmdIndexOf],
		["qmd min version", parseQmdMinVersion, qmdMinVersionOf],
		["infrastructure root filenames", parseInfraRootFilenames, infraRootFilenamesOf],
	];
	for (const [name, fromText, fromObject] of pairs) {
		test(name, () => {
			for (const source of SOURCES) assert.deepEqual(fromObject(manifestOf(source)), fromText(source), `${name}: ${String(source)}`);
		});
	}

	test("the resolved qmd index, pinned, derived from the folder, or from the template", () => {
		for (const root of ["/vaults/My Vault", "/", "C:\\Vaults\\work"]) {
			for (const source of SOURCES) assert.equal(resolveQmdIndexOf(manifestOf(source), root), resolveQmdIndex(source, root), `${root}: ${String(source)}`);
		}
	});

	test("the readers find what the full manifest sets", () => {
		const m = manifestOf(FULL);
		assert.deepEqual([injectionBudgetOf(m), instructionBudgetOf(m), listingCollapseThresholdOf(m), qmdIndexOf(m), qmdMinVersionOf(m)], [4000, 12000, 30, "my-vault", "2.0.0"]);
		assert.deepEqual(infraRootFilenamesOf(m), ["AGENTS.md", "README.*.md"]);
	});
});

describe("each reader holds its rule, pinned to values (not only to its string form)", () => {
	const m = (o: Record<string, unknown>) => manifestOf(JSON.stringify(o));
	test("a budget or threshold is a positive integer; anything else is unset", () => {
		for (const bad of [0, -5, 2.5, "4000", null, true, [4000]]) {
			assert.equal(injectionBudgetOf(m({ eager_layer_budget_bytes: bad })), null, String(bad));
			assert.equal(instructionBudgetOf(m({ eager_layer_instruction_budget_bytes: bad })), null, String(bad));
			assert.equal(listingCollapseThresholdOf(m({ listing_collapse_threshold: bad })), null, String(bad));
		}
		assert.equal(injectionBudgetOf(m({ eager_layer_budget_bytes: 1 })), 1);
	});

	test("a qmd index is a safe name; a min version is a non-empty string", () => {
		for (const bad of ["../escape", "a/b", "", " x", ".hidden", 7, null]) assert.equal(qmdIndexOf(m({ qmd_index: bad })), null, String(bad));
		assert.equal(qmdIndexOf(m({ qmd_index: "work_2.vault-x" })), "work_2.vault-x");
		for (const bad of ["", 2, null]) assert.equal(qmdMinVersionOf(m({ qmd_min_version: bad })), null, String(bad));
	});

	test("the resolved index: the pin, else the folder's slug, else the template", () => {
		assert.equal(resolveQmdIndexOf(m({ qmd_index: "pinned", template: "t" }), "/vaults/My Vault"), "pinned");
		assert.equal(resolveQmdIndexOf(m({ template: "shared" }), "/"), "shared");
		assert.equal(resolveQmdIndexOf(m({ template: "../bad" }), "/"), null);
	});

	test("infrastructure root filenames: strings without a slash only", () => {
		assert.deepEqual(infraRootFilenamesOf(m({ infrastructure: ["AGENTS.md", ".claude/**", 3, "README.*.md"] })), ["AGENTS.md", "README.*.md"]);
		assert.deepEqual(infraRootFilenamesOf(m({ infrastructure: "AGENTS.md" })), []);
	});

	test("the parsed manifest is frozen through and through, so no extension can change what the core reads", () => {
		const manifest = manifestOf(FULL) as Record<string, unknown>;
		assert.ok(Object.isFrozen(manifest));
		assert.ok(Object.isFrozen(manifest["infrastructure"]));
		assert.throws(() => {
			manifest["eager_layer_budget_bytes"] = 1e9;
		});
		assert.equal(injectionBudgetOf(manifest), 4000);
	});
});
