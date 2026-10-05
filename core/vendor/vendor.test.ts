import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { main } from "./cli.ts";
import { buildRecord, checkRecord, contentHash, formatRecord, isBinary, parseRecord, readRecord, toLf, type VendorRecord } from "./vendor.ts";

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

const LIB = "export const answer = 42\nexport const name = 'lib'\n";
const BIN = new Uint8Array([0x89, 0x50, 0x00, 0x0d, 0x0a, 0x01]);

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
	put(vault, ".claude/scripts/lib.ts", LIB);
	put(vault, ".claude/logo.bin", BIN);
	const base = {
		repository: "https://example.com/upstream",
		license: "MIT",
		files: {
			".claude/scripts/lib.ts": { upstream: "src/lib.ts", modified: false },
			".claude/logo.bin": { upstream: "src/logo.bin", modified: false },
		},
	};
	const record = (paths = Object.keys(base.files), changes?: Record<string, string>, b: object = base): VendorRecord =>
		buildRecord({ vault, upstreamRoot: upstream, commit, base: b as never, paths, changes });
	return { upstream, vault, commit, base, record };
}

test("text hashes with CRLF read as LF; binary hashes raw; binary means a NUL in the first 8 KB", () => {
	const lf = Buffer.from("a\nb\n");
	const crlf = Buffer.from("a\r\nb\r\n");
	assert.equal(contentHash(lf), contentHash(crlf));
	assert.notEqual(contentHash(lf), contentHash(Buffer.from("a\nc\n")));
	assert.deepEqual(Buffer.from(toLf(Buffer.from("a\rb\r\n"))), Buffer.from("a\rb\n"), "a lone CR stays");
	assert.equal(isBinary(BIN), true);
	assert.notEqual(contentHash(BIN), contentHash(toLf(BIN)), "binary bytes are not normalised");
	assert.equal(isBinary(Buffer.concat([Buffer.alloc(8000, 0x61), Buffer.from([0])])), false, "a NUL past 8 KB doesn't count");
	assert.equal(isBinary(Buffer.concat([Buffer.alloc(7999, 0x61), Buffer.from([0])])), true);
});

test("record: an exact copy is unmodified, with equal hashes; keys sorted, trailing newline", (t) => {
	const s = setup(t);
	const r = s.record();
	assert.equal(r.schemaVersion, 2);
	assert.equal(r.commit, s.commit);
	for (const e of Object.values(r.files)) {
		assert.equal(e.modified, false);
		assert.equal(e.sha256, e.upstreamSha256);
		assert.equal(e.change, undefined);
	}
	const text = formatRecord(r);
	assert.ok(text.endsWith("}\n"));
	const keys = Object.keys(JSON.parse(text));
	assert.deepEqual(keys, [...keys].sort());
});

test("record: an edited file needs a change line, and then is modified", (t) => {
	const s = setup(t);
	put(s.vault, ".claude/scripts/lib.ts", LIB + "// local fix\n");
	assert.throws(() => s.record(), /lib\.ts: differs from upstream; give its change/);
	const r = s.record(undefined, { ".claude/scripts/lib.ts": "adds a local fix." });
	const e = r.files[".claude/scripts/lib.ts"]!;
	assert.equal(e.modified, true);
	assert.equal(e.change, "adds a local fix.");
	assert.notEqual(e.sha256, e.upstreamSha256);
});

test("record: a path outside the vault, or through a symlink, is refused", (t) => {
	const s = setup(t);
	assert.throws(() => s.record(["../outside.ts"]), /not a relative path inside the vault/);
	assert.throws(() => s.record(["C:/x.ts"]), /not a relative path inside the vault/);
	put(s.vault, "real/lib.ts", LIB);
	try {
		symlinkSync(path.join(s.vault, "real", "lib.ts"), path.join(s.vault, "link.ts"));
	} catch {
		t.skip("this machine can't create symlinks");
		return;
	}
	assert.throws(() => s.record(["link.ts"]), /symlink/);
});

test("check: an exact copy passes, including a CRLF checkout of it", (t) => {
	const s = setup(t);
	const r = s.record();
	assert.deepEqual(checkRecord(s.vault, r), []);
	put(s.vault, ".claude/scripts/lib.ts", LIB.replace(/\n/g, "\r\n"));
	assert.deepEqual(checkRecord(s.vault, r), [], "core.autocrlf=true must not read as an edit");
});

test("check: a real edit fails, under LF or CRLF", (t) => {
	const s = setup(t);
	const r = s.record();
	put(s.vault, ".claude/scripts/lib.ts", LIB.replace("42", "43"));
	assert.match(checkRecord(s.vault, r)[0]!.problem, /edited without a record/);
	put(s.vault, ".claude/scripts/lib.ts", LIB.replace("42", "43").replace(/\n/g, "\r\n"));
	assert.match(checkRecord(s.vault, r)[0]!.problem, /edited without a record/);
});

test("check: a binary file is compared raw", (t) => {
	const s = setup(t);
	const r = s.record();
	put(s.vault, ".claude/logo.bin", toLf(BIN));
	const p = checkRecord(s.vault, r);
	assert.equal(p.length, 1);
	assert.equal(p[0]!.file, ".claude/logo.bin");
});

