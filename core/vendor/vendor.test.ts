import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { main } from "./cli.ts";
import { diffFile, formatPatch } from "./patch.ts";
import {
	buildRecord,
	checkRecord,
	contentHash,
	forwardedProblem,
	formatRecord,
	isBinary,
	migrate,
	parseRecord,
	readPatchDir,
	readRecord,
	slugOf,
	toLf,
	type VendorRecord,
} from "./vendor.ts";

const tmp = (t: TestContext): string => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "mf-vendor-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};
const put = (root: string, rel: string, content: string | Uint8Array): void => {
	const file = path.join(root, ...rel.split("/"));
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
};
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const LIB = "export const answer = 42\nexport const name = 'lib'\nexport const tail = true\n";
const FIXED = LIB.replace("42", "43");
const BIN = new Uint8Array([0x89, 0x50, 0x00, 0x0d, 0x0a, 0x01]);
const LIB_PATH = ".claude/scripts/lib.ts";

/** An upstream repo at one commit, and a vault holding an exact copy of its two files. */
function setup(t: TestContext) {
	const root = tmp(t);
	const upstream = path.join(root, "upstream");
	const vault = path.join(root, "vault");
	mkdirSync(upstream);
	git(upstream, "init", "-q");
	git(upstream, "config", "user.email", "t@example.com");
	git(upstream, "config", "user.name", "t");
	git(upstream, "config", "core.autocrlf", "false");
	put(upstream, "src/lib.ts", LIB);
	put(upstream, "src/logo.bin", BIN);
	git(upstream, "add", "-A");
	git(upstream, "commit", "-q", "--no-gpg-sign", "-m", "up");
	const commit = git(upstream, "rev-parse", "HEAD");
	put(vault, LIB_PATH, LIB);
	put(vault, ".claude/logo.bin", BIN);
	const base = {
		repository: "https://example.com/upstream",
		license: "MIT",
		files: {
			[LIB_PATH]: { upstream: "src/lib.ts" },
			".claude/logo.bin": { upstream: "src/logo.bin" },
		},
	};
	const patchDir = path.join(vault, ".claude", "vendor-patches");
	const record = (b: object = base, paths = Object.keys(base.files)): VendorRecord =>
		buildRecord({ vault, upstreamRoot: upstream, commit, base: b as never, paths, patches: readPatchDir(patchDir) });
	/** Edits the vault's lib and writes a patch for it; returns the patch name. */
	const patchLib = (forwarded: string, name = "0001-lib.patch", extra: Array<[string, string]> = []): string => {
		put(vault, LIB_PATH, FIXED);
		put(patchDir, name, formatPatch({ header: [["Description", "fix the answer"], ["Forwarded", forwarded], ...extra], files: [diffFile(LIB_PATH, LIB, FIXED)!] }));
		return name;
	};
	const withPatches = (names: string[]) => ({ ...base, files: { ...base.files, [LIB_PATH]: { upstream: "src/lib.ts", patches: names } } });
	const check = (r: VendorRecord) => checkRecord(vault, r, readPatchDir(patchDir)).map((p) => p.problem);
	return { upstream, vault, commit, base, record, patchDir, patchLib, withPatches, check };
}

test("hashes: text with CRLF read as LF, binary raw; binary is a NUL in the first 8,000 bytes", () => {
	assert.equal(contentHash(Buffer.from("a\nb\n")), contentHash(Buffer.from("a\r\nb\r\n")));
	assert.deepEqual(Buffer.from(toLf(Buffer.from("a\rb\r\n"))), Buffer.from("a\rb\n"), "a lone CR stays");
	assert.equal(isBinary(BIN), true);
	assert.notEqual(contentHash(BIN), contentHash(toLf(BIN)));
	assert.equal(isBinary(Buffer.concat([Buffer.alloc(8000, 0x61), Buffer.from([0])])), false);
	assert.equal(isBinary(Buffer.concat([Buffer.alloc(7999, 0x61), Buffer.from([0])])), true);
});

