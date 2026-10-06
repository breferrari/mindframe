// `vendor update`, and the guard on what `patch new --issue` and
// `patch upstream --pr` may post publicly. Real git repos, a stand-in gh.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { main, type Run } from "./cli.ts";
import { contentHash, formatRecord, parseRecord, privateLines, readRecord, statementProblem } from "./vendor.ts";

const LIB = Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i}`).join("\n") + "\n";
const BIN = new Uint8Array([0x89, 0x50, 0x00, 0x01]);
const LIB_PATH = ".claude/scripts/lib.ts";
const BIN_PATH = ".claude/scripts/logo.bin";
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const put = (root: string, rel: string, content: string | Uint8Array): void => {
	const file = path.join(root, ...rel.split("/"));
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
};

function setup(t: TestContext) {
	const root = mkdtempSync(path.join(os.tmpdir(), "mf-update-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const upstream = path.join(root, "upstream");
	const vault = path.join(root, "vault");
	mkdirSync(upstream);
	git(upstream, "init", "-q", "-b", "main");
	git(upstream, "config", "user.email", "t@example.com");
	git(upstream, "config", "user.name", "t");
	git(upstream, "config", "core.autocrlf", "false");
	put(upstream, "core/scripts/lib.ts", LIB);
	put(upstream, "core/scripts/logo.bin", BIN);
	git(upstream, "add", "-A");
	git(upstream, "commit", "-q", "--no-gpg-sign", "-m", "v1");
	const v1 = git(upstream, "rev-parse", "HEAD");
	put(vault, LIB_PATH, LIB);
	put(vault, BIN_PATH, BIN);
	const recFile = path.join(vault, ".claude", "VENDOR.json");
	const h = contentHash(Buffer.from(LIB));
	const hb = contentHash(BIN);
	writeFileSync(
		recFile,
		formatRecord(
			parseRecord({
				schemaVersion: 3,
				repository: "https://github.com/o/upstream",
				commit: v1,
				sourceRoot: "core/scripts",
				license: "MIT",
				files: { [LIB_PATH]: { upstream: "lib.ts", sha256: h, upstreamSha256: h }, [BIN_PATH]: { upstream: "logo.bin", sha256: hb, upstreamSha256: hb } },
			}),
		),
	);
	const calls: string[][] = [];
	const run: Run = (cmd, args, cwd) => {
		if (cmd === "gh") {
			calls.push([...args]);
			return "https://github.com/o/upstream/issues/1";
		}
		return execFileSync(cmd, [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	};
	const lines: string[] = [];
	const cli = (...argv: string[]) => main(argv, (l) => lines.push(l), () => "2026-10-06", run);
	const vaultLib = () => readFileSync(path.join(vault, ...LIB_PATH.split("/")), "utf8");
	const edit = (from: string, to: string) => put(vault, LIB_PATH, vaultLib().replace(from, to));
	/** Commits a new upstream lib and checks the checkout out at it. */
	const upstreamCommit = (text: string, msg = "next") => {
		put(upstream, "core/scripts/lib.ts", text);
		git(upstream, "commit", "-qam", msg, "--no-gpg-sign");
		return git(upstream, "rev-parse", "HEAD");
	};
	const patchFile = (name: string) => readFileSync(path.join(vault, ".claude", "vendor-patches", name), "utf8");
	const at = (...a: string[]) => ["--vault", vault, "--upstream", upstream, ...a];
	const makePatch = (slug: string, from: string, to: string, desc = "Bump a value") => {
		edit(from, to);
		const code = cli("patch", "new", slug, LIB_PATH, ...at("--description", desc, "--not-needed", "local"));
		assert.equal(code, 0, lines.join("\n"));
	};
	// Patches are made against v1; the checkout then moves on.
	return { upstream, vault, recFile, v1, calls, lines, cli, vaultLib, edit, upstreamCommit, patchFile, at, makePatch };
}

test("update: an unpatched file takes the new upstream, binary files raw; the record moves to the new commit", (t) => {
	const s = setup(t);
	const v2text = LIB.replace("v5 = 5", "v5 = 500");
	put(s.upstream, "core/scripts/logo.bin", new Uint8Array([0x89, 0x50, 0x00, 0x02]));
	git(s.upstream, "add", "-A");
	const v2 = s.upstreamCommit(v2text);
	assert.equal(s.cli("update", ...s.at()), 0, s.lines.join("\n"));
	assert.equal(s.vaultLib(), v2text);
	assert.deepEqual([...readFileSync(path.join(s.vault, ...BIN_PATH.split("/")))], [0x89, 0x50, 0x00, 0x02]);
	const r = readRecord(s.recFile);
	assert.equal(r.commit, v2);
	assert.equal(r.files[LIB_PATH]!.upstreamSha256, contentHash(Buffer.from(v2text)));
	assert.equal(s.cli("check", "--vault", s.vault), 0, s.lines.join("\n"));
});

test("update: a patch that still applies is kept, re-anchored to the new line numbers", (t) => {
	const s = setup(t);
	s.makePatch("bump-v15", "v15 = 15", "v15 = 1500");
	// Upstream adds three lines at the top: every hunk moves down.
	const v2 = s.upstreamCommit("// a\n// b\n// c\n" + LIB);
	assert.equal(s.cli("update", ...s.at()), 0, s.lines.join("\n"));
	assert.equal(s.vaultLib(), "// a\n// b\n// c\n" + LIB.replace("v15 = 15", "v15 = 1500"));
	assert.match(s.patchFile("0001-bump-v15.patch"), /@@ -16,7 \+16,7 @@/, "the hunk moved from line 13 to 16");
	assert.deepEqual(readRecord(s.recFile).files[LIB_PATH]!.patches, ["0001-bump-v15.patch"]);
	assert.equal(readRecord(s.recFile).commit, v2);
	assert.equal(s.cli("check", "--vault", s.vault), 0, s.lines.join("\n"));
});

test("update: two patches on one file both re-anchor when upstream moves their lines", (t) => {
	const s = setup(t);
	s.makePatch("bump-v3", "v3 = 3", "v3 = 300");
	s.makePatch("bump-v15", "v15 = 15", "v15 = 1500");
	s.upstreamCommit("// a\n// b\n" + LIB);
	assert.equal(s.cli("update", ...s.at()), 0, s.lines.join("\n"));
	assert.deepEqual(readRecord(s.recFile).files[LIB_PATH]!.patches, ["0001-bump-v3.patch", "0002-bump-v15.patch"]);
	assert.match(s.patchFile("0002-bump-v15.patch"), /@@ -15,7 \+15,7 @@/);
	assert.equal(s.vaultLib(), "// a\n// b\n" + LIB.replace("v3 = 3", "v3 = 300").replace("v15 = 15", "v15 = 1500"));
	assert.equal(s.cli("check", "--vault", s.vault), 0, s.lines.join("\n"));
});

test("update refuses to fold a merge into a patch when a later patch also changes the file", (t) => {
	const s = setup(t);
	s.makePatch("bump-v5", "v5 = 5", "v5 = 500");
	s.makePatch("bump-v15", "v15 = 15", "v15 = 1500");
	// Upstream edits inside the first patch's context, away from its changed line.
	s.upstreamCommit(LIB.replace("v3 = 3", "v3 = 30"));
	assert.equal(s.cli("update", ...s.at()), 1, s.lines.join("\n"));
	assert.match(s.lines.join("\n"), /0001-bump-v5\.patch merged cleanly, but the patches after it \(0002-bump-v15\.patch\) also change it; combine them/);
	assert.equal(s.vaultLib(), LIB.replace("v5 = 5", "v5 = 500").replace("v15 = 15", "v15 = 1500"), "nothing written");
});

test("update: a patch upstream has absorbed retires, with Applied-Upstream (the two-check rule)", (t) => {
	const s = setup(t);
	s.makePatch("bump-v15", "v15 = 15", "v15 = 1500");
	const v2 = s.upstreamCommit(LIB.replace("v15 = 15", "v15 = 1500"), "take the fix");
	assert.equal(s.cli("update", ...s.at()), 0, s.lines.join("\n"));
	assert.match(s.lines.join("\n"), /0001-bump-v15\.patch: upstream has it now; retired/);
	assert.match(s.patchFile("0001-bump-v15.patch"), new RegExp(`^Applied-Upstream: ${v2.slice(0, 7)}$`, "m"));
	assert.equal(readRecord(s.recFile).files[LIB_PATH]!.patches, undefined);
	assert.equal(s.vaultLib(), LIB.replace("v15 = 15", "v15 = 1500"));
	assert.equal(s.cli("check", "--vault", s.vault), 0, "the retired patch stays as history");
});

test("update: one patch absorbed, the other kept", (t) => {
	const s = setup(t);
	s.makePatch("bump-v2", "v2 = 2", "v2 = 200");
	s.makePatch("bump-v17", "v17 = 17", "v17 = 1700");
	s.upstreamCommit(LIB.replace("v2 = 2", "v2 = 200"));
	assert.equal(s.cli("update", ...s.at()), 0, s.lines.join("\n"));
	assert.deepEqual(readRecord(s.recFile).files[LIB_PATH]!.patches, ["0002-bump-v17.patch"]);
	assert.match(s.patchFile("0001-bump-v2.patch"), /^Applied-Upstream: /m);
	assert.equal(s.vaultLib(), LIB.replace("v2 = 2", "v2 = 200").replace("v17 = 17", "v17 = 1700"));
	assert.equal(s.cli("check", "--vault", s.vault), 0, s.lines.join("\n"));
});

test("update: a conflict writes markers into the file, nothing else, and exits 1; --resolved folds the result into the patch", (t) => {
	const s = setup(t);
	s.makePatch("bump-v10", "v10 = 10", "v10 = 1000");
	const before = { record: readFileSync(s.recFile, "utf8"), patch: s.patchFile("0001-bump-v10.patch") };
	s.upstreamCommit(LIB.replace("v10 = 10", "v10 = -10").replace("v19 = 19", "v19 = 190"));
	assert.equal(s.cli("update", ...s.at()), 1, s.lines.join("\n"));
	assert.match(s.lines.join("\n"), /lib\.ts: conflict; resolve the markers, then run update again with --resolved/);
	assert.match(s.vaultLib(), /<<<<<<< vault\nexport const v10 = 1000\n\|\|\|\|\|\|\| base\nexport const v10 = 10\n=======\nexport const v10 = -10\n>>>>>>> upstream/);
	assert.match(s.vaultLib(), /v19 = 190/, "the non-overlapping upstream change merged cleanly");
	assert.equal(readFileSync(s.recFile, "utf8"), before.record, "the record is untouched");
	assert.equal(s.patchFile("0001-bump-v10.patch"), before.patch, "the patch is untouched");
	assert.equal(s.cli("update", ...s.at("--resolved", LIB_PATH)), 1, "markers left in a file named resolved");
	assert.match(s.lines.pop()!, /still has conflict markers/);
	// The person keeps their value on the new upstream.
	put(s.vault, LIB_PATH, LIB.replace("v10 = 10", "v10 = 1000").replace("v19 = 19", "v19 = 190"));
	assert.equal(s.cli("update", ...s.at("--resolved", LIB_PATH)), 0, s.lines.join("\n"));
	assert.deepEqual(readRecord(s.recFile).files[LIB_PATH]!.patches, ["0001-bump-v10.patch"]);
	assert.match(s.patchFile("0001-bump-v10.patch"), /-export const v10 = -10\n\+export const v10 = 1000/);
	assert.equal(s.cli("check", "--vault", s.vault), 0, s.lines.join("\n"));
});

test("update refuses an edit without a patch, a file gone upstream, and a schema-2 record", (t) => {
	const s = setup(t);
	s.upstreamCommit(LIB.replace("v1 = 1", "v1 = 11"));
	s.edit("v4 = 4", "v4 = 44");
	assert.equal(s.cli("update", ...s.at()), 1);
	assert.match(s.lines.join("\n"), /lib\.ts: edited without a patch; run check/);
	s.edit("v4 = 44", "v4 = 4");
	git(s.upstream, "rm", "-q", "core/scripts/logo.bin");
	git(s.upstream, "commit", "-qm", "drop", "--no-gpg-sign");
	assert.equal(s.cli("update", ...s.at()), 1);
	assert.match(s.lines.join("\n"), /logo\.bin: no longer upstream/);
	assert.equal(s.vaultLib(), LIB, "nothing written");
	const r = JSON.parse(readFileSync(s.recFile, "utf8"));
	writeFileSync(s.recFile, JSON.stringify({ ...r, schemaVersion: 2, files: { [LIB_PATH]: { ...r.files[LIB_PATH], modified: false } } }));
	assert.equal(s.cli("update", ...s.at()), 1);
	assert.match(s.lines.pop()!, /run migrate first/);
});

test("privateLines: local absolute paths and session artifacts, not repo paths or mentions", () => {
	for (const bad of ["see C:\\Users\\someone\\vault\\a.md", "at /Users/someone/vault", "in /home/someone/vault", "https://claude.ai/code/session_0123", "Claude-Session: x", "C:/Dev/vault/notes/x.md"]) {
		assert.equal(privateLines(`ok\n${bad}\nok`).length, 1, bad);
	}
	for (const fine of ["core/scripts/lib.ts", "C:\\vault\\note.md", "a `C:\\...` mention", "/Users/... in prose", "Claude-Session: mid-line mention"].slice(0, 4)) {
		assert.equal(privateLines(fine).length, 0, fine);
	}
});

test("statementProblem: the change to make passes; statements and full stops don't", () => {
	assert.equal(statementProblem("Give the meter a trailing newline"), null);
	assert.equal(statementProblem("Fix the budget's off-by-one"), null);
	for (const bad of ["The meter lacks a newline", "It drops a section", "This breaks on Windows", "Give the meter a newline."]) assert.notEqual(statementProblem(bad), null, bad);
});

test("patch new refuses a statement Description, and --issue refuses a diff carrying a local path, before calling gh", (t) => {
	const s = setup(t);
	s.edit("v3 = 3", "v3 = 33");
	assert.equal(s.cli("patch", "new", "x", LIB_PATH, ...s.at("--description", "The value was wrong", "--not-needed", "r")), 1);
	assert.match(s.lines.pop()!, /reads as a statement/);
	s.edit("v3 = 33", "v3 = 33 // see /home/someone/vault/notes");
	assert.equal(s.cli("patch", "new", "x", LIB_PATH, ...s.at("--description", "Bump v3", "--issue")), 1);
	assert.match(s.lines.join("\n"), /the issue would carry a local path[\s\S]*\/home\/someone\/vault/);
	assert.equal(s.calls.length, 0, "nothing posted");
	assert.equal(existsSync(path.join(s.vault, ".claude", "vendor-patches")), false, "nothing written");
});

test("patch upstream --pr refuses a patch carrying a local path, before branching or pushing", (t) => {
	const s = setup(t);
	s.edit("v3 = 3", "v3 = 33 // from C:\\Users\\someone\\vault\\x");
	assert.equal(s.cli("patch", "new", "bump-v3", LIB_PATH, ...s.at("--description", "Bump v3", "--not-needed", "local")), 0, "a local patch may hold it");
	assert.equal(s.cli("patch", "upstream", "0001-bump-v3.patch", ...s.at("--pr")), 1);
	assert.match(s.lines.join("\n"), /the pull request would carry a local path/);
	assert.equal(git(s.upstream, "rev-parse", "--abbrev-ref", "HEAD"), "main", "no branch made");
	assert.equal(s.calls.length, 0);
});
