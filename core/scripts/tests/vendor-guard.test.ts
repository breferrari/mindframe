/**
 * Unit tests for vendor-guard.ts: a vendored file isn't edited in place by
 * accident, and the deny message names the three routes.
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BEGIN_DIR, BEGIN_WINDOW_MS, beginEdits, decide, denyMessage, endEdits, EXTENSIONS_HOW } from "../vendor-guard.ts";

const GUARD = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor-guard.ts");
const NOW = 1_800_000_000_000;

function vault(t: TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "mf-guard-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "vault-manifest.json"), "{}");
	mkdirSync(join(root, ".claude", "scripts", "lib"), { recursive: true });
	// The default record resolves against the vault root, any other against its own folder.
	writeFileSync(
		join(root, ".claude", "VENDOR.json"),
		JSON.stringify({ repository: "https://github.com/o/obsidian-mind", files: { ".claude/scripts/lint.ts": {} } }),
	);
	writeFileSync(
		join(root, ".claude", "scripts", "VENDOR.json"),
		JSON.stringify({ repository: "https://github.com/o/mindframe.git", files: { "lib/hook-io.ts": {} } }),
	);
	return root;
}

const edit = (filePath: string, tool = "Edit") => ({ tool_name: tool, tool_input: { file_path: filePath } });

test("an edit to a file either record lists is denied, naming no upstream", (t) => {
	const root = vault(t);
	const a = decide(edit(join(root, ".claude", "scripts", "lib", "hook-io.ts")), root, NOW);
	assert.match(a ?? "", /^\.claude\/scripts\/lib\/hook-io\.ts is vendored:/);
	const b = decide(edit(".claude/scripts/lint.ts", "Write"), root, NOW);
	assert.match(b ?? "", /^\.claude\/scripts\/lint\.ts is vendored:/);
	// A vault may not show its upstream's name at runtime: nothing from the records' repository reaches the message.
	for (const m of [a, b]) assert.doesNotMatch(m ?? "", /obsidian-mind|github\.com\/o\//);
	for (const tool of ["MultiEdit", "NotebookEdit"]) assert.notEqual(decide(edit(".claude/scripts/lint.ts", tool), root, NOW), null, tool);
	assert.notEqual(decide({ tool_name: "NotebookEdit", tool_input: { notebook_path: ".claude/scripts/lint.ts" } }, root, NOW), null);
});

test("Windows paths match without case", (t) => {
	const root = vault(t);
	assert.notEqual(decide(edit(join(root, ".CLAUDE", "Scripts", "LINT.ts")), root, NOW, "win32"), null);
	assert.equal(decide(edit(join(root, ".CLAUDE", "Scripts", "LINT.ts")), root, NOW, "linux"), null);
});

test("anything else is allowed: other files, other tools, a record path read from the wrong root, bad input", (t) => {
	const root = vault(t);
	assert.equal(decide(edit("notes/today.md"), root, NOW), null);
	assert.equal(decide(edit(".claude/scripts/VENDOR.json"), root, NOW), null);
	assert.equal(decide({ tool_name: "Read", tool_input: { file_path: ".claude/scripts/lint.ts" } }, root, NOW), null);
	assert.equal(decide(edit("lib/hook-io.ts"), root, NOW), null, "the scripts record's paths are under its own folder, not the vault root");
	for (const bad of [null, "x", {}, { tool_name: "Edit" }, { tool_name: "Edit", tool_input: { file_path: 3 } }]) assert.equal(decide(bad, root, NOW), null);
});

test("a vault with no record allows every edit and prints nothing: the guard ships inert where records don't install", (t) => {
	const root = vault(t);
	rmSync(join(root, ".claude", "VENDOR.json"));
	rmSync(join(root, ".claude", "scripts", "VENDOR.json"));
	for (const p of [".claude/scripts/lint.ts", ".claude/scripts/lib/hook-io.ts", ".claude/settings.json"]) assert.equal(decide(edit(p), root, NOW), null, p);
	const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", GUARD], {
		input: JSON.stringify(edit(".claude/scripts/lib/hook-io.ts")),
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, CLAUDE_PROJECT_DIR: root },
	});
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout, "");
	assert.equal(r.stderr, "");
});

test("a broken record is skipped, not fatal", (t) => {
	const root = vault(t);
	writeFileSync(join(root, ".claude", "VENDOR.json"), "{ not json");
	assert.equal(decide(edit(".claude/scripts/lint.ts"), root, NOW), null);
	assert.notEqual(decide(edit(".claude/scripts/lib/hook-io.ts"), root, NOW), null);
});

test("vendor patch begin opens a 30-minute window for its files only, and patch new closes it", (t) => {
	const root = vault(t);
	beginEdits(root, [".claude/scripts/lint.ts"], NOW);
	assert.equal(readFileSync(join(root, BEGIN_DIR, ".gitignore"), "utf8"), "*\n", "the window file is never committed");
	assert.equal(decide(edit(".claude/scripts/lint.ts"), root, NOW + BEGIN_WINDOW_MS - 1), null);
	assert.notEqual(decide(edit(".claude/scripts/lint.ts"), root, NOW + BEGIN_WINDOW_MS), null, "closed at 30 minutes");
	assert.notEqual(decide(edit(".claude/scripts/lib/hook-io.ts"), root, NOW), null, "other files stay guarded");
	beginEdits(root, [".claude/scripts/lib/hook-io.ts"], NOW);
	endEdits(root, [".claude/scripts/lib/hook-io.ts"]);
	assert.notEqual(decide(edit(".claude/scripts/lib/hook-io.ts"), root, NOW), null);
	assert.equal(decide(edit(".claude/scripts/lint.ts"), root, NOW), null, "ending one window keeps the other");
	beginEdits(root, [".claude/scripts/lib/hook-io.ts"], NOW + BEGIN_WINDOW_MS);
	const windows = JSON.parse(readFileSync(join(root, BEGIN_DIR, "windows.json"), "utf8"));
	assert.deepEqual(Object.keys(windows), [".claude/scripts/lib/hook-io.ts"], "a closed window is dropped");
});

test("the message names the three routes in order: an extension, a fix upstream, a local patch", () => {
	const m = denyMessage({ rel: ".claude/scripts/lib/hook-io.ts" });
	const at = (s: string) => {
		const i = m.indexOf(s);
		assert.ok(i >= 0, `names ${s}`);
		return i;
	};
	const ext = at("Add an extension in .claude/extensions/");
	const upstream = at("A bug upstream? Fix it there");
	const local = at('--not-needed "<reason>"');
	assert.ok(ext < upstream && upstream < local, m);
	assert.ok(m.includes(EXTENSIONS_HOW), "points at how to write an extension");
	assert.ok(at("--issue") < local);
	assert.ok(!m.includes("—"), "no em-dashes");
	assert.ok(m.split("\n").length <= 4, "short");
});

test("as a hook: denies with PreToolUse JSON, allows silently, and fails open", (t) => {
	const root = vault(t);
	const hook = (stdin: string) =>
		spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", GUARD], {
			input: stdin,
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: root },
		});
	const denied = hook(JSON.stringify(edit(".claude/scripts/lint.ts")));
	assert.equal(denied.status, 0, denied.stderr);
	const out = JSON.parse(denied.stdout);
	assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
	assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
	assert.match(out.hookSpecificOutput.permissionDecisionReason, /^\.claude\/scripts\/lint\.ts is vendored:/);
	for (const stdin of [JSON.stringify(edit("notes/a.md")), "not json", ""]) {
		const r = hook(stdin);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stdout, "", stdin);
	}
	assert.ok(!existsSync(join(root, BEGIN_DIR)), "a check writes nothing");
});
