/**
 * The atomic write on Windows, and its temp file. A virus scanner or the
 * search indexer may hold the temp file for a moment after it is written,
 * and Windows then refuses the rename with EPERM, EACCES or EBUSY: the
 * rename is retried briefly there, bounded by the hook's tight time limit.
 * The temp file is a dotted, randomised sibling, so a killed write never
 * shows in the vault and two module copies never share a name.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { RENAME_RETRY_MS, claimFile, renameWithRetry, tempPathFor } from "../lib/atomic-write.ts";

const err = (code: string) => Object.assign(new Error(code), { code });

describe("renameWithRetry", () => {
	const failing = (codes: string[]) => {
		let calls = 0;
		const rename = () => {
			const code = codes[calls++];
			if (code !== undefined) throw err(code);
		};
		return { rename, calls: () => calls };
	};

	test("on Windows, EPERM, EACCES and EBUSY are retried with a growing wait, then the rename lands", () => {
		const r = failing(["EPERM", "EACCES", "EBUSY"]);
		const slept: number[] = [];
		renameWithRetry("a", "b", { rename: r.rename, platform: "win32", sleep: (ms) => slept.push(ms) });
		assert.equal(r.calls(), 4);
		assert.deepEqual(slept, [10, 20, 40]);
	});

	test("on Windows, a rename that keeps failing throws its last error once the waits reach the bound", () => {
		const r = failing(Array(1000).fill("EPERM"));
		const slept: number[] = [];
		assert.throws(() => renameWithRetry("a", "b", { rename: r.rename, platform: "win32", sleep: (ms) => slept.push(ms) }), { code: "EPERM" });
		const total = slept.reduce((a, b) => a + b, 0);
		assert.ok(total <= RENAME_RETRY_MS, `waited ${total} ms`);
		assert.ok(total > RENAME_RETRY_MS - 100, `gave up early, after ${total} ms`);
		assert.ok(slept.every((ms) => ms <= 100), "no single wait above 100 ms");
		assert.equal(r.calls(), slept.length + 1);
	});

	test("elsewhere, or for any other code, the first error is thrown at once", () => {
		for (const [platform, code] of [["linux", "EPERM"], ["darwin", "EBUSY"], ["win32", "ENOENT"], ["win32", "EISDIR"]] as const) {
			const r = failing([code]);
			const slept: number[] = [];
			assert.throws(() => renameWithRetry("a", "b", { rename: r.rename, platform, sleep: (ms) => slept.push(ms) }), { code });
			assert.equal(r.calls(), 1, `${platform} ${code}`);
			assert.deepEqual(slept, []);
		}
	});

	test("the default sleep really waits", () => {
		const r = failing(["EBUSY"]);
		const started = Date.now();
		renameWithRetry("a", "b", { rename: r.rename, platform: "win32" });
		assert.ok(Date.now() - started >= 9, "waited about 10 ms");
	});
});

describe("tempPathFor", () => {
	test("a dotted sibling of the note, ending .tmp", () => {
		const name = basename(tempPathFor("/vault/notes/note.md"));
		assert.match(name, /^\.note\.md\.\d+-\d+-[0-9a-f]{8}\.tmp$/);
	});

	test("two copies of the module, each counting from 1, never share a name", async () => {
		const other = (await import(`../lib/atomic-write.ts?copy=${Date.now()}`)) as { tempPathFor: (p: string) => string };
		const a = tempPathFor("/v/note.md");
		const b = other.tempPathFor("/v/note.md");
		assert.notEqual(a, b);
	});
});

test("claimFile leaves only the claimed file, its temp file gone", () => {
	const dir = mkdtempSync(join(tmpdir(), "claim-"));
	try {
		const first = claimFile(dir, "a", (n) => (n === 1 ? "note.md" : `note-${n}.md`));
		const second = claimFile(dir, "b", (n) => (n === 1 ? "note.md" : `note-${n}.md`));
		assert.deepEqual([first.name, second.name], ["note.md", "note-2.md"]);
		assert.deepEqual(readdirSync(dir).sort(), ["note-2.md", "note.md"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
