/**
 * The qmd extension (#70, #95): QMD's session-start notes as load-bearing,
 * priority-0 sections, and its index refresh as effects, through the
 * registry like any other extension. No test here runs a real QMD: both are
 * built over injected deps.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { EffectTrigger, HookContext } from "../../core/index.ts";
import { QMD_DECLARATION } from "../../core/context.ts";
import { collectSections, fromLoaded, loadRegistry, runEffects } from "../../core/registry.ts";
import { SELF_HEAL_HEADER, VERSION_HEADER, WORKER_PATH, extension, qmdExtension, sentinelPathFor } from "./index.ts";
import { QMD_SWITCH, REFRESH_SWITCH } from "./lib/switches.ts";
import { realDeps, type QmdDeps } from "./session.ts";
import { VAULT, fakeDeps, rmTemp, waitFor, type Calls } from "./test-fakes.ts";

const counts = (calls: Calls) => ({ sync: calls.sync.length, detached: calls.detached.length });

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = Object.freeze({ template: "wiki-mind", qmd_index: "", qmd_min_version: "2.0.0" });
const MISMATCH = { status: 1, stderr: "Error: ... NODE_MODULE_VERSION 115" };

const declaration = { id: "qmd", module: "scripts/extensions/qmd/index.ts", events: ["session-start", "write", "pre-compact", "stop"] as const };
const ctx = (): HookContext => ({ vaultRoot: VAULT, manifest: MANIFEST, now: 0 });
const sections = async (deps: QmdDeps, mode: "full" | "pointer" = "full") => {
	const { result, failures } = await collectSections(fromLoaded([{ declaration, extension: qmdExtension(deps) }]), ctx(), mode);
	assert.deepEqual(failures, []);
	return result;
};

describe("the qmd extension", () => {
	test("the module loads through the registry from QMD_DECLARATION's shape, with two priority-0 load-bearing sections", async () => {
		const core = join(HERE, "..", "..", "..");
		const decl = { ...JSON.parse(QMD_DECLARATION), module: relative(core, join(HERE, "index.ts")).replaceAll("\\", "/") };
		const registry = await loadRegistry(core, Object.freeze({ extensions: [decl] }), "session-start", {});
		assert.deepEqual(registry.failures, []);
		assert.equal(registry.loaded[0]?.extension, extension);
		assert.deepEqual(
			extension.sections?.map((s) => [s.id, s.header, s.priority, s.pointer]),
			[["qmd-self-heal", SELF_HEAL_HEADER, 0, undefined], ["qmd-version", VERSION_HEADER, 0, undefined]],
		);
		assert.equal(JSON.parse(QMD_DECLARATION).module, ".claude/scripts/extensions/qmd/index.ts", "the vault path the core vendors it to");
	});

	test("a healthy QMD at or above the floor: no sections, and a section starts no refresh (#95)", async () => {
		const { deps, calls } = fakeDeps({});
		assert.deepEqual(await sections(deps), []);
		assert.equal(calls.detached.length, 0, "the session-start refresh is an effect now");
	});

	test("no QMD installed: no sections, no probe", async () => {
		const { deps, calls } = fakeDeps({ entry: null });
		assert.deepEqual(await sections(deps), []);
		assert.deepEqual(counts(calls), { sync: 0, detached: 0 });
	});

	test("a self-heal note and a version note each land in their own section, priority 0, in id order", async () => {
		const { deps } = fakeDeps({ status: MISMATCH, version: "qmd 1.0.0\n" });
		const result = await sections(deps);
		assert.deepEqual(result.map((s) => [s.header, s.priority]), [[SELF_HEAL_HEADER, 0], [VERSION_HEADER, 0]]);
		assert.match(result[0]?.body ?? "", /was rebuilt this session/);
		assert.match(result[1]?.body ?? "", /below this vault's minimum \(2\.0\.0\)/);
	});

	test("one probe run serves both sections: QMD's work runs once per hook", async () => {
		const { deps, calls } = fakeDeps({ status: MISMATCH, version: "qmd 1.0.0\n" });
		await sections(deps);
		assert.deepEqual(counts(calls), { sync: 3, detached: 0 }, "status, rebuild and version once each, and no refresh");
	});

	test("load-bearing: on a resume or compact re-entry the notes still render in full", async () => {
		const { deps } = fakeDeps({ version: "qmd 1.0.0\n" });
		assert.deepEqual((await sections(deps, "pointer")).map((s) => s.header), [VERSION_HEADER]);
	});

	test(`${QMD_SWITCH}=off: no sections, nothing run`, async () => {
		const { deps, calls } = fakeDeps({ env: { [QMD_SWITCH]: "off" }, status: MISMATCH, version: "qmd 1.0.0\n" });
		assert.deepEqual(await sections(deps), []);
		assert.deepEqual(counts(calls), { sync: 0, detached: 0 });
	});

	test("VAULT_EXTENSIONS=off turns it off too: QMD's work is no longer core (rule 6)", async () => {
		const registry = await loadRegistry(join(HERE, "..", "..", ".."), Object.freeze({ extensions: [declaration] }), "session-start", { VAULT_EXTENSIONS: "off" });
		assert.equal(registry.loaded.length, 0);
	});

	test("a throw in QMD's work is reported as the section's failure, and doesn't run twice", async () => {
		let runs = 0;
		const { deps } = fakeDeps({});
		const throwing: QmdDeps = { ...deps, resolveEntry: () => { runs++; throw new Error("boom"); } };
		const { result, failures } = await collectSections(fromLoaded([{ declaration, extension: qmdExtension(throwing) }]), ctx(), "full");
		assert.deepEqual(result, []);
		assert.deepEqual(failures.map((f) => [f.extension, f.point, f.item, f.message]), [["qmd", "section", "qmd-self-heal", "boom"], ["qmd", "section", "qmd-version", "boom"]]);
		assert.equal(runs, 1);
	});
});

describe("the qmd extension's effects (#95)", () => {
	/** A vault-shaped temp folder for the sentinel, and the effects over fake deps with spawns recorded. */
	function setup(opts: Parameters<typeof fakeDeps>[0] = {}) {
		const dir = mkdtempSync(join(tmpdir(), "qmd-effects-"));
		const sentinel = join(dir, ".qmd-refresh-sentinel");
		const fake = fakeDeps({ ...opts, env: { QMD_REFRESH_SENTINEL: sentinel, ...opts.env } });
		const workers: { path: string; args: readonly string[] }[] = [];
		const ext = qmdExtension(fake.deps, { spawnWorker: (path, args) => void workers.push({ path, args }) });
		const registry = fromLoaded([{ declaration, extension: ext }]);
		const run = async (trigger: EffectTrigger) => {
			const { failures } = await runEffects(registry, trigger, { vaultRoot: dir, manifest: MANIFEST, now: 0 });
			assert.deepEqual(failures, []);
		};
		return { dir, sentinel, calls: fake.calls, workers, run, done: () => rmTemp(dir) };
	}
	const write = (relPath: string): EffectTrigger => ({ event: "write", target: { relPath, content: "x" } });

	test("the extension's effects: the session-start refresh, and the debounced refresh on write, pre-compact and stop", () => {
		assert.deepEqual(extension.effects?.map((e) => [e.id, e.on]), [
			["qmd-session-refresh", ["session-start"]],
			["qmd-refresh", ["write", "pre-compact", "stop"]],
		]);
		assert.deepEqual(JSON.parse(QMD_DECLARATION).events, ["session-start", "write", "pre-compact", "stop"], "the declaration lists every event they run on");
	});

	test("session start: a background update on a populated store", async () => {
		const s = setup();
		try {
			await s.run({ event: "session-start" });
			assert.equal(s.calls.detached.length, 1);
			assert.deepEqual(s.calls.detached[0]?.args.slice(-1), ["update"]);
			assert.deepEqual(s.workers, [], "no debounced worker at session start");
		} finally {
			s.done();
		}
	});

	test("session start's refresh starts only after the self-heal's rebuild, whatever the entry point runs first (#95)", async () => {
		const order: string[] = [];
		const fake = fakeDeps({ status: MISMATCH, rebuild: 0 });
		const deps: QmdDeps = {
			...fake.deps,
			spawnSync: (cmd, args, o) => (order.push([cmd, ...args].join(" ").includes("npm rebuild") ? "rebuild" : "probe"), fake.deps.spawnSync(cmd, args, o)),
			spawnDetached: (cmd, args, o) => (order.push("refresh"), fake.deps.spawnDetached(cmd, args, o)),
		};
		const registry = fromLoaded([{ declaration, extension: qmdExtension(deps) }]);
		await runEffects(registry, { event: "session-start" }, ctx());
		assert.ok(order.lastIndexOf("rebuild") >= 0 && order.lastIndexOf("rebuild") < order.lastIndexOf("refresh"), `the rebuild finishes before the update starts: ${order.join(", ")}`);
		const one = ctx();
		await runEffects(registry, { event: "session-start" }, one);
		const before = order.length;
		await collectSections(registry, one, "full");
		assert.equal(order.length, before, "the sections then read the run the effect made");
	});

	test("a missing worker is a reported failure, and nothing is stamped (#95)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "qmd-noworker-"));
		try {
			const sentinel = join(dir, ".qmd-refresh-sentinel");
			const { deps } = fakeDeps({ env: { QMD_REFRESH_SENTINEL: sentinel } });
			const registry = fromLoaded([{ declaration, extension: qmdExtension(deps, { workerPath: join(dir, "gone.ts") }) }]);
			const { failures } = await runEffects(registry, { event: "stop" }, { vaultRoot: dir, manifest: MANIFEST, now: 0 });
			assert.equal(failures.length, 1);
			assert.match(failures[0]?.message ?? "", /refresh worker is missing/);
			assert.equal(existsSync(sentinel), false);
		} finally {
			rmTemp(dir);
		}
	});

	test("an empty QMD_REFRESH_SENTINEL is unset: an empty path would turn the debounce off (#95)", () => {
		const fallback = join("/v", ".claude", "scripts", ".qmd-refresh-sentinel");
		assert.equal(sentinelPathFor("/v", { QMD_REFRESH_SENTINEL: "" }), fallback);
		assert.equal(sentinelPathFor("/v", {}), fallback);
		assert.equal(sentinelPathFor("/v", { QMD_REFRESH_SENTINEL: "/t/s" }), "/t/s");
	});

	test("a missing worker is reported only where a worker would spawn: not without QMD, not with the refresh off, not inside a covered window (#95)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "qmd-noworker-quiet-"));
		try {
			const sentinel = join(dir, ".qmd-refresh-sentinel");
			const quiet = async (opts: Parameters<typeof fakeDeps>[0]) => {
				const { deps } = fakeDeps({ ...opts, env: { QMD_REFRESH_SENTINEL: sentinel, ...opts.env } });
				const registry = fromLoaded([{ declaration, extension: qmdExtension(deps, { workerPath: join(dir, "gone.ts") }) }]);
				return (await runEffects(registry, { event: "stop" }, { vaultRoot: dir, manifest: MANIFEST, now: 0 })).failures;
			};
			assert.deepEqual(await quiet({ entry: null }), [], "no QMD installed");
			assert.deepEqual(await quiet({ env: { [REFRESH_SWITCH]: "off" } }), [], "the refresh off");
			// Inside a window whose trailing flush is already owed: the trigger skips before any spawn.
			writeFileSync(sentinel, "");
			const t = (Date.now() - 10_000) / 1000;
			utimesSync(sentinel, t, t);
			writeFileSync(`${sentinel}.pending`, "");
			assert.deepEqual(await quiet({}), [], "a covered window");
		} finally {
			rmTemp(dir);
		}
	});

	test("session start's effect probes nothing with the refresh off, and a probe that throws is reported, with no update started (#95)", async () => {
		const off = fakeDeps({ env: { [REFRESH_SWITCH]: "off" }, version: "qmd 1.0.0\n" });
		await runEffects(fromLoaded([{ declaration, extension: qmdExtension(off.deps) }]), { event: "session-start" }, ctx());
		assert.deepEqual(counts(off.calls), { sync: 0, detached: 0 });
		const { deps, calls } = fakeDeps({});
		const throwing: QmdDeps = { ...deps, spawnSync: () => { throw new Error("probe broke"); } };
		const { failures } = await runEffects(fromLoaded([{ declaration, extension: qmdExtension(throwing) }]), { event: "session-start" }, ctx());
		assert.deepEqual(failures.map((f) => [f.item, f.message]), [["qmd-session-refresh", "probe broke"]]);
		assert.equal(calls.detached.length, 0);
	});

	test(`session start with ${REFRESH_SWITCH}=off: nothing detached`, async () => {
		const s = setup({ env: { [REFRESH_SWITCH]: "off" } });
		try {
			await s.run({ event: "session-start" });
			assert.equal(s.calls.detached.length, 0);
		} finally {
			s.done();
		}
	});

	test("a note written: one worker, told its vault and its index as session start resolves them", async () => {
		const s = setup();
		try {
			await s.run(write("notes/a.md"));
			assert.equal(s.workers.length, 1);
			assert.ok(s.workers[0]?.path.endsWith(join("extensions", "qmd", "qmd-refresh-run.ts")), s.workers[0]?.path);
			const derived = basename(s.dir).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
			assert.deepEqual(s.workers[0]?.args, [`--vault=${s.dir}`, `--index=${derived}`]);
		} finally {
			s.done();
		}
	});

	test("one sentinel serves write, pre-compact and stop: a burst spawns one leading worker and one trailing flush", async () => {
		const s = setup();
		try {
			await s.run(write("notes/a.md"));
			const t = (Date.now() - 10_000) / 1000;
			utimesSync(s.sentinel, t, t);
			await s.run({ event: "pre-compact" });
			await s.run({ event: "stop" });
			assert.equal(s.workers.length, 2, "the leading worker, then one trailing flush for the window");
			assert.ok(s.workers[1]?.args.some((a) => a.startsWith("--trailing=")));
		} finally {
			s.done();
		}
	});

	test("a write that isn't vault markdown refreshes nothing", async () => {
		const s = setup();
		try {
			for (const p of ["notes/a.txt", ".git/HEAD.md", ".obsidian/workspace.md", "x/node_modules/p/README.md", "notes\\b.json"]) await s.run(write(p));
			assert.deepEqual(s.workers, []);
		} finally {
			s.done();
		}
	});

	test("a Windows-style path to a note refreshes", async () => {
		const s = setup();
		try {
			await s.run(write("notes\\sub dir\\a.md"));
			assert.equal(s.workers.length, 1);
		} finally {
			s.done();
		}
	});

	test(`${QMD_SWITCH}=off: no effect does anything`, async () => {
		const s = setup({ env: { [QMD_SWITCH]: "off" } });
		try {
			for (const trigger of [{ event: "session-start" }, write("notes/a.md"), { event: "pre-compact" }, { event: "stop" }] as const) await s.run(trigger);
			assert.deepEqual(s.workers, []);
			assert.deepEqual(counts(s.calls), { sync: 0, detached: 0 });
			assert.equal(existsSync(s.sentinel), false, "not even a sentinel stamp");
		} finally {
			s.done();
		}
	});

	test("no QMD installed: no worker", async () => {
		const s = setup({ entry: null });
		try {
			await s.run(write("notes/a.md"));
			assert.deepEqual(s.workers, []);
		} finally {
			s.done();
		}
	});
});