test("Forwarded: a URL or not-needed with a reason; nothing else, and never empty", () => {
	assert.equal(forwardedProblem("https://github.com/o/r/issues/1"), null);
	assert.equal(forwardedProblem("not-needed: this vault only"), null);
	for (const bad of [undefined, "", "  ", "later", "not-needed:", "not-needed: ", "no", "ftp://x"]) assert.notEqual(forwardedProblem(bad), null, String(bad));
});

test("record: an exact copy has no patches and equal hashes; schema 3, keys sorted", (t) => {
	const s = setup(t);
	const r = s.record();
	assert.equal(r.schemaVersion, 3);
	for (const e of Object.values(r.files)) {
		assert.equal(e.sha256, e.upstreamSha256);
		assert.equal(e.patches, undefined);
		assert.ok(!("modified" in e) && !("change" in e));
	}
	const keys = Object.keys(JSON.parse(formatRecord(r)));
	assert.deepEqual(keys, [...keys].sort());
});

test("record: a file that differs from upstream without patches is refused, pointing at patch new", (t) => {
	const s = setup(t);
	put(s.vault, LIB_PATH, FIXED);
	assert.throws(() => s.record(), /lib\.ts: differs from upstream; make the change a patch with `vendor patch new`/);
});

test("record: a patched file is kept when its patches lead exactly back to upstream", (t) => {
	const s = setup(t);
	const name = s.patchLib("not-needed: test");
	const r = s.record(s.withPatches([name]));
	assert.deepEqual(r.files[LIB_PATH]!.patches, [name]);
	assert.notEqual(r.files[LIB_PATH]!.sha256, r.files[LIB_PATH]!.upstreamSha256);
	put(s.vault, LIB_PATH, FIXED + "// more\n");
	assert.throws(() => s.record(s.withPatches([name])), /hunk|lead back/);
});

test("check: an exact copy passes, including a CRLF checkout of it", (t) => {
	const s = setup(t);
	const r = s.record();
	assert.deepEqual(s.check(r), []);
	put(s.vault, LIB_PATH, LIB.replace(/\n/g, "\r\n"));
	assert.deepEqual(s.check(r), []);
});

test("check: an edit without a patch fails, under LF or CRLF; a binary file compares raw", (t) => {
	const s = setup(t);
	const r = s.record();
	put(s.vault, LIB_PATH, FIXED);
	assert.deepEqual(s.check(r), ["edited without a patch (bytes differ from sha256)"]);
	put(s.vault, LIB_PATH, FIXED.replace(/\n/g, "\r\n"));
	assert.deepEqual(s.check(r), ["edited without a patch (bytes differ from sha256)"]);
	put(s.vault, LIB_PATH, LIB);
	put(s.vault, ".claude/logo.bin", toLf(BIN));
	assert.deepEqual(s.check(r), ["edited without a patch (bytes differ from sha256)"]);
});

test("check: a patched file passes when its patch is forwarded, under LF and CRLF", (t) => {
	const s = setup(t);
	const name = s.patchLib("https://github.com/o/r/pull/7");
	const r = s.record(s.withPatches([name]));
	assert.deepEqual(s.check(r), []);
	put(s.vault, LIB_PATH, FIXED.replace(/\n/g, "\r\n"));
	assert.deepEqual(s.check(r), [], "a CRLF checkout of a patched file");
});

test("check: Forwarded and Description are required, and Forwarded must be a URL or not-needed", (t) => {
	const s = setup(t);
	const name = s.patchLib("https://x/1");
	const r = s.record(s.withPatches([name]));
	const rewrite = (header: Array<[string, string]>) => put(s.patchDir, name, formatPatch({ header, files: [diffFile(LIB_PATH, LIB, FIXED)!] }));
	rewrite([["Description", "d"], ["Forwarded", ""]]);
	assert.match(s.check(r).join("\n"), /Forwarded is empty/);
	rewrite([["Description", "d"], ["Forwarded", "later"]]);
	assert.match(s.check(r).join("\n"), /Forwarded is "later"/);
	rewrite([["Forwarded", "not-needed: local only"]]);
	assert.match(s.check(r).join("\n"), /Description is missing/);
	rewrite([["Description", "d"], ["Forwarded", "not-needed: local only"]]);
	assert.deepEqual(s.check(r), []);
});

