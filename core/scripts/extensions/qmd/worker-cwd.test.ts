/**
 * The refresh worker and its qmd steps run from the OS temp folder, not the
 * vault, so a worker that lasts minutes doesn't hold the vault open on
 * Windows (#106). What the vault cwd used to supply is passed explicitly: a
 * relative INDEX_PATH or QMD_CONFIG_DIR resolves against the vault. The one
 * thing qmd can't be told is a project-local `.qmd/index.y(a)ml`, which it
 * finds from its cwd when no `--index` is given (read in @tobilu/qmd
 * 2.5.3's `findLocalConfigPath`), so the vault stays the cwd whenever the
 * temp folder would find a different one.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sentinelPathFor } from "./index.ts";
import { localQmdConfigAt, qmdCwdFor, qmdPathsAgainst } from "./lib/qmd-cwd.ts";
import { rmTemp, spawnCalls } from "./test-fakes.ts";

const DIR = fileURLToPath(new URL(".", import.meta.url));

/** A fresh root holding a vault `v` and a temp folder `t`, plus `files` (paths as segment lists). */
function layout(t: { after: (fn: () => void) => void }, files: string[][] = []): { root: string; vault: string; temp: string } {
	const root = mkdtempSync(join(tmpdir(), "qmd-cwd-"));
	t.after(() => rmTemp(root));
	const vault = join(root, "v");
	const temp = join(root, "t");
	mkdirSync(vault);
	mkdirSync(temp);
	for (const segments of files) {
		const file = join(root, ...segments);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, "collections: {}\n");
	}
	return { root, vault, temp };
}

describe("the refresh worker runs from the temp folder (#106)", () => {
	test("with --index, qmd's steps run from the temp folder, even beside a local config", (t) => {
		const { vault, temp } = layout(t, [["v", ".qmd", "index.yml"]]);
		assert.equal(qmdCwdFor(vault, "idx", temp), temp);
		assert.equal(qmdCwdFor(vault, "idx"), tmpdir(), "the OS temp folder by default");
	});

	test("without --index and no local config on either side, the temp folder too", (t) => {
		const { vault, temp } = layout(t);
		assert.equal(qmdCwdFor(vault, null, temp), temp);
	});

	test("without --index, a local config at or above the vault keeps the vault, so qmd still finds it", (t) => {
		const here = layout(t, [["v", ".qmd", "index.yml"]]);
		assert.equal(qmdCwdFor(here.vault, null, here.temp), here.vault);
		const above = layout(t, [[".qmd", "index.yaml"]]);
		assert.equal(localQmdConfigAt(above.vault), join(above.root, ".qmd", "index.yaml"));
		assert.equal(qmdCwdFor(above.vault, null, above.temp), above.temp, "the temp folder finds the same one");
	});

	test("without --index, a local config only the temp folder would find keeps the vault, so qmd doesn't take it", (t) => {
		// On Windows the temp folder sits in the user profile, where a .qmd/ can be.
		const { vault, temp } = layout(t, [["t", ".qmd", "index.yml"]]);
		assert.equal(qmdCwdFor(vault, null, temp), vault);
	});

	test("a vault reached through a link is walked by its real path, as qmd walks its cwd", (t) => {
		// The real vault sits under a/, which holds a .qmd/; the link b/v names no such parent.
		const { root, temp } = layout(t, [["a", ".qmd", "index.yml"]]);
		mkdirSync(join(root, "a", "real"));
		mkdirSync(join(root, "b"));
		const vault = join(root, "b", "v");
		// A junction needs no privilege on Windows; elsewhere the type is ignored.
		symlinkSync(join(root, "a", "real"), vault, "junction");
		assert.equal(qmdCwdFor(vault, null, temp), vault);
	});

	test("only .qmd/index.yaml or .qmd/index.yml counts, as in qmd", (t) => {
		const { root, vault } = layout(t, [["v", ".qmd", "other.yml"]]);
		// Whatever lies above the test's root (a .qmd/ in a dev's profile) is found from the root too.
		assert.equal(localQmdConfigAt(join(vault, "deeper")), localQmdConfigAt(root));
	});

	test("a temp folder that doesn't exist keeps the vault", (t) => {
		const { root, vault } = layout(t);
		assert.equal(qmdCwdFor(vault, "idx", join(root, "gone")), vault);
	});

	test("a relative path variable qmd reads resolves against the vault, the cwd it used to have", (t) => {
		const { vault } = layout(t);
		const env = qmdPathsAgainst(vault, { INDEX_PATH: join("store", "i.sqlite"), QMD_CONFIG_DIR: "cfg", XDG_CONFIG_HOME: "xc", XDG_CACHE_HOME: "xk", HOME: "h" });
		assert.deepEqual(env, {
			INDEX_PATH: join(vault, "store", "i.sqlite"),
			QMD_CONFIG_DIR: join(vault, "cfg"),
			XDG_CONFIG_HOME: join(vault, "xc"),
			XDG_CACHE_HOME: join(vault, "xk"),
			HOME: "h",
		});
		const abs = resolve(tmpdir(), "elsewhere");
		assert.deepEqual(qmdPathsAgainst(vault, { INDEX_PATH: abs, QMD_CONFIG_DIR: abs }), { INDEX_PATH: abs, QMD_CONFIG_DIR: abs }, "absolute ones are kept");
		if (process.platform === "win32") {
			const rooted = qmdPathsAgainst(vault, { INDEX_PATH: "\\idx\\i.sqlite" })["INDEX_PATH"];
			assert.equal(rooted, resolve(vault, "\\idx\\i.sqlite"),"a root-relative one takes the vault's drive, not the temp folder's");
			assert.equal(rooted?.slice(0, 2).toLowerCase(), vault.slice(0, 2).toLowerCase());
		}
		assert.deepEqual(qmdPathsAgainst(vault, { INDEX_PATH: "" }), { INDEX_PATH: "" }, "an empty one is qmd's unset and stays so; an absent one stays absent");
	});

	test("a relative sentinel from the environment is made absolute, since the worker runs elsewhere", () => {
		assert.equal(sentinelPathFor("/v", { QMD_REFRESH_SENTINEL: join("rel", "s") }), resolve("rel", "s"));
	});

	// The helpers above are only as good as the spawns that use them.
	test("the worker's spawn and each qmd step's take their cwd from them", () => {
		const workers = spawnCalls(readFileSync(join(DIR, "lib", "refresh.ts"), "utf8"));
		assert.ok(workers.length > 0);
		for (const call of workers) assert.match(call, /\bcwd:\s*tmpdir\(\)/);
		const source = readFileSync(join(DIR, "qmd-refresh-run.ts"), "utf8");
		const steps = spawnCalls(source);
		assert.ok(steps.length > 0);
		for (const call of steps) {
			assert.match(call, /[{,\s]cwd,\s/);
			assert.match(call, /[{,\s]env,?\s/);
		}
		assert.match(source, /const cwd = qmdCwdFor\(vault, index\);/);
		assert.match(source, /const env = qmdPathsAgainst\(vault, process\.env\);/);
	});
});
