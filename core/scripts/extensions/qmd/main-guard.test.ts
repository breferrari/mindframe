/**
 * Unit tests for lib/main-guard — detect direct-script invocation vs import.
 *
 * The function compares `fileURLToPath(importMetaUrl)` against `process.argv[1]`.
 * We can't mutate `import.meta.url`, but we can pass a synthetic value and
 * stage `process.argv[1]` to cover the matrix.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { isMainModule } from "./lib/main-guard.ts";
import { hostPath, rmTemp } from "./test-fakes.ts";

const ORIGINAL_ARGV1: string | undefined = process.argv[1];

afterEach(() => {
	// Restore argv so a failing test can't cascade into unrelated ones.
	if (ORIGINAL_ARGV1 === undefined) {
		process.argv.length = 1;
	} else {
		process.argv[1] = ORIGINAL_ARGV1;
	}
});

describe("isMainModule", () => {
	test("true when argv[1] matches the module path", () => {
		const path = hostPath("/Users/dev/scripts/foo.ts");
		process.argv[1] = path;
		assert.equal(isMainModule(pathToFileURL(path).href), true);
	});

	test("false when argv[1] differs from the module path", () => {
		process.argv[1] = hostPath("/Users/dev/scripts/other.ts");
		assert.equal(
			isMainModule(pathToFileURL(hostPath("/Users/dev/scripts/foo.ts")).href),
			false,
		);
	});

	test("false when argv[1] is undefined (node -e or repl)", () => {
		// Truncating argv represents the absent-entry case from node -e / repl
		// without tripping tsc's rejection of `delete` on non-optional indexes.
		process.argv.length = 1;
		assert.equal(
			isMainModule(pathToFileURL(hostPath("/Users/dev/scripts/foo.ts")).href),
			false,
		);
	});

	test("handles URL-encoded segments (spaces in path)", () => {
		const path = hostPath("/Users/dev/my scripts/foo.ts");
		process.argv[1] = path;
		// pathToFileURL encodes the space as %20; isMainModule must decode
		// before comparing against the raw argv path.
		assert.equal(isMainModule(pathToFileURL(path).href), true);
	});
});

// obsidian-mind#391, found on wiki-mind's macOS CI: import.meta.url is the module's real path
// (/private/var/…), while argv[1] is the path as typed (/var/…). A vault under a linked
// folder never ran its guarded main block.
describe("isMainModule through a linked folder (obsidian-mind#391)", () => {
	const linked = () => {
		const root = mkdtempSync(join(tmpdir(), "mf-main-guard-"));
		const real = join(root, "real");
		mkdirSync(real);
		writeFileSync(join(real, "foo.ts"), "");
		writeFileSync(join(real, "other.ts"), "");
		// A junction on Windows needs no privilege; elsewhere the type is ignored and a symlink is made.
		symlinkSync(real, join(root, "link"), "junction");
		return { root, real, link: join(root, "link") };
	};

	test("true when argv[1] reaches the module through a junction or symlink", () => {
		const { root, real, link } = linked();
		try {
			process.argv[1] = join(link, "foo.ts");
			assert.equal(isMainModule(pathToFileURL(join(real, "foo.ts")).href), true);
		} finally {
			rmTemp(root);
		}
	});

	test("false when argv[1] reaches another file through the same link", () => {
		const { root, real, link } = linked();
		try {
			process.argv[1] = join(link, "other.ts");
			assert.equal(isMainModule(pathToFileURL(join(real, "foo.ts")).href), false);
		} finally {
			rmTemp(root);
		}
	});

	test("false when argv[1] doesn't exist", () => {
		const { root, real } = linked();
		try {
			process.argv[1] = join(root, "gone", "foo.ts");
			assert.equal(isMainModule(pathToFileURL(join(real, "foo.ts")).href), false);
		} finally {
			rmTemp(root);
		}
	});
});
