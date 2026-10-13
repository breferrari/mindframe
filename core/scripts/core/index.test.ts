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

	test("a retired file is matched the way the agent loads it: any case where the filesystem ignores case, exact on Linux (#91)", () => {
		for (const platform of ["win32", "darwin"] as const) {
			assert.equal(core.filesystemIgnoresCase(platform), true, platform);
			for (const name of ["CLAUDE.md", "claude.md", "Gemini.MD"]) assert.equal(core.isRetiredInstructionFile(name, platform), true, `${platform} ${name}`);
		}
		assert.equal(core.filesystemIgnoresCase("linux"), false);
		for (const name of ["CLAUDE.md", "GEMINI.md"]) assert.equal(core.isRetiredInstructionFile(name, "linux"), true, name);
		for (const name of ["claude.md", "Gemini.MD"]) assert.equal(core.isRetiredInstructionFile(name, "linux"), false, `linux ${name}: the agent never loads it`);
		for (const platform of ["win32", "darwin", "linux"] as const) {
			for (const name of ["AGENTS.md", "CLAUDE.md.bak", "notes/CLAUDE.md", "README.md"]) assert.equal(core.isRetiredInstructionFile(name, platform), false, `${platform} ${name}`);
		}
		assert.equal(core.isRetiredInstructionFile("claude.md"), core.filesystemIgnoresCase(), "one argument: this machine's rule");
	});

	test("isInstructionFile: AGENTS.md and the retired names, by the same rule (#91)", () => {
		assert.equal(core.isInstructionFile("agents.md", "win32"), true);
		assert.equal(core.isInstructionFile("agents.md", "linux"), false);
		assert.equal(core.isInstructionFile("AGENTS.md", "linux"), true);
		assert.equal(core.isInstructionFile("README.md", "win32"), false);
	});

	test("sameOnDisk: names and paths compared without case where the filesystem ignores it (#91)", () => {
		assert.equal(core.sameOnDisk("C:\\Vault", "c:\\vault", "win32"), true);
		assert.equal(core.sameOnDisk("/Vault", "/vault", "darwin"), true);
		assert.equal(core.sameOnDisk("/Vault", "/vault", "linux"), false);
		assert.equal(core.sameOnDisk("/Vault", "/Vault", "linux"), true);
	});
});

describe("a vault's retired instruction files: GEMINI.md only where Gemini reads AGENTS.md (#104)", () => {
	let root = "";
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "core-gemini-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));
	const settings = (text: string) => {
		mkdirSync(join(root, ".gemini"), { recursive: true });
		writeFileSync(join(root, core.GEMINI_SETTINGS), text);
	};
	const fileName = (value: unknown) => settings(JSON.stringify({ context: { fileName: value } }));

	test("no settings: CLAUDE.md is retired, GEMINI.md is Gemini's manual", () => {
		const retired = core.retiredInVault(root, "linux");
		assert.equal(retired(core.CLAUDE_MD), true);
		assert.equal(retired(core.GEMINI_MD), false);
		assert.equal(retired(core.INSTRUCTION_FILE), false);
		assert.deepEqual(core.geminiContextFiles(root), []);
	});

	test("malformed settings, or a directory where the file should be: no context files, GEMINI.md kept", () => {
		settings("{ not json at all");
		assert.deepEqual(core.geminiContextFiles(root), []);
		assert.equal(core.retiredInVault(root, "linux")(core.GEMINI_MD), false);
		rmSync(join(root, ".gemini"), { recursive: true });
		mkdirSync(join(root, core.GEMINI_SETTINGS), { recursive: true });
		assert.deepEqual(core.geminiContextFiles(root), []);
		assert.equal(core.retiredInVault(root, "linux")(core.GEMINI_MD), false);
	});

	test("fileName as a string or a list: GEMINI.md is retired only when AGENTS.md is named and GEMINI.md isn't", () => {
		const cases: [unknown, boolean][] = [
			["AGENTS.md", true],
			[["AGENTS.md"], true],
			[["AGENTS.md", "GEMINI.md"], false],
			["GEMINI.md", false],
			[["NOTES.md"], false],
			[42, false],
			[["AGENTS.md", 7], true],
		];
		for (const [value, retired] of cases) {
			fileName(value);
			assert.equal(core.geminiReadsAgentsMd(root, "linux"), retired, JSON.stringify(value));
			assert.equal(core.retiredInVault(root, "linux")(core.GEMINI_MD), retired, JSON.stringify(value));
			assert.equal(core.retiredInVault(root, "linux")(core.CLAUDE_MD), true, "CLAUDE.md is retired whatever Gemini reads");
		}
		fileName(["AGENTS.md", 7]);
		assert.deepEqual(core.geminiContextFiles(root), ["AGENTS.md"], "non-strings are dropped");
	});

	test("comments, a BOM and CRLF, as Gemini accepts them: the narrow read finds fileName", () => {
		settings('﻿{\r\n  // Gemini reads AGENTS.md\r\n  "context": { "fileName": ["AGENTS.md"] }\r\n}\r\n');
		assert.deepEqual(core.geminiContextFiles(root), ["AGENTS.md"]);
		assert.equal(core.retiredInVault(root, "linux")(core.GEMINI_MD), true);
	});

	test("a commented-out fileName doesn't count: the narrow read skips comments", () => {
		settings('{\n  // was: "fileName": "AGENTS.md"\n  /* "fileName": ["AGENTS.md"] */\n  "context": { "fileName": "GEMINI.md" }\n}\n');
		assert.deepEqual(core.geminiContextFiles(root), ["GEMINI.md"]);
		assert.equal(core.retiredInVault(root, "linux")(core.GEMINI_MD), false);
		settings('{\n  // a comment\n  "$schema": "https://example.com/settings.json",\n  "context": { "fileName": "AGENTS.md" }\n}\n');
		assert.deepEqual(core.geminiContextFiles(root), ["AGENTS.md"], "a // inside a string is no comment");
	});

	test("names match by #91's rule: agents.md names AGENTS.md where the filesystem ignores case", () => {
		fileName("agents.md");
		assert.equal(core.geminiReadsAgentsMd(root, "win32"), true);
		assert.equal(core.geminiReadsAgentsMd(root, "darwin"), true);
		assert.equal(core.geminiReadsAgentsMd(root, "linux"), false);
		fileName(["AGENTS.md", "gemini.md"]);
		assert.equal(core.geminiReadsAgentsMd(root, "win32"), false, "gemini.md still names GEMINI.md there");
		fileName("AGENTS.md");
		assert.equal(core.retiredInVault(root, "win32")("gemini.md"), true);
		assert.equal(core.retiredInVault(root, "linux")("gemini.md"), false);
	});

	test("retiredInVault reads the settings once: its answer holds after the file changes", () => {
		fileName("AGENTS.md");
		const retired = core.retiredInVault(root, "linux");
		rmSync(join(root, ".gemini"), { recursive: true });
		assert.equal(retired(core.GEMINI_MD), true);
	});
});

test("debug, the HOOK_DEBUG trace, is exported to extensions: one home, so traces can't drift (#95)", () => {
	assert.equal(debug, hookDebug);
});
