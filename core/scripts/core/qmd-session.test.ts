/**
 * QMD's session-start work (core/qmd-session.ts, SPEC.md §7.2 seam S5), over
 * injected side effects: no test here runs a real QMD or touches the user's
 * QMD store.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { EMPTY_STORE_BYTES, QMD_SWITCH, qmdSessionStart, type QmdDeps } from "./qmd-session.ts";

const MANIFEST = JSON.stringify({ template: "wiki-mind", qmd_index: "", qmd_min_version: "2.0.0" });
const VAULT = join("/", "vaults", "My Wiki");

type Calls = { sync: string[]; detached: { cmd: string; args: readonly string[]; cwd: string }[] };

function fakeDeps(opts: {
	entry?: string | null;
	status?: { status: number; stderr: string };
	version?: string;
	rebuild?: number;
	storeBytes?: number | null;
	env?: Record<string, string>;
}): { deps: QmdDeps; calls: Calls } {
	const calls: Calls = { sync: [], detached: [] };
	const deps: QmdDeps = {
		env: opts.env ?? {},
		resolveEntry: () => (opts.entry === undefined ? join("/", "npm", "@tobilu", "qmd", "dist", "cli", "qmd.js") : opts.entry),
		spawnSync: (cmd, args) => {
			const line = [cmd, ...args].join(" ");
			calls.sync.push(line);
			if (line.includes("npm rebuild")) return { status: opts.rebuild ?? 0 };
			if (line.includes("--version")) return { status: 0, stdout: opts.version ?? "qmd 2.1.0\n" };
			return opts.status ?? { status: 0, stderr: "" };
		},
		spawnDetached: (cmd, args, o) => void calls.detached.push({ cmd, args, cwd: o.cwd }),
		storeSize: () => (opts.storeBytes === undefined ? EMPTY_STORE_BYTES * 10 : opts.storeBytes),
		home: join("/", "home", "u"),
	};
	return { deps, calls };
}

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
