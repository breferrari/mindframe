/**
 * The public entry point (index.ts) carries what it promises extensions.
 * An extension imports only from here, so a helper that is not exported is
 * not available to it, however much of the core uses it.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./index.ts";

describe("writeFileAtomic, through index.ts", () => {
	const dir = mkdtempSync(join(tmpdir(), "core-index-"));
	after(() => rmSync(dir, { recursive: true, force: true }));

	test("writes the whole text, replacing what was there, and leaves no temp file", () => {
		const target = join(dir, "note.md");
		writeFileSync(target, "old");
		const text = "---\ntitle: note\n---\n\nbody ✓\r\n";
		writeFileAtomic(target, text);
		assert.equal(readFileSync(target, "utf-8"), text);
		assert.deepEqual(readdirSync(dir), ["note.md"]);
	});

	test("a write that cannot happen throws and leaves nothing behind", () => {
		assert.throws(() => writeFileAtomic(join(dir, "missing", "note.md"), "x"));
		assert.deepEqual(readdirSync(dir), ["note.md"]);
	});
});
