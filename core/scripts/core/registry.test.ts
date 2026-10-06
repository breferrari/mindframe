/**
 * The registry's contract (registry.ts, SPEC.md §7.4), one rule at a time:
 * declaration, event gating, order, the budget, isolation of a throw and of
 * a timeout, disable by id, and the kill switch.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyInjectionBudget } from "../lib/session-start.ts";
import {
	KILL_SWITCH,
	collectChecklist,
	collectSections,
	formatFailures,
	fromLoaded,
	loadRegistry,
	matchSignals,
	parseDeclarations,
	runDetectors,
	runValidators,
	undispatched,
} from "./registry.ts";
import type { Declaration, Extension, HookContext, HookEvent, Section } from "./types.ts";

const ALL: readonly HookEvent[] = ["session-start", "stop", "prompt", "write"];
const ctx: HookContext = { vaultRoot: "/vault", manifest: null, now: 0 };

function declared(extension: Extension, extra: Partial<Declaration> = {}) {
	const declaration: Declaration = { id: extension.id, module: `.claude/extensions/${extension.id}.ts`, events: ALL, ...extra };
	return { declaration, extension };
}

function section(id: string, priority: number | undefined, body: string, pointer?: string): Section {
	return {
		id,
		...(priority === undefined ? {} : { priority }),
		header: `### ${id}`,
		render: () => body,
		...(pointer === undefined ? {} : { pointer }),
	};
}

describe("rule 3: declarations are validated before anything runs", () => {
	test("a well-formed declaration is kept", () => {
		const { result, failures } = parseDeclarations({
			extensions: [{ id: "wiki", module: ".claude/extensions/wiki/index.ts", events: ["stop"], priority: 5, enabled: true, disable: ["x"], timeoutMs: 500 }],
		});
		assert.equal(failures.length, 0);
		assert.deepEqual(result.map((d) => d.id), ["wiki"]);
	});

	test("each malformed declaration is a load failure, and the rest still load", () => {
		const { result, failures } = parseDeclarations({
			extensions: [
				{ id: "abs", module: "/etc/x.ts", events: ["stop"] },
				{ id: "drive", module: "C:/x.ts", events: ["stop"] },
				{ id: "climb", module: "../x.ts", events: ["stop"] },
				{ id: "back", module: ".claude\\x.ts", events: ["stop"] },
				{ id: "event", module: "x.ts", events: ["nope"] },
				{ id: "none", module: "x.ts", events: [] },
				{ id: "prio", module: "x.ts", events: ["stop"], priority: "high" },
				{ id: "time", module: "x.ts", events: ["stop"], timeoutMs: 0 },
				{ module: "x.ts", events: ["stop"] },
				{ id: "ok", module: "x.ts", events: ["stop"] },
				{ id: "ok", module: "y.ts", events: ["stop"] },
			],
		});
		assert.deepEqual(result.map((d) => d.id), ["ok"]);
		assert.equal(failures.length, 10);
		assert.ok(failures.every((f) => f.point === "load"));
	});

	test("a missing key declares nothing; a key that is not a list is a failure", () => {
		assert.deepEqual(parseDeclarations(null), { result: [], failures: [] });
		assert.equal(parseDeclarations({ extensions: {} }).failures.length, 1);
	});
});

describe("rule 3: an extension runs only for the events it declares", () => {
	test("sections of an extension declared for stop only do not render at session start", async () => {
		const ext: Extension = { id: "a", sections: [section("a.s", 1, "body")], checklist: [{ id: "a.c", full: "F", short: "S" }] };
		const registry = fromLoaded([declared(ext, { events: ["stop"] })]);
		assert.equal((await collectSections(registry, ctx, "full")).result.length, 0);
		assert.equal(collectChecklist(registry).result.length, 1);
	});
});

describe("rule 4: order is priority, unset last, ties by id", () => {
	test("lower priority first; unset falls back to the declaration, then last; ties by item id, then extension id", async () => {
		const a: Extension = { id: "a", sections: [section("z", 5, "a5"), section("m", undefined, "a-unset"), section("b", 1, "a1")] };
		const b: Extension = { id: "b", sections: [section("k", 5, "b5"), section("c", undefined, "b-decl")] };
		const c: Extension = { id: "c", sections: [section("q", undefined, "c-unset")] };
		const registry = fromLoaded([declared(a), declared(b, { priority: 3 }), declared(c)]);
		const { result } = await collectSections(registry, ctx, "full");
		assert.deepEqual(result.map((s) => s.body), ["a1", "b-decl", "b5", "a5", "a-unset", "c-unset"]);
	});

	test("the order does not depend on declaration order", async () => {
		const x: Extension = { id: "x", sections: [section("same", 1, "x")] };
		const y: Extension = { id: "y", sections: [section("same", 1, "y")] };
		const one = await collectSections(fromLoaded([declared(x), declared(y)]), ctx, "full");
		const two = await collectSections(fromLoaded([declared(y), declared(x)]), ctx, "full");
		assert.deepEqual(one.result.map((s) => s.body), ["x", "y"]);
		assert.deepEqual(two.result.map((s) => s.body), ["x", "y"]);
	});
});

describe("rule 6: the core owns the budget", () => {
	test("over budget, the highest priority number is given up first, and a section with no pointer never is", async () => {
		const big = "x".repeat(400);
		const ext: Extension = {
			id: "a",
			sections: [section("keep", 1, big), section("first-out", 30, big, "(ptr 30)"), section("second-out", 20, big, "(ptr 20)"), section("unset", undefined, big, "(ptr unset)")],
		};
		const { result } = await collectSections(fromLoaded([declared(ext)]), ctx, "full");
		// Just over two sections' worth: the two lowest priorities go, and no more.
		const some = applyInjectionBudget(result, 900);
		assert.deepEqual(some.collapsed, ["unset", "first-out"]);
		// Room for one section: every section with a pointer goes, the load-bearing one stays whole.
		const all = applyInjectionBudget(result, 500);
		assert.deepEqual(all.collapsed, ["unset", "first-out", "second-out"]);
		assert.ok(all.text.includes(big), "the load-bearing section stays whole");
	});

	test("an oversized section collapses alone, and the sections that fit stay, whatever their priority (#53)", async () => {
		// The worst priorities go first, but a section that would fit is restored: before obsidian-mind
		// 9.1.0 the budget stopped at the first fit, so collapsing "huge" last had already given up both.
		const small = "s".repeat(100);
		const ext: Extension = {
			id: "a",
			sections: [section("huge", 5, "h".repeat(5000), "(ptr 5)"), section("one", 10, small, "(ptr 10)"), section("two", 20, small, "(ptr 20)")],
		};
		const { result } = await collectSections(fromLoaded([declared(ext)]), ctx, "full");
		const fitted = applyInjectionBudget(result, 600);
		assert.deepEqual(fitted.collapsed, ["huge"]);
		assert.equal(fitted.text.split(small).length - 1, 2, "both small sections stay whole");
	});

	test("on a re-entry, a section with a pointer renders as its pointer and is not run", async () => {
		let ran = false;
		const ext: Extension = {
			id: "a",
			sections: [
				{ id: "p", priority: 1, header: "### p", pointer: "(ptr)", render: () => { ran = true; return "body"; } },
				section("full", 2, "always"),
			],
		};
		const { result } = await collectSections(fromLoaded([declared(ext)]), ctx, "pointer");
		assert.deepEqual(result.map((s) => s.body), ["(ptr)", "always"]);
		assert.equal(ran, false);
	});

	test("a section that renders null is left out", async () => {
		const ext: Extension = { id: "a", sections: [{ id: "n", priority: 1, header: "### n", render: () => null }] };
		assert.equal((await collectSections(fromLoaded([declared(ext)]), ctx, "full")).result.length, 0);
	});
});

describe("rule 5: a throw or a timeout is isolated", () => {
	test("a throwing item is skipped and reported; its neighbours run, at every point", async () => {
		const boom = () => { throw new Error("boom"); };
		const ext: Extension = {
			id: "a",
			sections: [{ id: "bad", priority: 1, header: "### bad", render: boom }, section("good", 2, "ok")],
			detectors: [{ id: "bad", detect: boom }, { id: "good", detect: () => [{ claim: "c", lines: ["l"] }] }],
			signals: [{ id: "bad", match: boom, hint: "never" }, { id: "good", match: () => true, hint: "h" }],
			validators: [{ id: "bad", appliesTo: () => true, validate: boom }, { id: "good", appliesTo: () => true, validate: () => ["w"] }],
		};
		const registry = fromLoaded([declared(ext)]);
		const sections = await collectSections(registry, ctx, "full");
		const detectors = await runDetectors(registry, ctx);
		const signals = await matchSignals(registry, "p");
		const validators = await runValidators(registry, { relPath: "a.md", content: "" }, ctx);
		assert.deepEqual(sections.result.map((s) => s.body), ["ok"]);
		assert.deepEqual(detectors.result.map((f) => f.claim), ["c"]);
		assert.deepEqual(signals.result, ["h"]);
		assert.deepEqual(validators.result, ["w"]);
		for (const run of [sections, detectors, signals, validators]) {
			assert.equal(run.failures.length, 1);
			assert.equal(run.failures[0]?.item, "bad");
			assert.equal(run.failures[0]?.message, "boom");
		}
		assert.match(formatFailures(sections.failures)[0] ?? "", /extension a, section bad: skipped \(boom\)/);
	});

	test("a rejected promise is isolated like a throw", async () => {
		const ext: Extension = { id: "a", detectors: [{ id: "rej", detect: () => Promise.reject(new Error("no")) }] };
		const { result, failures } = await runDetectors(fromLoaded([declared(ext)]), ctx);
		assert.deepEqual(result, []);
		assert.equal(failures[0]?.message, "no");
	});

	test("an item that never settles times out at its declaration's limit, and the others finish", async () => {
		const ext: Extension = {
			id: "a",
			sections: [
				{ id: "hang", priority: 1, header: "### hang", render: () => new Promise<string>(() => {}) },
				{ id: "slow-ok", priority: 2, header: "### ok", render: () => new Promise<string>((r) => setTimeout(() => r("done"), 10)) },
			],
		};
		const started = Date.now();
		const { result, failures } = await collectSections(fromLoaded([declared(ext, { timeoutMs: 100 })]), ctx, "full");
		assert.ok(Date.now() - started < 2_000, "the hook is not held past the limit");
		assert.deepEqual(result.map((s) => s.body), ["done"]);
		assert.equal(failures.length, 1);
		assert.equal(failures[0]?.item, "hang");
		assert.match(failures[0]?.message ?? "", /timed out after 100 ms/);
	});

	test("an item with an invalid priority is a failure, not a guess", async () => {
		const ext: Extension = { id: "a", sections: [section("nan", Number.NaN, "x"), section("ok", 1, "y")] };
		const { result, failures } = await collectSections(fromLoaded([declared(ext)]), ctx, "full");
		assert.deepEqual(result.map((s) => s.body), ["y"]);
		assert.equal(failures.length, 1);
	});
});

describe("rule 5: nothing an extension returns reaches the output unchecked", () => {
	test("a value of the wrong shape is a failure at every point, and the neighbours run", async () => {
		const ext = {
			id: "a",
			sections: [
				{ id: "num", priority: 1, header: "### n", render: () => 42 },
				{ id: "undef", priority: 2, header: "### u", render: () => undefined },
				{ id: "badheader", priority: 3, header: 7, render: () => "x" },
				section("good", 4, "ok"),
			],
			detectors: [
				{ id: "undef", detect: () => undefined },
				{ id: "nolines", detect: () => [{ claim: "c" }] },
				{ id: "good", detect: () => [{ claim: "c", lines: ["l"] }] },
			],
			checklist: [{ id: "bad", full: 1, short: "s" }, { id: "good", full: "F", short: "S" }],
			signals: [{ id: "str", match: () => "yes", hint: "h1" }, { id: "nohint", match: () => true, hint: 3 }, { id: "good", match: () => true, hint: "h" }],
			validators: [{ id: "str", appliesTo: () => true, validate: () => "w" }, { id: "good", appliesTo: () => true, validate: () => ["w"] }],
		} as unknown as Extension;
		const registry = fromLoaded([declared(ext)]);
		const sections = await collectSections(registry, ctx, "full");
		const detectors = await runDetectors(registry, ctx);
		const checklist = collectChecklist(registry);
		const signals = await matchSignals(registry, "p");
		const validators = await runValidators(registry, { relPath: "a.md", content: "" }, ctx);
		assert.deepEqual(sections.result.map((s) => s.body), ["ok"]);
		assert.deepEqual(sections.failures.map((f) => f.item), ["badheader", "num", "undef"]);
		assert.deepEqual(detectors.result.map((f) => f.claim), ["c"]);
		assert.deepEqual(detectors.failures.map((f) => f.item), ["nolines", "undef"], "failures follow run order: ties by id");
		assert.deepEqual(checklist.result.map((i) => i.id), ["good"]);
		assert.deepEqual(signals.result, ["h"]);
		assert.deepEqual(signals.failures.map((f) => f.item).sort(), ["nohint", "str"]);
		assert.deepEqual(validators.result, ["w"]);
		assert.equal(validators.failures.length, 1);
		assert.match(sections.failures[1]?.message ?? "", /returned number, not a string or null/);
	});

	test("a getter that throws, on a list or on an item, is a failure, not a crash", async () => {
		const throwingList = { id: "a", get detectors(): never { throw new Error("list getter"); } } as unknown as Extension;
		const throwingItem = { id: "b", detectors: [{ get id(): never { throw new Error("id getter"); }, detect: () => [] }] } as unknown as Extension;
		const { result, failures } = await runDetectors(fromLoaded([declared(throwingList), declared(throwingItem)]), ctx);
		assert.deepEqual(result, []);
		assert.deepEqual(failures.map((f) => f.message), ["list getter", "id getter"]);
	});

	test("an appliesTo that throws is isolated like a call", async () => {
		const ext: Extension = { id: "a", validators: [{ id: "bad", appliesTo: () => { throw new Error("nope"); }, validate: () => [] }] };
		const { failures } = await runValidators(fromLoaded([declared(ext)]), { relPath: "a.md", content: "" }, ctx);
		assert.equal(failures[0]?.message, "nope");
	});
});

describe("rule 8: overrides are by id", () => {
	test("an item id in `disable` is turned off; the rest of the extension runs", async () => {
		const ext: Extension = { id: "a", sections: [section("off", 1, "x"), section("on", 2, "y")], signals: [{ id: "off", match: () => true, hint: "h" }] };
		const registry = fromLoaded([declared(ext, { disable: ["off"] })]);
		assert.deepEqual((await collectSections(registry, ctx, "full")).result.map((s) => s.body), ["y"]);
		assert.deepEqual((await matchSignals(registry, "p")).result, []);
	});
});

describe("loading (rules 3, 5 and 8)", () => {
	const root = mkdtempSync(join(tmpdir(), "registry-load-"));
	after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "ext"), { recursive: true });
	writeFileSync(join(root, "ext", "good.mjs"), "export default { id: 'good', checklist: [{ id: 'c', full: 'F', short: 'S' }] };\n");
	writeFileSync(join(root, "ext", "named.mjs"), "export const extension = { id: 'named' };\n");
	writeFileSync(join(root, "ext", "wrong-id.mjs"), "export default { id: 'other' };\n");
	writeFileSync(join(root, "ext", "empty.mjs"), "export const nothing = 1;\n");
	writeFileSync(join(root, "ext", "throws.mjs"), "throw new Error('import boom');\n");
	const manifest = {
		extensions: [
			{ id: "good", module: "ext/good.mjs", events: ["stop"] },
			{ id: "named", module: "ext/named.mjs", events: ["stop"] },
			{ id: "wrong", module: "ext/wrong-id.mjs", events: ["stop"] },
			{ id: "empty", module: "ext/empty.mjs", events: ["stop"] },
			{ id: "throws", module: "ext/throws.mjs", events: ["stop"] },
			{ id: "missing", module: "ext/missing.mjs", events: ["stop"] },
			{ id: "disabled", module: "ext/throws.mjs", events: ["stop"], enabled: false },
		],
	};

	test("good modules load by default or named export; every bad one is one failure; a disabled one is never imported", async () => {
		const registry = await loadRegistry(root, manifest, "stop", {});
		assert.equal(registry.off, false);
		assert.deepEqual(registry.loaded.map((l) => l.extension.id), ["good", "named"]);
		assert.deepEqual(registry.failures.map((f) => f.extension), ["wrong", "empty", "throws", "missing"]);
		assert.equal(collectChecklist(registry).result.length, 1);
	});

	test("a module whose import never settles times out instead of ending the hook", async () => {
		writeFileSync(join(root, "ext", "hangs.mjs"), "await new Promise(() => {});\nexport default { id: 'hangs' };\n");
		const started = Date.now();
		const registry = await loadRegistry(root, { extensions: [{ id: "hangs", module: "ext/hangs.mjs", events: ["stop"], timeoutMs: 100 }] }, "stop", {});
		assert.ok(Date.now() - started < 2_000);
		assert.equal(registry.loaded.length, 0);
		assert.match(registry.failures[0]?.message ?? "", /timed out after 100 ms/);
	});

	test("rule 3: an extension is imported only by the hooks it is declared for, and fails only there", async () => {
		const marker = join(root, "imported.txt");
		writeFileSync(join(root, "ext", "side.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\nexport default { id: "side" };\n`);
		const only = {
			extensions: [
				{ id: "side", module: "ext/side.mjs", events: ["session-start"] },
				{ id: "gone", module: "ext/missing.mjs", events: ["session-start"] },
			],
		};
		for (const event of ["stop", "prompt", "write"] as const) {
			const registry = await loadRegistry(root, only, event, {});
			assert.equal(existsSync(marker), false, `${event} imported a session-start extension`);
			assert.deepEqual(registry.loaded, []);
			assert.deepEqual(registry.failures, [], `${event} reported a session-start extension's failure`);
		}
		const registry = await loadRegistry(root, only, "session-start", {});
		assert.equal(existsSync(marker), true);
		assert.deepEqual(registry.loaded.map((l) => l.extension.id), ["side"]);
		assert.deepEqual(registry.failures.map((f) => f.extension), ["gone"]);
	});

	test(`the kill switch (${KILL_SWITCH}=off) loads nothing and says so`, async () => {
		const registry = await loadRegistry(root, manifest, "stop", { [KILL_SWITCH]: "off" });
		assert.equal(registry.off, true);
		assert.equal(registry.loaded.length, 0);
		assert.equal(registry.failures.length, 0);
	});
});

describe("rule 7: slots are recorded, not dispatched", () => {
	test("pre-tool guards and MCP tools are listed as undispatched", () => {
		const registry = fromLoaded([declared({ id: "a", preToolGuards: [{}], mcpTools: [{}] })]);
		assert.deepEqual(undispatched(registry), ["a: pre-tool guards", "a: MCP tools"]);
	});
});
