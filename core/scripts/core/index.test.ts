/**
 * The public entry point (index.ts) carries what it promises extensions.
 * An extension imports only from here, so a helper that is not exported is
 * not available to it, however much of the core uses it.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectDir, writeFileAtomic } from "./index.ts";

describe("writeFileAtomic, through index.ts", () => {
	let dir = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "core-index-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("writes the whole text, replacing what was there, and leaves no temp file", () => {
		const target = join(dir, "note.md");
		writeFileSync(target, "old");
		const text = "---\ntitle: note\n---\n\nbody ✓\r\n";
		writeFileAtomic(target, text);
		assert.equal(readFileSync(target, "utf-8"), text);
		assert.deepEqual(readdirSync(dir), ["note.md"]);
	});

	test("a rename that fails after the temp file is written throws and removes the temp file", () => {
		// A non-empty folder where the note should go: the temp file is
		// written, then the rename over the folder fails.
		const target = join(dir, "note.md");
		mkdirSync(target);
		writeFileSync(join(target, "keep"), "x");
		assert.throws(() => writeFileAtomic(target, "text"), (err: NodeJS.ErrnoException) => err.syscall === "rename");
		assert.deepEqual(readdirSync(dir), ["note.md"]);
		assert.deepEqual(readdirSync(target), ["keep"]);
	});

	test("a write that fails before any temp file exists throws its own error, not the cleanup's", () => {
		const target = join(dir, "missing", "note.md");
		assert.throws(() => writeFileAtomic(target, "text"), (err: NodeJS.ErrnoException) => err.code === "ENOENT" && err.syscall === "open");
		assert.deepEqual(readdirSync(dir), []);
	});
});

describe("resolveProjectDir, through index.ts", () => {
	let root = "";
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "core-vault-"));
		writeFileSync(join(root, "vault-manifest.json"), "{}");
		mkdirSync(join(root, "notes", "deep"), { recursive: true });
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	test("a session started in a nested folder finds the vault root above it", () => {
		const nested = join(root, "notes", "deep");
		assert.equal(resolveProjectDir(nested, {}), root);
		assert.equal(resolveProjectDir("unused", { CLAUDE_PROJECT_DIR: nested }), root);
	});

	test("outside any vault, the named folder itself", () => {
		const outside = mkdtempSync(join(tmpdir(), "core-novault-"));
		try {
			assert.equal(resolveProjectDir(outside, {}), outside);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
