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
import { performance } from "node:perf_hooks";
import { RENAME_RETRY_MS, claimFile, renameWithRetry, retryHeld, tempPathFor } from "../lib/atomic-write.ts";

const err = (code: string) => Object.assign(new Error(code), { code });

/** A clock that moves only when the code under test sleeps, or when a call is said to take time. */
function clock() {
	let t = 0;
	const slept: number[] = [];
	return { slept, now: () => t, sleep: (ms: number) => { slept.push(ms); t += ms; }, spend: (ms: number) => { t += ms; } };
}

/** A call that fails with each code in turn, then succeeds; `cost` is the time each attempt takes. */
function failing(codes: string[], c?: ReturnType<typeof clock>, cost = 0) {
	let calls = 0;
	const op = () => {
		c?.spend(cost);
		const code = codes[calls++];
		if (code !== undefined) throw err(code);
	};
	return { op, calls: () => calls };
}

describe("retryHeld", () => {
	test("on Windows, EPERM, EACCES and EBUSY are retried with a growing wait, then the call lands", () => {
		const c = clock();
		const f = failing(["EPERM", "EACCES", "EBUSY"]);
		retryHeld(f.op, { platform: "win32", sleep: c.sleep, now: c.now });
		assert.equal(f.calls(), 4);
		assert.deepEqual(c.slept, [10, 20, 40]);
	});

	test("a call that keeps failing throws its last error before the deadline, counting the calls' own time", () => {
		for (const cost of [0, 50]) {
			const c = clock();
			const f = failing(Array(1000).fill("EPERM"), c, cost);
			assert.throws(() => retryHeld(f.op, { platform: "win32", sleep: c.sleep, now: c.now }), { code: "EPERM" });
			assert.ok(c.now() <= RENAME_RETRY_MS + cost, `cost ${cost}: ran ${c.now()} ms`);
			assert.ok(c.now() > RENAME_RETRY_MS - 150, `cost ${cost}: gave up early, after ${c.now()} ms`);
			assert.ok(c.slept.every((ms) => ms <= 100), "no single wait above 100 ms");
		}
	});

	test("elsewhere, or for any other code, the first error is thrown at once", () => {
		for (const [platform, code] of [["linux", "EPERM"], ["darwin", "EBUSY"], ["win32", "ENOENT"], ["win32", "EISDIR"]] as const) {
			const c = clock();
			const f = failing([code]);
			assert.throws(() => retryHeld(f.op, { platform, sleep: c.sleep, now: c.now }), { code });
			assert.equal(f.calls(), 1, `${platform} ${code}`);
			assert.deepEqual(c.slept, []);
		}
	});

	test("an error the caller knows will last is thrown at once", () => {
		const c = clock();
		const f = failing(["EPERM"]);
		assert.throws(() => retryHeld(f.op, { platform: "win32", sleep: c.sleep, now: c.now }, () => true), { code: "EPERM" });
		assert.equal(f.calls(), 1);
	});

	test("the default sleep really waits", () => {
		const f = failing(["EBUSY"]);
		const started = performance.now();
		retryHeld(f.op, { platform: "win32" });
		assert.ok(performance.now() - started >= 9, "waited about 10 ms");
	});
});

describe("renameWithRetry", () => {
	test("a folder or a read-only file at the target is a lasting refusal: no retry", () => {
		const targets = [
			{ isDirectory: () => true, mode: 0o40777 },
			{ isDirectory: () => false, mode: 0o100444 },
		];
		for (const target of targets) {
			const c = clock();
			let calls = 0;
			const rename = () => {
				calls++;
				throw err("EPERM");
			};
			assert.throws(() => renameWithRetry("a", "b", { rename, stat: () => target, platform: "win32", sleep: c.sleep, now: c.now }), { code: "EPERM" });
			assert.equal(calls, 1);
		}
	});

	test("a writable file at the target, or none, is retried", () => {
		for (const target of [{ isDirectory: () => false, mode: 0o100666 }, null]) {
			const c = clock();
			let calls = 0;
			const rename = () => {
				if (++calls < 3) throw err("EPERM");
			};
			renameWithRetry("a", "b", { rename, stat: () => target, platform: "win32", sleep: c.sleep, now: c.now });
			assert.equal(calls, 3);
		}
	});
});

describe("tempPathFor", () => {
	test("a dotted sibling of the note, ending .tmp", () => {
		const name = basename(tempPathFor("/vault/notes/note.md"));
		assert.match(name, /^\.note\.md\.\d+-\d+-[0-9a-f]{8}\.tmp$/);
	});

	test("a long note name is cut, so the temp name stays well under 255 bytes", () => {
		const name = basename(tempPathFor(`/v/${"é".repeat(120)}.md`));
		assert.ok(Buffer.byteLength(name) < 120, `${Buffer.byteLength(name)} bytes`);
		assert.match(name, /^\.é+\.\d+-\d+-[0-9a-f]{8}\.tmp$/);
	});

	test("two fresh copies of the module, each counting from 1, never share their first name", async () => {
		type Mod = { tempPathFor: (p: string) => string };
		const one = (await import(`../lib/atomic-write.ts?copy=a${performance.now()}`)) as Mod;
		const two = (await import(`../lib/atomic-write.ts?copy=b${performance.now()}`)) as Mod;
		assert.notEqual(one.tempPathFor("/v/note.md"), two.tempPathFor("/v/note.md"));
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
