/**
 * The public entry point (index.ts) carries what it promises extensions.
 * An extension imports only from here, so a helper that is not exported is
 * not available to it, however much of the core uses it.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import * as lib from "../lib/project-dir.ts";
import * as instructionFiles from "../lib/instruction-files.ts";
import * as core from "./index.ts";
import { debug, resolveProjectDir, writeFileAtomic } from "./index.ts";
import { debug as hookDebug } from "../lib/hook-io.ts";

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

	test("is the core's own function", () => {
		assert.equal(resolveProjectDir, lib.resolveProjectDir);
	});

	test("a runner in a nested folder finds the vault root above it, named absolutely or relative to the working directory", () => {
		const nested = join(root, "notes", "deep");
		assert.equal(resolveProjectDir(nested, {}), root);
		const fromCwd = relative(process.cwd(), nested);
		assert.equal(resolveProjectDir(fromCwd, {}), root);
	});
});

describe("instruction files, through index.ts", () => {
	test("AGENTS.md is the instruction file; CLAUDE.md and GEMINI.md are retired", () => {
		assert.equal(core.INSTRUCTION_FILE, "AGENTS.md");
		assert.deepEqual([...core.RETIRED_INSTRUCTION_FILES], ["CLAUDE.md", "GEMINI.md"]);
		assert.equal(core.RETIRED_INSTRUCTION_FILES, instructionFiles.RETIRED_INSTRUCTION_FILES, "the export is the list the check reads");
		assert.ok(Object.isFrozen(instructionFiles.RETIRED_INSTRUCTION_FILES), "no extension can change the shared list");
		assert.throws(() => (instructionFiles.RETIRED_INSTRUCTION_FILES as string[]).push("README.md"));
		assert.equal(core.isRetiredInstructionFile("README.md"), false);
	});

	test("the size caps: the template stays under the flag, which stays under what Antigravity was seen to read", () => {
		assert.ok(core.AGENTS_MD_MAX_BYTES < core.AGENTS_MD_FLAG_BYTES);
		// The last byte Antigravity 1.3.0 was seen to read (obsidian-mind #321, recorded in lib/instruction-files.ts).
		const ANTIGRAVITY_LAST_READ_BYTE = 23_860;
		assert.ok(core.AGENTS_MD_FLAG_BYTES < ANTIGRAVITY_LAST_READ_BYTE);
	});

	test("a retired file is recognised in any case, as Windows and macOS resolve it, and nothing else is", () => {
		for (const name of ["CLAUDE.md", "claude.md", "Gemini.MD"]) assert.equal(core.isRetiredInstructionFile(name), true, name);
		for (const name of ["AGENTS.md", "CLAUDE.md.bak", "notes/CLAUDE.md", "README.md"]) assert.equal(core.isRetiredInstructionFile(name), false, name);
	});
});

test("debug, the HOOK_DEBUG trace, is exported to extensions: one home, so traces can't drift (#95)", () => {
	assert.equal(debug, hookDebug);
});
