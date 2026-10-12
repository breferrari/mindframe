/**
 * QMD's session-start work (session.ts, the core's qmd-session.ts until
 * #70), over injected side effects: no test here runs a real QMD or touches
 * the user's QMD store.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { manifestOf } from "../../lib/manifest.ts";
import { EMPTY_STORE_BYTES, QMD_SWITCH, REFRESH_SWITCH, qmdSessionStartOf, type QmdDeps } from "./session.ts";
import { VAULT, fakeDeps } from "./fakes.ts";

/** The manifest's text, parsed the way openVault parses it, then the work. */
const qmdSessionStart = (vaultRoot: string, json: string | null, script: string | undefined, deps: QmdDeps) =>
	qmdSessionStartOf(vaultRoot, manifestOf(json), script, deps);

const MANIFEST = JSON.stringify({ template: "wiki-mind", qmd_index: "", qmd_min_version: "2.0.0" });

describe("QMD's session-start work", () => {
	test("QMD absent: no probe, no spawn, no note", () => {
		const { deps, calls } = fakeDeps({ entry: null });
		const result = qmdSessionStart(VAULT, MANIFEST, undefined, deps);
		assert.deepEqual(result, { notes: [], refresh: null });
		assert.deepEqual(calls, { sync: [], detached: [] });
	});

	test(`${QMD_SWITCH}=off: nothing at all, even with QMD installed`, () => {
		const { deps, calls } = fakeDeps({ env: { [QMD_SWITCH]: "off" } });
		assert.deepEqual(qmdSessionStart(VAULT, MANIFEST, undefined, deps), { notes: [], refresh: null });
		assert.deepEqual(calls, { sync: [], detached: [] });
	});

	test("a healthy, populated store: a background update on this vault's derived index, from the temp folder", () => {
		const { deps, calls } = fakeDeps({});
		const result = qmdSessionStart(VAULT, MANIFEST, undefined, deps);
		assert.deepEqual(result.notes, []);
		assert.equal(result.refresh, "update");
		assert.equal(calls.detached.length, 1);
		const args = calls.detached[0]?.args ?? [];
		assert.deepEqual(args.slice(-3), ["--index", "my-wiki", "update"]);
		assert.notEqual(calls.detached[0]?.cwd, VAULT, "never holds the vault folder open");
	});

	test("a missing or near-empty store: the idempotent bootstrap, run from the vault", () => {
		for (const storeBytes of [null, 98_304]) {
			const { deps, calls } = fakeDeps({ storeBytes });
			assert.equal(qmdSessionStart(VAULT, MANIFEST, undefined, deps).refresh, "bootstrap");
			assert.equal(calls.detached[0]?.cwd, VAULT);
			assert.ok(calls.detached[0]?.args.includes(".scripts/qmd-bootstrap.ts"));
		}
	});

	test("an ABI mismatch is rebuilt, and the note says whether the rebuild worked", () => {
		const mismatch = { status: 1, stderr: "Error: ... was compiled against a different Node.js version using NODE_MODULE_VERSION 115" };
		const ok = fakeDeps({ status: mismatch, rebuild: 0 });
		const fixed = qmdSessionStart(VAULT, MANIFEST, undefined, ok.deps);
		assert.ok(ok.calls.sync.some((c) => c.includes("npm rebuild better-sqlite3")));
		assert.deepEqual(fixed.notes.map((n) => n.header), ["### QMD Self-Heal"]);
		assert.match(fixed.notes[0]?.body ?? "", /was rebuilt this session/);
		const failed = qmdSessionStart(VAULT, MANIFEST, undefined, fakeDeps({ status: mismatch, rebuild: 1 }).deps);
		assert.match(failed.notes[0]?.body ?? "", /automatic `npm rebuild better-sqlite3` failed/);
	});

	test("a healthy probe never rebuilds", () => {
		const { deps, calls } = fakeDeps({ status: { status: 0, stderr: "" } });
		qmdSessionStart(VAULT, MANIFEST, undefined, deps);
		assert.ok(!calls.sync.some((c) => c.includes("npm rebuild")));
	});

	test("a version below qmd_min_version adds a warning note; at or above it, none", () => {
		const old = qmdSessionStart(VAULT, MANIFEST, undefined, fakeDeps({ version: "qmd 1.9.0\n" }).deps);
		assert.deepEqual(old.notes.map((n) => n.header), ["### QMD Version"]);
		assert.match(old.notes[0]?.body ?? "", /below this vault's minimum \(2\.0\.0\)/);
		assert.deepEqual(qmdSessionStart(VAULT, MANIFEST, undefined, fakeDeps({ version: "qmd 2.0.0\n" }).deps).notes, []);
		const noFloor = fakeDeps({ version: "qmd 0.1.0\n" });
		assert.deepEqual(qmdSessionStart(VAULT, JSON.stringify({ template: "wiki-mind" }), undefined, noFloor.deps).notes, []);
		assert.ok(!noFloor.calls.sync.some((c) => c.includes("--version")), "no floor declared, no version probe");
	});
});

describe("VAULT_QMD_REFRESH=off: no detached refresh (#94, as obsidian-mind #338)", () => {
	test("the switch's name is obsidian-mind's", () => {
		assert.equal(REFRESH_SWITCH, "VAULT_QMD_REFRESH");
	});

	test("off: no detached update or bootstrap, refresh null, and the notes still show", () => {
		for (const storeBytes of [EMPTY_STORE_BYTES * 10, 10]) {
			const { deps, calls } = fakeDeps({ env: { [REFRESH_SWITCH]: "off" }, version: "qmd 1.0.0\n", storeBytes });
			const result = qmdSessionStart(VAULT, MANIFEST, undefined, deps);
			assert.deepEqual(calls.detached, [], "nothing detached");
			assert.equal(result.refresh, null);
			assert.ok(calls.sync.some((c) => c.endsWith("--index my-wiki status")), "the ABI probe still runs");
			assert.equal(result.notes.length, 1, "the version note still shows");
		}
	});

	test("off: an ABI mismatch is still rebuilt, and its note still shows", () => {
		const mismatch = { status: 1, stderr: "NODE_MODULE_VERSION 115" };
		const { deps, calls } = fakeDeps({ env: { [REFRESH_SWITCH]: "off" }, status: mismatch, rebuild: 0 });
		const result = qmdSessionStart(VAULT, MANIFEST, undefined, deps);
		assert.ok(calls.sync.some((c) => c.includes("npm rebuild better-sqlite3")));
		assert.deepEqual(result.notes.map((n) => n.header), ["### QMD Self-Heal"]);
		assert.deepEqual(calls.detached, []);
	});

	test("only the exact value off turns the refresh off", () => {
		for (const value of ["Off", "OFF", "0", "", "false", undefined]) {
			const env = value === undefined ? {} : { [REFRESH_SWITCH]: value };
			const { deps, calls } = fakeDeps({ env });
			assert.equal(qmdSessionStart(VAULT, MANIFEST, undefined, deps).refresh, "update", String(value));
			assert.equal(calls.detached.length, 1, String(value));
		}
	});

	test("VAULT_QMD=off turns everything off, whatever VAULT_QMD_REFRESH says: no probe, no note, no spawn", () => {
		for (const refresh of ["on", "off"]) {
			const { deps, calls } = fakeDeps({ env: { [QMD_SWITCH]: "off", [REFRESH_SWITCH]: refresh }, version: "qmd 1.0.0\n" });
			assert.deepEqual(qmdSessionStart(VAULT, MANIFEST, undefined, deps), { notes: [], refresh: null }, refresh);
			assert.deepEqual(calls, { sync: [], detached: [] }, refresh);
		}
	});
});
