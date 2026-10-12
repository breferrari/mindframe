/**
 * The core's old qmd import paths (#70): lib/qmd.ts and the qmd helpers in
 * lib/session-start.ts re-export the qmd extension's own code, so vendored
 * scripts that still import them keep working until #96 removes them. Each
 * must be the very binding the extension exports, so the two can't drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as oldQmd from "../lib/qmd.ts";
import * as sessionStart from "../lib/session-start.ts";
import * as qmd from "../extensions/qmd/lib/qmd.ts";
import * as indexName from "../extensions/qmd/lib/index-name.ts";

test("lib/qmd.ts re-exports every export of the extension's lib/qmd.ts, binding for binding", () => {
	assert.deepEqual(Object.keys(oldQmd).sort(), Object.keys(qmd).sort());
	for (const [name, value] of Object.entries(qmd)) assert.equal((oldQmd as Record<string, unknown>)[name], value, name);
});

test("lib/session-start.ts re-exports every export of the extension's lib/index-name.ts, binding for binding", () => {
	const names = Object.keys(indexName);
	for (const name of [
		"isValidQmdIndex",
		"qmdIndexOf",
		"deriveQmdIndex",
		"resolveQmdIndexOf",
		"qmdArgsWithIndex",
		"isQmdNativeAbiMismatch",
		"qmdPackageRootFromEntry",
		"qmdMinVersionOf",
		"resolveIndexStorePath",
	]) assert.ok(names.includes(name), `${name} moved to the extension`);
	for (const [name, value] of Object.entries(indexName)) assert.equal((sessionStart as Record<string, unknown>)[name], value, name);
});

test("the text forms stay in lib/session-start.ts, over the moved functions", () => {
	const manifest = JSON.stringify({ template: "wiki-mind", qmd_index: "pinned", qmd_min_version: "2.0.0" });
	assert.equal(sessionStart.parseQmdIndex(manifest), "pinned");
	assert.equal(sessionStart.resolveQmdIndex(manifest, "/v/x"), "pinned");
	assert.equal(sessionStart.parseQmdMinVersion(manifest), "2.0.0");
	assert.equal(sessionStart.resolveQmdIndex(null, "/v/My Wiki"), "my-wiki");
});

test("each re-export is marked for removal in #96", async () => {
	const { readFileSync } = await import("node:fs");
	for (const file of ["../lib/qmd.ts", "../lib/session-start.ts"]) {
		assert.match(readFileSync(new URL(file, import.meta.url), "utf-8"), /re-export, removed in #96/, file);
	}
});
