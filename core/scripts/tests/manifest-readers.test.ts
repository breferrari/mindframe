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
} from "../lib/session-start.ts";

const SOURCES: readonly (string | null)[] = [
	null,
	"",
	"not json",
	"[]",
	"null",
	"7",
	"{}",
	JSON.stringify({
		eager_layer_budget_bytes: 4000,
		eager_layer_instruction_budget_bytes: 12000,
		listing_collapse_threshold: 30,
		qmd_index: "my-vault",
		qmd_min_version: "2.0.0",
		template: "obsidian-mind",
		infrastructure: ["AGENTS.md", "README.*.md", ".claude/**", 4],
	}),
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
	const pairs = [
		["injection budget", parseInjectionBudget, injectionBudgetOf],
		["instruction budget", parseInstructionBudget, instructionBudgetOf],
		["listing collapse threshold", parseListingCollapseThreshold, listingCollapseThresholdOf],
		["qmd index", parseQmdIndex, qmdIndexOf],
		["qmd min version", parseQmdMinVersion, qmdMinVersionOf],
		["infrastructure root filenames", parseInfraRootFilenames, infraRootFilenamesOf],
	] as const;
	for (const [name, fromText, fromObject] of pairs) {
		test(name, () => {
			for (const source of SOURCES) assert.deepEqual((fromObject as (m: unknown) => unknown)(manifestOf(source)), (fromText as (s: string | null) => unknown)(source), `${name}: ${String(source)}`);
		});
	}

	test("the resolved qmd index, pinned, derived from the folder, or from the template", () => {
		for (const root of ["/vaults/My Vault", "/", "C:\\Vaults\\work"]) {
			for (const source of SOURCES) assert.equal(resolveQmdIndexOf(manifestOf(source), root), resolveQmdIndex(source, root), `${root}: ${String(source)}`);
		}
	});

	test("the readers find what the full manifest sets", () => {
		const m = manifestOf(SOURCES[7] ?? null);
		assert.deepEqual([injectionBudgetOf(m), instructionBudgetOf(m), listingCollapseThresholdOf(m), qmdIndexOf(m), qmdMinVersionOf(m)], [4000, 12000, 30, "my-vault", "2.0.0"]);
		assert.deepEqual(infraRootFilenamesOf(m), ["AGENTS.md", "README.*.md"]);
	});
});
