/**
 * The refresh worker and its qmd steps run from the OS temp folder, not the
 * vault, so a worker that lasts minutes never holds the vault open on
 * Windows (#106). What the vault cwd used to supply is passed explicitly: a
 * relative INDEX_PATH or QMD_CONFIG_DIR resolves against the vault. The one
 * thing qmd can't be told is a project-local `.qmd/index.y(a)ml`, which it
 * finds from its cwd when no `--index` is given (read in @tobilu/qmd
 * 2.5.3's `findLocalConfigPath`), so that case keeps the vault.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sentinelPathFor } from "./index.ts";
import { localQmdConfigAt, qmdStepOptions, workerArgsFor, workerSpawnOptions } from "./lib/refresh.ts";
import { rmTemp } from "./test-fakes.ts";

const step = { cmd: "node", args: ["qmd.js", "update"], shell: false, timeoutMs: 60_000 };

function vaultIn(t: { after: (fn: () => void) => void }, layout: Record<string, string> = {}): { root: string; vault: string } {
	const root = mkdtempSync(join(tmpdir(), "qmd-cwd-"));
	t.after(() => rmTemp(root));
	const vault = join(root, "v");
	mkdirSync(vault);
	for (const [rel, body] of Object.entries(layout)) {
		mkdirSync(join(root, rel, ".."), { recursive: true });
		writeFileSync(join(root, rel), body);
	}
	return { root, vault };
}

describe("the refresh worker runs from the temp folder (#106)", () => {
	test("the worker's own spawn: detached, hidden, from the temp folder", () => {
		assert.deepEqual(workerSpawnOptions(), { detached: true, stdio: "ignore", windowsHide: true, cwd: tmpdir() });
	});

	test("each qmd step, with --index, runs from the temp folder, hidden, on the step's limit", (t) => {
		const { vault } = vaultIn(t, { "v/.qmd/index.yml": "collections: {}\n" });
		const opts = qmdStepOptions(step, vault, "idx", { HOME: "/h" });
		assert.equal(opts.cwd, tmpdir(), "an --index wins over a local config, so the vault isn't needed");
		assert.deepEqual({ ...opts, cwd: "", env: {} }, { stdio: "ignore", timeout: 60_000, shell: false, windowsHide: true, cwd: "", env: {} });
		assert.equal(opts.env["HOME"], "/h", "the rest of the environment passes through");
	});

	test("without --index and no local config, the temp folder too", (t) => {
		const { vault } = vaultIn(t);
		assert.equal(qmdStepOptions(step, vault, null, {}).cwd, tmpdir());
	});

	test("without --index, a local .qmd config at or above the vault keeps the vault, so qmd still finds it", (t) => {
		const here = vaultIn(t, { "v/.qmd/index.yml": "collections: {}\n" });
		assert.equal(qmdStepOptions(step, here.vault, null, {}).cwd, here.vault);
		const above = vaultIn(t, { ".qmd/index.yaml": "collections: {}\n" });
		assert.equal(qmdStepOptions(step, above.vault, null, {}).cwd, above.vault);
		assert.equal(localQmdConfigAt(above.vault), join(above.root, ".qmd", "index.yaml"));
		const neither = vaultIn(t, { "v/.qmd/other.yml": "" });
		assert.equal(localQmdConfigAt(neither.vault), null, "only index.yaml or index.yml counts, as in qmd");
	});

	test("a relative INDEX_PATH or QMD_CONFIG_DIR resolves against the vault, the cwd it used to have", (t) => {
		const { vault } = vaultIn(t);
		const env = qmdStepOptions(step, vault, "idx", { INDEX_PATH: join("store", "i.sqlite"), QMD_CONFIG_DIR: "cfg" }).env;
		assert.equal(env["INDEX_PATH"], join(vault, "store", "i.sqlite"));
		assert.equal(env["QMD_CONFIG_DIR"], join(vault, "cfg"));
		const abs = resolve(tmpdir(), "elsewhere");
		const kept = qmdStepOptions(step, vault, "idx", { INDEX_PATH: abs, QMD_CONFIG_DIR: abs }).env;
		assert.deepEqual([kept["INDEX_PATH"], kept["QMD_CONFIG_DIR"]], [abs, abs], "absolute ones are kept");
		const unset = qmdStepOptions(step, vault, "idx", { INDEX_PATH: "" }).env;
		assert.ok(!("QMD_CONFIG_DIR" in unset), "an unset one stays unset");
		assert.equal(unset["INDEX_PATH"], "", "an empty one is qmd's 'unset' and stays as it is");
	});

	test("the worker's arguments are absolute, so its cwd doesn't matter to them", () => {
		assert.deepEqual(workerArgsFor("rel-vault", null), [`--vault=${resolve("rel-vault")}`]);
		assert.equal(sentinelPathFor("/v", { QMD_REFRESH_SENTINEL: join("rel", "s") }), resolve("rel", "s"));
	});
});
