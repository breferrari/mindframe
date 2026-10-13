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
	runEffects,
	runValidators,
	undispatched,
} from "./registry.ts";
import type { Declaration, Effect, EffectTrigger, Extension, HookContext, HookEvent, Section } from "./types.ts";

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
				{ id: "compact", module: "z.ts", events: ["pre-compact"] },
			],
		});
		assert.deepEqual(result.map((d) => d.id), ["ok", "compact"]);
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

	test("every call starts before any limit: a call that blocks spends no other call's time, before it or after it (#70)", async () => {
		const busy = (ms: number) => {
			const end = Date.now() + ms;
			while (Date.now() < end) {
				/* synchronous work, as QMD's spawnSync probes are */
			}
		};
		const blocking: Extension = { id: "blocks", sections: [{ id: "sync", priority: 0, header: "### sync", render: () => (busy(300), "blocked") }] };
		const waiting: Extension = { id: "waits", sections: [{ id: "io", priority: 1, header: "### io", render: () => new Promise<string>((r) => setTimeout(() => r("arrived"), 20)) }] };
		const { result, failures } = await collectSections(fromLoaded([declared(blocking), declared(waiting, { timeoutMs: 100 })]), ctx, "full");
		assert.deepEqual(failures, []);
		assert.deepEqual(result.map((s) => s.body), ["blocked", "arrived"]);
		// And the other way round: an async call that starts first keeps its time too. Its work
		// goes on past the block (a second wait, started only when the first ends), so a limit
		// that ran through the block would already be spent.
		const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
		const first: Extension = { id: "waits-first", sections: [{ id: "io", priority: -1, header: "### io", render: async () => (await pause(0), await pause(30), "arrived") }] };
		const after = await collectSections(fromLoaded([declared(first, { timeoutMs: 150 }), declared(blocking)]), ctx, "full");
		assert.deepEqual(after.failures, []);
		assert.deepEqual(after.result.map((s) => s.body), ["arrived", "blocked"]);
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

	// A getter runs the extension's code, so every field the registry reads
	// outside a call is read once, inside a try (#110).
	const boom = (): never => {
		throw new Error("getter");
	};
	/** A field that reads `first` once, then throws: a second read would escape the dispatch. */
	const once = <T>(first: T) => {
		let read = false;
		return () => (read ? boom() : ((read = true), first));
	};

	test("a checklist item whose `full` or `short` getter throws is a failure; the other items come back (#110)", () => {
		const ext = {
			id: "a",
			checklist: [
				{ id: "a.1", get full(): string { return boom(); }, short: "s" },
				{ id: "a.2", full: "f", get short(): string { return boom(); } },
				{ id: "a.3", full: "F", short: "S" },
			],
		} as unknown as Extension;
		const { result, failures } = collectChecklist(fromLoaded([declared(ext)]));
		assert.deepEqual(result, [{ id: "a.3", full: "F", short: "S" }]);
		assert.deepEqual(failures.map((f) => [f.point, f.item, f.message]), [["checklist", "a.1", "getter"], ["checklist", "a.2", "getter"]]);
	});

	test("a checklist item's fields are read once: a getter that throws on a second read can't escape (#110)", () => {
		const full = once("F");
		const ext = { id: "a", checklist: [{ id: "a.1", get full() { return full(); }, short: "S" }] } as unknown as Extension;
		const { result, failures } = collectChecklist(fromLoaded([declared(ext)]));
		assert.deepEqual(result, [{ id: "a.1", full: "F", short: "S" }]);
		assert.deepEqual(failures, []);
	});

	test("a section whose `header` or `pointer` getter throws is a failure; the other sections render (#110)", async () => {
		const ext = {
			id: "a",
			sections: [
				{ id: "a.1", get header(): string { return boom(); }, render: () => "x" },
				{ id: "a.2", header: "### B", get pointer(): string { return boom(); }, render: () => "y" },
				section("a.3", 3, "z"),
			],
		} as unknown as Extension;
		const { result, failures } = await collectSections(fromLoaded([declared(ext)]), ctx, "full");
		assert.deepEqual(result.map((s) => s.body), ["z"]);
		assert.deepEqual(failures.map((f) => [f.point, f.item, f.message]), [["section", "a.1", "getter"], ["section", "a.2", "getter"]]);
	});

	// A getter that changes type, not one that throws: the output must carry the value that was checked.
	test("a section's header is read once: a getter that changes type after the check can't reach the output (#110)", async () => {
		const reads: unknown[] = ["### Once", 42];
		const ext = { id: "a", sections: [{ id: "a.1", get header() { return reads.shift(); }, render: () => "x" }] } as unknown as Extension;
		const { result, failures } = await collectSections(fromLoaded([declared(ext)]), ctx, "full");
		assert.deepEqual(result.map((s) => s.header), ["### Once"]);
		assert.deepEqual(failures, []);
	});

	test("a section's pointer, and a checklist item's short, are read once too: in pointer mode the pointer is the body (#110)", async () => {
		const pointers: unknown[] = ["see notes", 42];
		const sections = { id: "a", sections: [{ id: "a.1", header: "### A", get pointer() { return pointers.shift(); }, render: () => "x" }] } as unknown as Extension;
		const pointed = await collectSections(fromLoaded([declared(sections)]), ctx, "pointer");
		assert.deepEqual(pointed.result.map((s) => s.body), ["see notes"]);
		assert.deepEqual(pointed.failures, []);
		const shorts: unknown[] = ["S", 42];
		const checklist = { id: "a", checklist: [{ id: "a.1", full: "F", get short() { return shorts.shift(); } }] } as unknown as Extension;
		assert.deepEqual(collectChecklist(fromLoaded([declared(checklist)])).result, [{ id: "a.1", full: "F", short: "S" }]);
	});

	test("a getter that throws a non-Error, and a Proxy that throws on every get, are failures too (#110)", () => {
		const ext = {
			id: "a",
			checklist: [
				{ id: "a.1", get full(): string { throw "plain string"; }, short: "s" },
				new Proxy({}, { get: () => { throw new Error("proxy"); } }),
				{ id: "a.3", full: "F", short: "S" },
			],
		} as unknown as Extension;
		const { result, failures } = collectChecklist(fromLoaded([declared(ext)]));
		assert.deepEqual(result.map((i) => i.id), ["a.3"]);
		assert.deepEqual(failures.map((f) => [f.point, f.item, f.message]), [["checklist", undefined, "proxy"], ["checklist", "a.1", "plain string"]]);
	});

	test("a signal's hint is read once: a getter that throws on a second read can't escape (#110)", async () => {
		const hint = once("h");
		const ext = { id: "a", signals: [{ id: "a.1", match: () => true, get hint() { return hint(); } }] } as unknown as Extension;
		const { result, failures } = await matchSignals(fromLoaded([declared(ext)]), "p");
		assert.deepEqual(result, ["h"]);
		assert.deepEqual(failures, []);
	});

	test("an extension's id is read from its declaration after load: an id getter that throws later can't escape (#110)", async () => {
		// The registry is built around the extension, so only reads after load reach this getter.
		const ext = { get id(): string { return boom(); }, checklist: [{ id: "a.1", full: "F", short: "S" }], get sections(): never { return boom(); }, mcpTools: [{}] } as unknown as Extension;
		const registry = fromLoaded([declared({ id: "a" } as Extension)]);
		const loaded = { ...registry, loaded: [{ declaration: registry.loaded[0]!.declaration, extension: ext }] };
		assert.deepEqual(collectChecklist(loaded).result.map((i) => i.id), ["a.1"]);
		assert.deepEqual((await collectSections(loaded, ctx, "full")).failures.map((f) => f.extension), ["a"]);
		assert.deepEqual(undispatched(loaded), ["a: MCP tools"]);
	});

	test("a list that is a Proxy of an array, throwing as it is walked, is a failure, not a crash (#110)", () => {
		const list = new Proxy([], { get: (target, key) => (key === "length" || key === Symbol.iterator ? boom() : Reflect.get(target, key)) });
		const ext = { id: "a", checklist: list } as unknown as Extension;
		const { result, failures } = collectChecklist(fromLoaded([declared(ext), declared({ id: "b", checklist: [{ id: "b.1", full: "F", short: "S" }] })]));
		assert.deepEqual(result.map((i) => i.id), ["b.1"]);
		assert.deepEqual(failures.map((f) => [f.extension, f.point, f.message]), [["a", "checklist", "getter"]]);
	});

	test("a checklist item keeps its own priority (#110)", () => {
		const ext: Extension = { id: "a", checklist: [{ id: "a.1", full: "F", short: "S", priority: 3 }, { id: "a.2", full: "F", short: "S" }] };
		assert.deepEqual(collectChecklist(fromLoaded([declared(ext)])).result, [
			{ id: "a.1", full: "F", short: "S", priority: 3 },
			{ id: "a.2", full: "F", short: "S" },
		]);
	});

	test("a matching signal whose `hint` getter throws is a failure; the other hints come back (#110)", async () => {
		const ext = {
			id: "a",
			signals: [
				{ id: "a.1", match: () => true, get hint(): string { return boom(); } },
				{ id: "a.2", match: () => true, hint: "h" },
			],
		} as unknown as Extension;
		const { result, failures } = await matchSignals(fromLoaded([declared(ext)]), "p");
		assert.deepEqual(result, ["h"]);
		assert.deepEqual(failures.map((f) => [f.point, f.item, f.message]), [["signal", "a.1", "getter"]]);
	});

	test("an item's id is read once: an id getter that throws on a later read can't escape the sort (#110)", () => {
		const id = once("a.1");
		const ext = { id: "a", checklist: [{ get id() { return id(); }, full: "F", short: "S" }, { id: "a.0", full: "F", short: "S" }] } as unknown as Extension;
		const { result, failures } = collectChecklist(fromLoaded([declared(ext)]));
		assert.deepEqual(result.map((i) => i.id), ["a.0", "a.1"]);
		assert.deepEqual(failures, []);
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

	test("effects on an extension that declares no effect event are listed: they can never run", () => {
		const effects = [{ id: "e", on: ["write"], run: () => {} }] as const;
		const registry = fromLoaded([declared({ id: "a", effects }, { events: ["prompt"] }), declared({ id: "b", effects }, { events: ["write"] })]);
		assert.deepEqual(undispatched(registry), ["a: effects, with no session-start, write, pre-compact or stop in its events"]);
	});

	test("a getter that throws does not make undispatched throw", () => {
		const ext = { id: "a", get effects(): Effect[] { throw new Error("getter"); } } as Extension;
		assert.deepEqual(undispatched(fromLoaded([declared(ext, { events: ["session-start"] })])), []);
	});
});

describe("rule 5: effects run for their side effect alone", () => {
	const write: EffectTrigger = { event: "write", target: { relPath: "notes/a.md", content: "body" } };
	const all: readonly HookEvent[] = ["write", "pre-compact", "stop"];
	const effect = (id: string, on: Effect["on"], run: Effect["run"]): Effect => ({ id, on, run });

	test("an effect runs for the events in its `on`, and no other", async () => {
		const ran: string[] = [];
		const ext: Extension = {
			id: "a",
			effects: [
				effect("w", ["write"], (t) => { ran.push(`w:${t.event}`); }),
				effect("pc", ["pre-compact", "stop"], (t) => { ran.push(`pc:${t.event}`); }),
			],
		};
		const registry = fromLoaded([declared(ext, { events: all })]);
		for (const trigger of [write, { event: "pre-compact" }, { event: "stop" }] as const) {
			const { failures } = await runEffects(registry, trigger, ctx);
			assert.deepEqual(failures, []);
		}
		assert.deepEqual(ran, ["w:write", "pc:pre-compact", "pc:stop"]);
	});

	test("an effect runs at session start too (#95)", async () => {
		const ran: string[] = [];
		const ext: Extension = { id: "a", effects: [effect("s", ["session-start"], (t) => { ran.push(t.event); })] };
		const { failures } = await runEffects(fromLoaded([declared(ext, { events: ["session-start"] })]), { event: "session-start" }, ctx);
		assert.deepEqual(failures, []);
		assert.deepEqual(ran, ["session-start"]);
	});

	test("an effect whose `on` names an event its declaration does not list is a failure, not a silent skip", async () => {
		let ran = false;
		const ext: Extension = { id: "a", effects: [effect("pc", ["pre-compact", "stop"], () => { ran = true; })] };
		const twice: Extension = { id: "b", effects: [effect("pc", ["pre-compact", "stop", "stop"], () => {})] };
		const registry = fromLoaded([declared(ext, { events: ["write", "pre-compact"] }), declared(twice, { events: ["pre-compact"] })]);
		const { failures } = await runEffects(registry, { event: "pre-compact" }, ctx);
		assert.equal(ran, false);
		assert.deepEqual(failures.map((f) => [f.extension, f.message]), [
			["a", "`on` lists stop, which the declaration's `events` do not"],
			["b", "`on` lists stop, which the declaration's `events` do not"],
		]);
	});

	test("a write effect receives the target, a backslash path passed through as given", async () => {
		const seen: EffectTrigger[] = [];
		const ext: Extension = { id: "a", effects: [effect("w", ["write"], (t) => { seen.push(t); })] };
		const trigger: EffectTrigger = { event: "write", target: { relPath: "notes\\a.md", content: "c" } };
		await runEffects(fromLoaded([declared(ext, { events: all })]), trigger, ctx);
		assert.deepEqual(seen, [trigger]);
	});

	test("a throw, a synchronous throw, a rejection and a timeout are reported, and the other effects still run", async () => {
		let ran = false;
		const ext: Extension = {
			id: "a",
			effects: [
				effect("throws", ["stop"], () => { throw new Error("boom"); }),
				effect("sync-throw", ["stop"], (() => { throw new Error("before the promise"); }) as Effect["run"]),
				effect("rejects", ["stop"], () => Promise.reject(new Error("no"))),
				effect("hangs", ["stop"], () => new Promise<void>(() => {})),
				effect("ok", ["stop"], () => { ran = true; }),
			],
		};
		const { failures } = await runEffects(fromLoaded([declared(ext, { events: all, timeoutMs: 100 })]), { event: "stop" }, ctx);
		assert.equal(ran, true);
		assert.deepEqual(failures.map((f) => [f.point, f.item]), [["effect", "hangs"], ["effect", "rejects"], ["effect", "sync-throw"], ["effect", "throws"]]);
		assert.match(failures.find((f) => f.item === "hangs")?.message ?? "", /timed out after 100 ms/);
		assert.match(formatFailures(failures)[0] ?? "", /extension a, effect hangs: skipped/);
	});

	test("one effect timing out does not hold another past its own limit, and the limits do not add up", async () => {
		const one = (id: string, run: Effect["run"]): Extension => ({ id, effects: [effect(id, ["stop"], run)] });
		let quickDone = 0;
		const started = Date.now();
		const registry = fromLoaded([
			declared(one("hang-a", () => new Promise<void>(() => {})), { events: all, timeoutMs: 400 }),
			declared(one("hang-b", () => new Promise<void>(() => {})), { events: all, timeoutMs: 400 }),
			declared(one("quick", () => new Promise<void>((r) => setTimeout(() => { quickDone = Date.now(); r(); }, 10))), { events: all, timeoutMs: 2_000 }),
		]);
		const { failures } = await runEffects(registry, { event: "stop" }, ctx);
		assert.ok(quickDone > 0 && quickDone - started < 400, "the quick effect finished before the others timed out");
		assert.ok(Date.now() - started < 700, "the two 400 ms limits ran together: one after the other would take 800 ms");
		assert.deepEqual(failures.map((f) => f.extension), ["hang-a", "hang-b"]);
	});

	test("an effect that returns a value, now or later, is a failure", async () => {
		const ext: Extension = {
			id: "a",
			effects: [
				effect("value", ["stop"], (() => "output") as unknown as Effect["run"]),
				effect("later", ["stop"], (() => Promise.resolve(1)) as unknown as Effect["run"]),
				effect("void", ["stop"], async () => {}),
			],
		};
		const { failures } = await runEffects(fromLoaded([declared(ext, { events: all })]), { event: "stop" }, ctx);
		assert.deepEqual(failures.map((f) => f.item), ["later", "value"]);
		assert.match(failures[0]?.message ?? "", /returned number, not nothing/);
	});

	test("an `on` that is not a list of the effect events is a failure", async () => {
		let ran = 0;
		const run = () => { ran++; };
		const ext: Extension = {
			id: "a",
			effects: [
				{ id: "string", on: "stop", run } as unknown as Effect,
				{ id: "unknown", on: ["stop", "prompt"], run } as unknown as Effect,
				{ id: "missing", run } as unknown as Effect,
				{ id: "empty", on: [], run } as unknown as Effect,
				effect("ok", ["stop"], run),
			],
		};
		const { failures } = await runEffects(fromLoaded([declared(ext, { events: all })]), { event: "stop" }, ctx);
		assert.equal(ran, 1);
		assert.deepEqual(failures.map((f) => f.item), ["empty", "missing", "string", "unknown"], "reported in run order");
	});

	test("a getter that throws on `effects` is a failure, not a crash", async () => {
		const ext = { id: "a", get effects(): Effect[] { throw new Error("getter"); } } as Extension;
		const { failures } = await runEffects(fromLoaded([declared(ext, { events: all })]), { event: "stop" }, ctx);
		assert.deepEqual(failures.map((f) => [f.point, f.message]), [["effect", "getter"]]);
	});

	test("an effect id in `disable` does not run", async () => {
		const ran: string[] = [];
		const ext: Extension = { id: "a", effects: [effect("off", ["stop"], () => { ran.push("off"); }), effect("on", ["stop"], () => { ran.push("on"); })] };
		await runEffects(fromLoaded([declared(ext, { events: all, disable: ["off"] })]), { event: "stop" }, ctx);
		assert.deepEqual(ran, ["on"]);
	});

	test(`pre-compact loads only its own extensions, and the kill switch (${KILL_SWITCH}=off) runs no effect`, async () => {
		const root = mkdtempSync(join(tmpdir(), "registry-effects-"));
		after(() => rmSync(root, { recursive: true, force: true }));
		const marker = join(root, "ran.txt");
		writeFileSync(join(root, "fx.mjs"), `import { writeFileSync } from "node:fs";
export default { id: "fx", effects: [{ id: "e", on: ["pre-compact"], run: () => { writeFileSync(${JSON.stringify(marker)}, "x"); } }] };
`);
		const manifest = { extensions: [{ id: "fx", module: "fx.mjs", events: ["pre-compact"] }] };
		assert.deepEqual((await loadRegistry(root, manifest, "stop", {})).loaded, []);
		const off = await loadRegistry(root, manifest, "pre-compact", { [KILL_SWITCH]: "off" });
		assert.deepEqual(off.loaded, []);
		await runEffects(off, { event: "pre-compact" }, ctx);
		assert.equal(existsSync(marker), false);
		const on = await loadRegistry(root, manifest, "pre-compact", {});
		assert.deepEqual((await runEffects(on, { event: "pre-compact" }, ctx)).failures, []);
		assert.equal(existsSync(marker), true);
	});
});