test("check: an orphan patch, a listed patch that is missing, and an unparseable patch all fail", (t) => {
	const s = setup(t);
	const name = s.patchLib("https://x/1");
	const r = s.record(s.withPatches([name]));
	put(s.patchDir, "0002-stray.patch", formatPatch({ header: [["Description", "d"], ["Forwarded", "https://x/2"]], files: [diffFile("other.ts", "a\n", "b\n")!] }));
	assert.match(s.check(r).join("\n"), /0002-stray\.patch: in vendor-patches\/ but no file lists it/);
	rmSync(path.join(s.patchDir, "0002-stray.patch"));
	put(s.patchDir, "0003-broken.patch", "not a patch\n");
	assert.match(s.check(r).join("\n"), /0003-broken\.patch: header line 1/);
	rmSync(path.join(s.patchDir, "0003-broken.patch"));
	rmSync(path.join(s.patchDir, name));
	const problems = s.check(r).join("\n");
	assert.match(problems, /0001-lib\.patch: listed in the record but not in vendor-patches\//);
	assert.match(problems, /0001-lib\.patch is missing/);
});

test("check: patches that don't lead back to upstream fail, even when sha256 was updated to match", (t) => {
	const s = setup(t);
	const name = s.patchLib("https://x/1");
	const r = s.record(s.withPatches([name]));
	// Someone edits the patched file again and re-hashes it by hand.
	const sneaky = FIXED.replace("tail = true", "tail = false");
	put(s.vault, LIB_PATH, sneaky);
	const forged = { ...r, files: { ...r.files, [LIB_PATH]: { ...r.files[LIB_PATH]!, sha256: contentHash(Buffer.from(sneaky)) } } } as VendorRecord;
	assert.match(s.check(forged).join("\n"), /hunk 1 doesn't match|lead back/);
});

test("check: a patch that changes a file which doesn't list it fails", (t) => {
	const s = setup(t);
	const name = s.patchLib("https://x/1");
	const r = s.record(s.withPatches([name]));
	const two = formatPatch({ header: [["Description", "d"], ["Forwarded", "https://x/1"]], files: [diffFile(LIB_PATH, LIB, FIXED)!, diffFile(".claude/other.ts", "a\n", "b\n")!] });
	put(s.patchDir, name, two);
	assert.match(s.check(r).join("\n"), /changes \.claude\/other\.ts, which doesn't list it/);
});

test("check: a retired patch may stay in the folder unlisted, but not stay listed", (t) => {
	const s = setup(t);
	const name = s.patchLib("https://x/1", "0001-lib.patch", [["Applied-Upstream", "abc1234"]]);
	put(s.vault, LIB_PATH, LIB);
	assert.deepEqual(s.check(s.record()), [], "retired and unlisted: history, not an orphan");
	put(s.vault, LIB_PATH, FIXED);
	const listed = s.record(s.withPatches([name]));
	assert.match(s.check(listed).join("\n"), /marked Applied-Upstream but still listed/);
});

test("check: missing files and symlinks fail; schema 1 is unverifiable; schema 2 must migrate", (t) => {
	const s = setup(t);
	const r = s.record();
	rmSync(path.join(s.vault, ".claude", "logo.bin"));
	assert.deepEqual(s.check(r), ["missing"]);
	put(s.vault, ".claude/logo.bin", BIN);
	assert.match(s.check({ ...r, schemaVersion: 1 } as VendorRecord)[0]!, /unverifiable/);
	assert.match(s.check({ ...r, schemaVersion: 2 } as VendorRecord)[0]!, /run migrate/);
	rmSync(path.join(s.vault, ".claude", "scripts", "lib.ts"));
	put(s.vault, "elsewhere/lib.ts", LIB);
	try {
		symlinkSync(path.join(s.vault, "elsewhere", "lib.ts"), path.join(s.vault, ".claude", "scripts", "lib.ts"));
	} catch {
		t.skip("this machine can't create symlinks");
		return;
	}
	assert.match(s.check(r)[0]!, /symlink/);
});

test("parseRecord: schema 3 has patches, never modified or change; patch names are NNNN-slug.patch", (t) => {
	const s = setup(t);
	const r = s.record();
	const lib = r.files[LIB_PATH]!;
	assert.throws(() => parseRecord({ ...r, files: { [LIB_PATH]: { ...lib, modified: true } } }), /not modified or change/);
	assert.throws(() => parseRecord({ ...r, files: { [LIB_PATH]: { ...lib, patches: ["fix.patch"] } } }), /patch file names/);
	assert.throws(() => parseRecord({ ...r, files: { [LIB_PATH]: { ...lib, patches: ["0001-a.patch", "0001-a.patch"] } } }), /listed twice/);
	assert.equal(parseRecord({ ...r, files: { [LIB_PATH]: { ...lib, patches: ["0001-fix-the-answer.patch"] } } }).schemaVersion, 3);
});

/** A schema-2 record over the setup's vault: lib modified with a change line, logo unmodified. */
function schema2(s: ReturnType<typeof setup>): VendorRecord {
	put(s.vault, LIB_PATH, FIXED);
	const h = (rel: string) => contentHash(readFileSync(path.join(s.vault, ...rel.split("/"))));
	return parseRecord({
		schemaVersion: 2,
		repository: "https://example.com/upstream",
		commit: s.commit,
		license: "MIT",
		files: {
			[LIB_PATH]: { upstream: "src/lib.ts", modified: true, change: "the answer is 43 here.", sha256: h(LIB_PATH), upstreamSha256: contentHash(Buffer.from(LIB)) },
			".claude/logo.bin": { upstream: "src/logo.bin", modified: false, sha256: h(".claude/logo.bin"), upstreamSha256: contentHash(BIN) },
		},
	});
}

test("migrate: each modified file becomes one patch, Description from change, Forwarded empty on purpose", (t) => {
	const s = setup(t);
	const { record, patches } = migrate({ vault: s.vault, upstreamRoot: s.upstream, record: schema2(s), existing: ["0003-older.patch"], today: "2026-10-06" });
	assert.equal(record.schemaVersion, 3);
	assert.equal(patches.length, 1);
	assert.equal(patches[0]!.name, "0004-lib.patch", "numbering continues after what's there");
	assert.match(patches[0]!.text, /^Description: the answer is 43 here\.\nForwarded: \nLast-Update: 2026-10-06\n/);
	assert.deepEqual(record.files[LIB_PATH]!.patches, ["0004-lib.patch"]);
	assert.equal(record.files[".claude/logo.bin"]!.patches, undefined);
	for (const e of Object.values(record.files)) assert.ok(!("modified" in e) && !("change" in e));
	// check fails on the empty Forwarded until it is filled.
	put(s.patchDir, patches[0]!.name, patches[0]!.text);
	assert.match(s.check(record).join("\n"), /0004-lib\.patch: Forwarded is empty/);
	put(s.patchDir, patches[0]!.name, patches[0]!.text.replace("Forwarded: \n", "Forwarded: https://github.com/o/r/issues/9\n"));
	assert.deepEqual(s.check(record), []);
});

test("migrate: refuses schema 1 and an upstream that isn't at the recorded commit", (t) => {
	const s = setup(t);
	const v2 = schema2(s);
	assert.throws(() => migrate({ vault: s.vault, upstreamRoot: s.upstream, record: { ...v2, schemaVersion: 1 } as VendorRecord, existing: [], today: "x" }), /run record first/);
	put(s.upstream, "src/lib.ts", "moved on\n");
	assert.throws(() => migrate({ vault: s.vault, upstreamRoot: s.upstream, record: v2, existing: [], today: "x" }), /isn't at the recorded commit/);
});

test("slugOf: the file name, lowercased, dashes for anything else", () => {
	assert.equal(slugOf(".claude/scripts/lib/session-start.ts"), "session-start");
	assert.equal(slugOf("README.md"), "readme");
	assert.equal(slugOf("x/Weird Name!!.ts"), "weird-name");
});

test("cli: record, check, migrate end to end; exit codes 0, 1 and 2", (t) => {
	const s = setup(t);
	const lines: string[] = [];
	const log = (l: string) => lines.push(l);
	const rec = path.join(s.vault, ".claude", "VENDOR.json");
	// A schema-2 record with a modified file must migrate before record.
	writeFileSync(rec, formatRecord(schema2(s)));
	assert.equal(main(["record", "--vault", s.vault, "--upstream", s.upstream], log), 1);
	assert.match(lines.pop()!, /run migrate first/);
	assert.equal(main(["check", "--vault", s.vault], log), 1);
	assert.match(lines.pop()!, /run migrate/);
	assert.equal(main(["migrate", "--vault", s.vault, "--upstream", s.upstream], log, () => "2026-10-06"), 0);
	assert.match(lines.join("\n"), /migrated .* with 1 patch/);
	assert.equal(main(["check", "--vault", s.vault], log), 1, "Forwarded is still empty");
	const patchFile = path.join(s.patchDir, "0001-lib.patch");
	writeFileSync(patchFile, readFileSync(patchFile, "utf8").replace("Forwarded: \n", "Forwarded: not-needed: test fixture\n"));
	assert.equal(main(["check", "--vault", s.vault], log), 0);
	assert.match(lines.pop()!, /2 files are upstream plus patches \(1 patched\)/);
	assert.equal(main(["record", "--vault", s.vault, "--upstream", s.upstream], log), 0, "re-record keeps the patched file");
	assert.deepEqual(readRecord(rec).files[LIB_PATH]!.patches, ["0001-lib.patch"]);
	assert.equal(main(["check", "--vault", s.vault, "--bogus"], log), 2);
	assert.equal(main(["nope"], log), 2);
	put(s.upstream, "src/lib.ts", "dirty\n");
	assert.equal(main(["migrate", "--vault", s.vault, "--upstream", s.upstream], log), 1);
	assert.match(lines.pop()!, /uncommitted changes/);
});

test("check: a forged record fails either way, whether or not the patch still applies", (t) => {
	const s = setup(t);
	// A longer file, so an edit can sit far from the patch's hunk.
	const long = Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i}`).join("\n") + "\n";
	const fixedLong = long.replace("v1 = 1", "v1 = 100");
	put(s.upstream, "src/lib.ts", long);
	git(s.upstream, "commit", "-qam", "long", "--no-gpg-sign");
	const commit = git(s.upstream, "rev-parse", "HEAD");
	put(s.vault, LIB_PATH, fixedLong);
	put(s.patchDir, "0001-lib.patch", formatPatch({ header: [["Description", "d"], ["Forwarded", "https://x/1"]], files: [diffFile(LIB_PATH, long, fixedLong)!] }));
	const r = buildRecord({ vault: s.vault, upstreamRoot: s.upstream, commit, base: s.withPatches(["0001-lib.patch"]) as never, paths: [LIB_PATH, ".claude/logo.bin"], patches: readPatchDir(s.patchDir) });
	assert.deepEqual(checkRecord(s.vault, r, readPatchDir(s.patchDir)), []);
	// A second edit far from the hunk, and sha256 forged to match: the patch still undoes cleanly, but not to upstream.
	const sneaky = fixedLong.replace("v18 = 18", "v18 = -1");
	put(s.vault, LIB_PATH, sneaky);
	const forged = { ...r, files: { [LIB_PATH]: { ...r.files[LIB_PATH]!, sha256: contentHash(Buffer.from(sneaky)) } } } as VendorRecord;
	assert.deepEqual(checkRecord(s.vault, forged, readPatchDir(s.patchDir)).map((p) => p.problem), ["its patches don't lead back to upstream"]);
	// The same forgery on a file that lists no patch at all.
	const bare = { ...r, files: { [LIB_PATH]: { upstream: "src/lib.ts", sha256: contentHash(Buffer.from(sneaky)), upstreamSha256: r.files[LIB_PATH]!.upstreamSha256 } } } as VendorRecord;
	rmSync(path.join(s.patchDir, "0001-lib.patch"));
	assert.deepEqual(checkRecord(s.vault, bare, readPatchDir(s.patchDir)).map((p) => p.problem), ["differs from upstream with no patch to explain it"]);
});
