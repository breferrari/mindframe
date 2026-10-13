/**
 * QMD's session-start work (session.ts, the core's qmd-session.ts until
 * #70), over injected side effects: no test here runs a real QMD or touches
 * the user's QMD store.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { manifestOf } from "../../lib/manifest.ts";
import { BOOTSTRAP_FILES, BOOTSTRAP_PATH, EMPTY_STORE_BYTES, qmdNotesOf, qmdSessionRefreshOf, type QmdDeps } from "./session.ts";
import { QMD_SWITCH, REFRESH_SWITCH } from "./lib/switches.ts";
import { VAULT, fakeDeps } from "./test-fakes.ts";

/** The manifest's text, parsed the way openVault parses it, then all of session start's work: the notes, then the refresh. */
const qmdSessionStart = (vaultRoot: string, json: string | null, deps: QmdDeps) => ({
	notes: qmdNotesOf(vaultRoot, manifestOf(json), deps),
	refresh: qmdSessionRefreshOf(vaultRoot, manifestOf(json), deps),
});

const MANIFEST = JSON.stringify({ template: "wiki-mind", qmd_index: "", qmd_min_version: "2.0.0" });

describe("QMD's session-start work", () => {
	test("QMD absent: no probe, no spawn, no note", () => {
		const { deps, calls } = fakeDeps({ entry: null });
		const result = qmdSessionStart(VAULT, MANIFEST, deps);
		assert.deepEqual(result, { notes: [], refresh: null });
		assert.deepEqual(calls, { sync: [], detached: [] });
	});

	test(`${QMD_SWITCH}=off: nothing at all, even with QMD installed`, () => {
		const { deps, calls } = fakeDeps({ env: { [QMD_SWITCH]: "off" } });
		assert.deepEqual(qmdSessionStart(VAULT, MANIFEST, deps), { notes: [], refresh: null });
		assert.deepEqual(calls, { sync: [], detached: [] });
	});

	test("a healthy, populated store: a background update on this vault's derived index, from the temp folder", () => {
		const { deps, calls } = fakeDeps({});
		const result = qmdSessionStart(VAULT, MANIFEST, deps);
		assert.deepEqual(result.notes, []);
		assert.equal(result.refresh, "update");
		assert.equal(calls.detached.length, 1);
		const args = calls.detached[0]?.args ?? [];
		assert.deepEqual(args.slice(-3), ["--index", "my-wiki", "update"]);
		assert.notEqual(calls.detached[0]?.cwd, VAULT, "never holds the vault folder open");
	});

	test("the bootstrap ships with the extension, under obsidian-mind's name (#96)", () => {
		assert.ok(existsSync(BOOTSTRAP_PATH), BOOTSTRAP_PATH);
		assert.equal(basename(BOOTSTRAP_PATH), "qmd-bootstrap.ts");
	});

	test("a bootstrap, or a library it imports, that isn't there is reported, not spawned to die silently (#96)", () => {
		for (const gone of BOOTSTRAP_FILES) {
			const { deps, calls } = fakeDeps({ storeBytes: null, exists: (f) => f !== gone });
			assert.throws(() => qmdSessionRefreshOf(VAULT, manifestOf(MANIFEST), deps), (e: Error) => e.message.includes("qmd bootstrap is missing") && e.message.includes(gone), gone);
			assert.equal(calls.detached.length, 0, "nothing spawned");
		}
		assert.equal(BOOTSTRAP_FILES.length, 5, "the script and its four libraries");
		for (const f of BOOTSTRAP_FILES) assert.ok(existsSync(f), `${f} ships with the extension`);
	});

	test("a missing or near-empty store: the idempotent bootstrap, run from the vault", () => {
		for (const storeBytes of [null, 98_304]) {
			const { deps, calls } = fakeDeps({ storeBytes });
			assert.equal(qmdSessionStart(VAULT, MANIFEST, deps).refresh, "bootstrap");
			assert.equal(calls.detached[0]?.cwd, VAULT);
			assert.ok(calls.detached[0]?.args.includes(BOOTSTRAP_PATH), "the extension's own bootstrap (#96)");
		}
	});

	test("an ABI mismatch is rebuilt, and the note says whether the rebuild worked", () => {
		const mismatch = { status: 1, stderr: "Error: ... was compiled against a different Node.js version using NODE_MODULE_VERSION 115" };
		const ok = fakeDeps({ status: mismatch, rebuild: 0 });
		const fixed = qmdSessionStart(VAULT, MANIFEST, ok.deps);
		assert.ok(ok.calls.sync.some((c) => c.includes("npm rebuild better-sqlite3")));
		assert.deepEqual(fixed.notes.map((n) => n.header), ["### QMD Self-Heal"]);
		assert.match(fixed.notes[0]?.body ?? "", /was rebuilt this session/);
		const failed = qmdSessionStart(VAULT, MANIFEST, fakeDeps({ status: mismatch, rebuild: 1 }).deps);
		assert.match(failed.notes[0]?.body ?? "", /automatic `npm rebuild better-sqlite3` failed/);
	});

	test("a healthy probe never rebuilds", () => {
		const { deps, calls } = fakeDeps({ status: { status: 0, stderr: "" } });
		qmdSessionStart(VAULT, MANIFEST, deps);
		assert.ok(!calls.sync.some((c) => c.includes("npm rebuild")));
	});

	test("a version below qmd_min_version adds a warning note; at or above it, none", () => {
		const old = qmdSessionStart(VAULT, MANIFEST, fakeDeps({ version: "qmd 1.9.0\n" }).deps);
		assert.deepEqual(old.notes.map((n) => n.header), ["### QMD Version"]);
		assert.match(old.notes[0]?.body ?? "", /below this vault's minimum \(2\.0\.0\)/);
		assert.deepEqual(qmdSessionStart(VAULT, MANIFEST, fakeDeps({ version: "qmd 2.0.0\n" }).deps).notes, []);
		const noFloor = fakeDeps({ version: "qmd 0.1.0\n" });
		assert.deepEqual(qmdSessionStart(VAULT, JSON.stringify({ template: "wiki-mind" }), noFloor.deps).notes, []);
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
			const result = qmdSessionStart(VAULT, MANIFEST, deps);
			assert.deepEqual(calls.detached, [], "nothing detached");
			assert.equal(result.refresh, null);
			assert.ok(calls.sync.some((c) => c.endsWith("--index my-wiki status")), "the ABI probe still runs");
			assert.equal(result.notes.length, 1, "the version note still shows");
		}
	});

	test("off: an ABI mismatch is still rebuilt, and its note still shows", () => {
		const mismatch = { status: 1, stderr: "NODE_MODULE_VERSION 115" };
		const { deps, calls } = fakeDeps({ env: { [REFRESH_SWITCH]: "off" }, status: mismatch, rebuild: 0 });
		const result = qmdSessionStart(VAULT, MANIFEST, deps);
		assert.ok(calls.sync.some((c) => c.includes("npm rebuild better-sqlite3")));
		assert.deepEqual(result.notes.map((n) => n.header), ["### QMD Self-Heal"]);
		assert.deepEqual(calls.detached, []);
	});

	test("only the exact value off turns the refresh off", () => {
		for (const value of ["Off", "OFF", "0", "", "false", undefined]) {
			const env = value === undefined ? {} : { [REFRESH_SWITCH]: value };
			const { deps, calls } = fakeDeps({ env });
			assert.equal(qmdSessionStart(VAULT, MANIFEST, deps).refresh, "update", String(value));
			assert.equal(calls.detached.length, 1, String(value));
		}
	});

	test("VAULT_QMD=off turns everything off, whatever VAULT_QMD_REFRESH says: no probe, no note, no spawn", () => {
		for (const refresh of ["on", "off"]) {
			const { deps, calls } = fakeDeps({ env: { [QMD_SWITCH]: "off", [REFRESH_SWITCH]: refresh }, version: "qmd 1.0.0\n" });
			assert.deepEqual(qmdSessionStart(VAULT, MANIFEST, deps), { notes: [], refresh: null }, refresh);
			assert.deepEqual(calls, { sync: [], detached: [] }, refresh);
		}
	});
});
