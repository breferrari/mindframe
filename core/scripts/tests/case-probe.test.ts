/**
 * The case rule is the vault root's filesystem's, probed, not the platform's
 * guess (#112): WSL on an NTFS mount reports linux but ignores case, and a
 * case-sensitive APFS volume reports darwin but doesn't. The probe stats the
 * vault marker under a case-swapped spelling; the platform stays the
 * fallback where it can't tell.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, type statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../core/index.ts";
import { VAULT_MARKER } from "../lib/project-dir.ts";

type Stat = typeof statSync;

/** A stat seam: `files` maps a path's base name to its inode; anything else is missing. */
function fakeStat(files: Record<string, bigint>, calls: string[] = []): Stat {
	return ((path: string) => {
		calls.push(path);
		const name = path.split(/[\\/]/).at(-1) ?? "";
		const ino = files[name];
		return ino === undefined ? undefined : { dev: 1n, ino };
	}) as unknown as Stat;
}

const SWAPPED = VAULT_MARKER.toUpperCase();

function vault(t: { after: (fn: () => void) => void }, marker = true): string {
	const root = mkdtempSync(join(tmpdir(), "case-probe-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	if (marker) writeFileSync(join(root, VAULT_MARKER), "{}\n");
	return root;
}

describe("probing the vault root's filesystem for case (#112)", () => {
	test("the swapped spelling opens the marker itself: the filesystem ignores case", () => {
		assert.equal(core.probeIgnoresCase("/v", fakeStat({ [VAULT_MARKER]: 7n, [SWAPPED]: 7n })), true);
	});

	test("the swapped spelling is missing, or is a different file: case matters", () => {
		assert.equal(core.probeIgnoresCase("/v", fakeStat({ [VAULT_MARKER]: 7n })), false);
		assert.equal(core.probeIgnoresCase("/v", fakeStat({ [VAULT_MARKER]: 7n, [SWAPPED]: 8n })), false);
	});

	test("a filesystem with no inodes (0) and both spellings present ignores case", () => {
		assert.equal(core.probeIgnoresCase("/v", fakeStat({ [VAULT_MARKER]: 0n, [SWAPPED]: 0n })), true);
	});

	test("no marker, or a stat that throws: the probe can't tell", () => {
		assert.equal(core.probeIgnoresCase("/v", fakeStat({})), null);
		const throws = (() => {
			throw Object.assign(new Error("EACCES"), { code: "EACCES" });
		}) as unknown as Stat;
		assert.equal(core.probeIgnoresCase("/v", throws), null);
	});

	test("the real probe agrees with whether the swapped spelling opens, on every OS", (t) => {
		const root = vault(t);
		assert.equal(core.probeIgnoresCase(root), existsSync(join(root, SWAPPED)));
	});

	test("the vault's rule is the probe's; the platform is only the fallback", (t) => {
		assert.equal(core.vaultIgnoresCase(vault(t), "linux", fakeStat({ [VAULT_MARKER]: 1n, [SWAPPED]: 1n })), true, "WSL on NTFS");
		assert.equal(core.vaultIgnoresCase(vault(t), "darwin", fakeStat({ [VAULT_MARKER]: 1n })), false, "case-sensitive APFS");
		assert.equal(core.vaultIgnoresCase(vault(t), "win32", fakeStat({})), true, "can't tell: the platform's rule");
		assert.equal(core.vaultIgnoresCase(vault(t), "linux", fakeStat({})), false);
	});

	test("the probe runs at most once per vault per process", (t) => {
		const root = vault(t);
		const calls: string[] = [];
		const stat = fakeStat({ [VAULT_MARKER]: 1n, [SWAPPED]: 1n }, calls);
		assert.equal(core.vaultIgnoresCase(root, "linux", stat), true);
		assert.equal(core.vaultIgnoresCase(root, "linux", stat), true);
		assert.equal(calls.length, 2, "the marker and its swapped spelling, once");
	});

	test("done when: on a case-insensitive folder under linux, retiredInVault finds claude.md", (t) => {
		const root = vault(t);
		assert.equal(core.retiredInVault(root, "linux", true)("claude.md"), true);
		assert.equal(core.retiredInVault(root, "linux", false)("claude.md"), false);
		// On the real disk: wherever this runner's temp folder ignores case (Windows, macOS), so does the check.
		assert.equal(core.retiredInVault(root, "linux")("claude.md"), existsSync(join(root, SWAPPED)));
	});

	test("Gemini's settings names match by the vault's rule too", (t) => {
		const root = vault(t);
		mkdirSync(join(root, ".gemini"));
		writeFileSync(join(root, core.GEMINI_SETTINGS), JSON.stringify({ context: { fileName: "agents.md" } }));
		// agents.md names AGENTS.md exactly where the vault's filesystem ignores case, whatever the platform says.
		assert.equal(core.geminiReadsAgentsMd(root, "linux"), existsSync(join(root, SWAPPED)));
	});
});