test("check: missing files, wrong modified flags, missing or stray change lines", (t) => {
	const s = setup(t);
	const r = s.record();
	rmSync(path.join(s.vault, ".claude", "logo.bin"));
	assert.deepEqual(checkRecord(s.vault, r), [{ file: ".claude/logo.bin", problem: "missing" }]);
	put(s.vault, ".claude/logo.bin", BIN);
	const lie = (patch: object): VendorRecord => ({ ...r, files: { ...r.files, ".claude/scripts/lib.ts": { ...r.files[".claude/scripts/lib.ts"]!, ...patch } } });
	assert.match(checkRecord(s.vault, lie({ modified: true, change: "x" }))[0]!.problem, /modified is true, but its hashes say false/);
	assert.match(checkRecord(s.vault, lie({ change: "x" }))[0]!.problem, /change line on an unmodified file/);
	put(s.vault, ".claude/scripts/lib.ts", LIB + "//x\n");
	const modified = s.record(undefined, { ".claude/scripts/lib.ts": "x." });
	const { change: _, ...noChange } = modified.files[".claude/scripts/lib.ts"]!;
	const problems = checkRecord(s.vault, { ...modified, files: { ...modified.files, ".claude/scripts/lib.ts": noChange } });
	assert.match(problems[0]!.problem, /modified without a change line/);
});

test("check: a vendored file replaced by a symlink fails", (t) => {
	const s = setup(t);
	const r = s.record();
	rmSync(path.join(s.vault, ".claude", "scripts", "lib.ts"));
	put(s.vault, "elsewhere/lib.ts", LIB);
	try {
		symlinkSync(path.join(s.vault, "elsewhere", "lib.ts"), path.join(s.vault, ".claude", "scripts", "lib.ts"));
	} catch {
		t.skip("this machine can't create symlinks");
		return;
	}
	assert.match(checkRecord(s.vault, r)[0]!.problem, /symlink/);
});

test("schema 1 is unverifiable, never a pass; schema 2 is a strict superset of it", (t) => {
	const s = setup(t);
	// A schema-1 record shaped like wiki-mind's and ShardMind's.
	const v1 = { schemaVersion: 1, commit: s.commit, copyright: "Someone", license: "MIT", package: "upstream", repository: "https://example.com/upstream", tag: "v1.0.0", version: "1.0.0", files: s.base.files };
	const p = checkRecord(s.vault, parseRecord(v1));
	assert.equal(p.length, 1);
	assert.match(p[0]!.problem, /unverifiable.*run record/);
	const v2 = s.record(undefined, undefined, parseRecord(v1));
	for (const [k, v] of Object.entries(v1)) if (k !== "schemaVersion" && k !== "files") assert.deepEqual(v2[k], v, `keeps ${k}`);
	for (const [file, e] of Object.entries(v1.files)) {
		const { sha256, upstreamSha256, ...rest } = v2.files[file]!;
		assert.deepEqual(rest, e, `${file} keeps every schema-1 field`);
		assert.match(sha256!, /^[0-9a-f]{64}$/);
		assert.match(upstreamSha256!, /^[0-9a-f]{64}$/);
	}
	assert.throws(() => parseRecord({ ...v2, files: { x: { upstream: "x", modified: false } } }), /sha256 must be/);
});

test("record keeps entries it isn't asked about only when they are already hashed", (t) => {
	const s = setup(t);
	const v1 = { ...s.base, schemaVersion: 1, commit: s.commit };
	assert.throws(() => s.record([".claude/scripts/lib.ts"], undefined, v1), /logo\.bin: in the record without hashes/);
	const full = s.record();
	const again = s.record([".claude/scripts/lib.ts"], undefined, full);
	assert.deepEqual(again.files[".claude/logo.bin"], full.files[".claude/logo.bin"]);
});

test("cli: record from a clean checkout, then check; exit codes 0, 1 and 2", (t) => {
	const s = setup(t);
	const lines: string[] = [];
	const log = (l: string) => lines.push(l);
	put(s.vault, ".claude/VENDOR.json", formatRecord(parseRecord({ ...s.base, schemaVersion: 1, commit: s.commit })));
	assert.equal(main(["check", "--vault", s.vault], log), 1);
	assert.match(lines.pop()!, /unverifiable/);
	assert.equal(main(["record", "--vault", s.vault, "--upstream", s.upstream], log), 0);
	const written = readRecord(path.join(s.vault, ".claude", "VENDOR.json"));
	assert.equal(written.schemaVersion, 2);
	assert.equal(main(["check", "--vault", s.vault], log), 0);
	assert.match(lines.pop()!, /2 files match/);
	put(s.vault, ".claude/scripts/lib.ts", "changed\n");
	assert.equal(main(["check", "--vault", s.vault], log), 1);
	assert.match(lines.pop()!, /lib\.ts: edited without a record/);
	assert.equal(main(["check", "--vault", s.vault, "--bogus"], log), 2);
	assert.equal(main(["nope"], log), 2);
	put(s.upstream, "src/lib.ts", "dirty\n");
	assert.equal(main(["record", "--vault", s.vault, "--upstream", s.upstream], log), 1);
	assert.match(lines.pop()!, /uncommitted changes/);
	assert.equal(readFileSync(path.join(s.vault, ".claude", "VENDOR.json"), "utf8"), formatRecord(written), "a refused record writes nothing");
});