test("one hook's sections and session-start effect resolve QMD once between them (#95)", async () => {
	let resolved = 0;
	const { deps } = fakeDeps({ version: "qmd 1.0.0\n" });
	const counting: QmdDeps = { ...deps, resolveEntry: () => (resolved++, deps.resolveEntry()) };
	const registry = fromLoaded([{ declaration, extension: qmdExtension(counting) }]);
	const one = ctx();
	await collectSections(registry, one, "full");
	await runEffects(registry, { event: "session-start" }, one);
	assert.equal(resolved, 1);
});

describe("no detached worker outlives the extension's effects under VAULT_QMD_REFRESH=off (#70's guard, #95)", () => {
	// Real spawns, observed through fakes that write a marker when they run: the
	// debounced worker, and a stand-in for qmd's entry that session start's
	// update runs. No spawn seam, so the switch is what decides.
	function fixture(env: Record<string, string>) {
		const dir = mkdtempSync(join(tmpdir(), "qmd-guard-"));
		const marker = (name: string) => join(dir, `${name}-ran`);
		// Each marks only the refresh it stands for: the worker on any run, the qmd stand-in on an
		// `update` (session start's synchronous probes run it too, and leave nothing behind).
		const writer = (name: string, only = "") => {
			const path = join(dir, `${name}.mjs`);
			const when = only === "" ? "true" : `process.argv.includes(${JSON.stringify(only)})`;
			writeFileSync(path, `import { writeFileSync } from "node:fs";\nif (${when}) writeFileSync(${JSON.stringify(marker(name))}, "");\n`);
			return path;
		};
		const qmdEntry = writer("qmd", "update");
		const workerPath = writer("worker");
		const deps: QmdDeps = {
			...realDeps,
			env: { QMD_REFRESH_SENTINEL: join(dir, ".qmd-refresh-sentinel"), ...env },
			resolveEntry: () => qmdEntry,
			storeSize: () => Number.MAX_SAFE_INTEGER,
		};
		const registry = fromLoaded([{ declaration, extension: qmdExtension(deps, { workerPath }) }]);
		const fire = async () => {
			const ctx: HookContext = { vaultRoot: dir, manifest: MANIFEST, now: 0 };
			for (const trigger of [{ event: "session-start" }, { event: "write", target: { relPath: "a.md", content: "" } }] as const) {
				assert.deepEqual((await runEffects(registry, trigger, ctx)).failures, []);
			}
		};
		return { dir, ran: () => ["qmd", "worker"].filter((n) => existsSync(marker(n))), fire };
	}
	let spawnMs = 0;

	test("control: with the switch unset, both spawns run, so the observation works", async () => {
		const f = fixture({});
		try {
			const start = Date.now();
			await f.fire();
			await waitFor(() => f.ran().length === 2, 10_000);
			assert.deepEqual(f.ran(), ["qmd", "worker"]);
			spawnMs = Date.now() - start;
		} finally {
			rmTemp(f.dir);
		}
	});

	test("off: session start's update and the debounced worker spawn nothing", async () => {
		const f = fixture({ [REFRESH_SWITCH]: "off" });
		try {
			await f.fire();
			await waitFor(() => f.ran().length > 0, spawnMs === 0 ? 10_000 : Math.max(2_000, 3 * spawnMs));
			assert.deepEqual(f.ran(), [], "a worker ran with VAULT_QMD_REFRESH=off");
		} finally {
			rmTemp(f.dir);
		}
	});
});

describe("the shipped worker (#125)", () => {
	test("the file WORKER_PATH names ships with the extension", () => {
		assert.ok(existsSync(WORKER_PATH), WORKER_PATH);
	});
});
