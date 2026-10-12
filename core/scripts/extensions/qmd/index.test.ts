/**
 * The qmd extension (#70): QMD's session-start notes as load-bearing,
 * priority-0 sections, through the registry like any other extension. No
 * test here runs a real QMD: the sections are built over injected deps.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSections, fromLoaded, loadRegistry } from "../../core/registry.ts";
import type { HookContext } from "../../core/index.ts";
import { QMD_DECLARATION } from "../../core/context.ts";
import { SELF_HEAL_HEADER, VERSION_HEADER, extension, qmdExtension } from "./index.ts";
import { EMPTY_STORE_BYTES, QMD_SWITCH, type QmdDeps } from "./session.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const VAULT = join("/", "vaults", "My Wiki");
const MANIFEST = Object.freeze({ template: "wiki-mind", qmd_index: "", qmd_min_version: "2.0.0" });
const MISMATCH = { status: 1, stderr: "Error: ... NODE_MODULE_VERSION 115" };

function fakeDeps(opts: { entry?: string | null; status?: { status: number; stderr: string }; version?: string; env?: Record<string, string> }) {
	const calls = { sync: 0, detached: 0 };
	const deps: QmdDeps = {
		env: opts.env ?? {},
		resolveEntry: () => (opts.entry === undefined ? join("/", "npm", "@tobilu", "qmd", "dist", "cli", "qmd.js") : opts.entry),
		spawnSync: (cmd, args) => {
			calls.sync++;
			const line = [cmd, ...args].join(" ");
			if (line.includes("npm rebuild")) return { status: 0 };
			if (line.includes("--version")) return { status: 0, stdout: opts.version ?? "qmd 2.1.0\n" };
			return opts.status ?? { status: 0, stderr: "" };
		},
		spawnDetached: () => void calls.detached++,
		storeSize: () => EMPTY_STORE_BYTES * 10,
		home: join("/", "home", "u"),
	};
	return { deps, calls };
}

const declaration = { id: "qmd", module: "scripts/extensions/qmd/index.ts", events: ["session-start" as const] };
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
		assert.match(QMD_DECLARATION, /"module": "\.claude\/scripts\/extensions\/qmd\/index\.ts"/, "the vault path the core vendors it to");
	});

	test("a healthy QMD at or above the floor: no sections, one background refresh", async () => {
		const { deps, calls } = fakeDeps({});
		assert.deepEqual(await sections(deps), []);
		assert.equal(calls.detached, 1);
	});

	test("no QMD installed: no sections, no probe", async () => {
		const { deps, calls } = fakeDeps({ entry: null });
		assert.deepEqual(await sections(deps), []);
		assert.deepEqual(calls, { sync: 0, detached: 0 });
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
		assert.deepEqual(calls, { sync: 3, detached: 1 }, "status, rebuild and version once each, one refresh");
	});

	test("load-bearing: on a resume or compact re-entry the notes still render in full", async () => {
		const { deps } = fakeDeps({ version: "qmd 1.0.0\n" });
		assert.deepEqual((await sections(deps, "pointer")).map((s) => s.header), [VERSION_HEADER]);
	});

	test(`${QMD_SWITCH}=off: no sections, nothing run`, async () => {
		const { deps, calls } = fakeDeps({ env: { [QMD_SWITCH]: "off" }, status: MISMATCH, version: "qmd 1.0.0\n" });
		assert.deepEqual(await sections(deps), []);
		assert.deepEqual(calls, { sync: 0, detached: 0 });
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
