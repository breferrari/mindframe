// `vendor patch begin`, `vendor patch new` and `vendor patch upstream`, end to end against real
// git repos (an upstream with a bare remote as its origin) and a stand-in
// for gh, so nothing here touches GitHub.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { main, prTitle, type Run } from "./cli.ts";
import { decide } from "../scripts/vendor-guard.ts";
import { contentHash, formatRecord, parseRecord, readRecord } from "./vendor.ts";

const LIB = Array.from({ length: 12 }, (_, i) => `export const v${i} = ${i}`).join("\n") + "\n";
const LIB_PATH = ".claude/scripts/lib.ts";
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const put = (root: string, rel: string, content: string): void => {
	const file = path.join(root, ...rel.split("/"));
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
};

function setup(t: TestContext) {
	const root = mkdtempSync(path.join(os.tmpdir(), "mf-patch-cmd-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const remote = path.join(root, "remote.git");
	const upstream = path.join(root, "upstream");
	const vault = path.join(root, "vault");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
	mkdirSync(upstream);
	git(upstream, "init", "-q", "-b", "main");
	git(upstream, "config", "user.email", "t@example.com");
	git(upstream, "config", "user.name", "t");
	git(upstream, "config", "core.autocrlf", "false");
	git(upstream, "remote", "add", "origin", remote);
	put(upstream, "core/scripts/lib.ts", LIB);
	git(upstream, "add", "-A");
	git(upstream, "commit", "-q", "--no-gpg-sign", "-m", "up");
	git(upstream, "push", "-q", "origin", "main");
	put(vault, LIB_PATH, LIB);

	const calls: string[][] = [];
	let ghOut = "https://github.com/o/upstream/issues/12";
	let ghFails = false;
	const run: Run = (cmd, args, cwd) => {
		if (cmd === "gh") {
			calls.push([...args]);
			if (ghFails) throw new Error("gh: not logged in");
			return `Creating…\n${ghOut}`;
		}
		return execFileSync(cmd, [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	};
	const lines: string[] = [];
	const cli = (...argv: string[]) => main(argv, (l) => lines.push(l), () => "2026-10-06", run);
	// A schema-3 record over the vault: lib.ts under sourceRoot core/scripts upstream.
	const recFile = path.join(vault, ".claude", "VENDOR.json");
	const h = contentHash(Buffer.from(LIB));
	writeFileSync(
		recFile,
		formatRecord(
			parseRecord({
				schemaVersion: 3,
				repository: "https://github.com/o/upstream",
				commit: git(upstream, "rev-parse", "HEAD"),
				sourceRoot: "core/scripts",
				license: "MIT",
				files: { [LIB_PATH]: { upstream: "lib.ts", sha256: h, upstreamSha256: h } },
			}),
		),
	);

	const patchDir = path.join(vault, ".claude", "vendor-patches");
	const edit = (from: string, to: string) => put(vault, LIB_PATH, readFileSync(path.join(vault, ...LIB_PATH.split("/")), "utf8").replace(from, to));
	const state = () => ({ record: readFileSync(recFile, "utf8"), patches: existsSync(patchDir) ? readdirSync(patchDir) : [] });
	return {
		upstream, vault, remote, calls, lines, cli, edit, patchDir, recFile, state,
		setGh: (out: string, fails = false) => { ghOut = out; ghFails = fails; },
		up: (...a: string[]) => ["--vault", vault, "--upstream", upstream, ...a],
	};
}

test("prTitle: the Description, lowercased first, as a fix: title", () => {
	assert.equal(prTitle("Give the meter a trailing newline."), "fix: give the meter a trailing newline");
});

test("patch new --not-needed: writes the next patch, lists it, and check passes", (t) => {
	const s = setup(t);
	s.edit("v3 = 3", "v3 = 33");
	assert.equal(s.cli("patch", "new", "bump-v3", LIB_PATH, ...s.up("--description", "Bump v3 for this vault", "--not-needed", "only this vault wants it")), 0, s.lines.join("\n"));
	const text = readFileSync(path.join(s.patchDir, "0001-bump-v3.patch"), "utf8");
	assert.match(text, /^Description: Bump v3 for this vault\nForwarded: not-needed: only this vault wants it\nLast-Update: 2026-10-06\n\ndiff --git a\/\.claude\/scripts\/lib\.ts/);
	assert.deepEqual(readRecord(s.recFile).files[LIB_PATH]!.patches, ["0001-bump-v3.patch"]);
	assert.equal(s.cli("check", "--vault", s.vault), 0, s.lines.join("\n"));
	assert.equal(s.calls.length, 0, "no gh call without --issue");
});

test("patch begin lets the guard allow edits to vendored files, refuses others, and patch new ends it", (t) => {
	const s = setup(t);
	const editCall = { tool_name: "Edit", tool_input: { file_path: path.join(s.vault, ...LIB_PATH.split("/")) } };
	assert.notEqual(decide(editCall, s.vault, Date.now()), null, "guarded before begin");
	assert.equal(s.cli("patch", "begin", "--vault", s.vault), 2, "needs files");
	assert.equal(s.cli("patch", "begin", "notes/a.md", "--vault", s.vault), 1);
	assert.match(s.lines.join("\n"), /notes\/a\.md: not a vendored file/);
	assert.equal(s.cli("patch", "begin", LIB_PATH, "--vault", s.vault), 0, s.lines.join("\n"));
	assert.equal(decide(editCall, s.vault, Date.now()), null, "allowed after begin");
	s.edit("v3 = 3", "v3 = 33");
	assert.equal(s.cli("patch", "new", "bump-v3", LIB_PATH, ...s.up("--description", "Bump v3 for this vault", "--not-needed", "local")), 0, s.lines.join("\n"));
	assert.notEqual(decide(editCall, s.vault, Date.now()), null, "guarded again once the patch is made");
});

test("patch new needs exactly one upstream answer and a description", (t) => {
	const s = setup(t);
	s.edit("v3 = 3", "v3 = 33");
	const before = s.state();
	assert.equal(s.cli("patch", "new", "x", LIB_PATH, ...s.up("--description", "d")), 2, "no route");
	assert.match(s.lines.pop()!, /exactly one of --forward <url>, --issue, or --not-needed/);
	assert.equal(s.cli("patch", "new", "x", LIB_PATH, ...s.up("--description", "d", "--issue", "--not-needed", "r")), 2, "two routes");
	assert.equal(s.cli("patch", "new", "x", LIB_PATH, ...s.up("--not-needed", "r")), 2, "no description");
	assert.equal(s.cli("patch", "new", "x", LIB_PATH, ...s.up("--description", "d", "--forward", "later")), 1, "a forward that isn't a URL");
	assert.match(s.lines.pop()!, /Forwarded is "later"/);
	assert.deepEqual(s.state(), before, "nothing written");
});

test("patch new --issue files the issue first, titled by the Description, and records its URL", (t) => {
	const s = setup(t);
	s.edit("v3 = 3", "v3 = 33");
	assert.equal(s.cli("patch", "new", "bump-v3", LIB_PATH, ...s.up("--description", "Bump v3 to 33", "--issue")), 0, s.lines.join("\n"));
	assert.equal(s.calls.length, 1);
	const args = s.calls[0]!;
	assert.deepEqual(args.slice(0, 6), ["issue", "create", "--repo", "o/upstream", "--title", "Bump v3 to 33"]);
	assert.match(args[7]!, /```diff\ndiff --git a\/\.claude\/scripts\/lib\.ts[\s\S]*\+export const v3 = 33\n[\s\S]*```\n$/);
	assert.match(readFileSync(path.join(s.patchDir, "0001-bump-v3.patch"), "utf8"), /^Forwarded: https:\/\/github\.com\/o\/upstream\/issues\/12$/m);
	assert.equal(s.cli("check", "--vault", s.vault), 0);
});

test("patch new files nothing upstream when the patch can't be made, and writes nothing when gh fails", (t) => {
	const s = setup(t);
	const before = s.state();
	assert.equal(s.cli("patch", "new", "nothing", LIB_PATH, ...s.up("--description", "d", "--issue")), 1, "no change to make a patch of");
	assert.match(s.lines.join("\n"), /no change to make a patch of/);
	assert.equal(s.calls.length, 0, "no issue filed for a patch that can't exist");
	s.edit("v3 = 3", "v3 = 33");
	s.setGh("", true);
	assert.throws(() => s.cli("patch", "new", "bump-v3", LIB_PATH, ...s.up("--description", "d", "--issue")), /not logged in/);
	assert.deepEqual(s.state().patches, before.patches, "no patch written");
	assert.equal(s.state().record, before.record, "record unchanged");
});

test("patch new refuses a file outside the record, and an upstream checkout at another commit", (t) => {
	const s = setup(t);
	put(s.vault, ".claude/other.ts", "x\n");
	assert.equal(s.cli("patch", "new", "x", ".claude/other.ts", ...s.up("--description", "d", "--not-needed", "r")), 1);
	assert.match(s.lines.join("\n"), /not in the record/);
	put(s.upstream, "core/scripts/new.ts", "n\n");
	git(s.upstream, "add", "-A");
	git(s.upstream, "commit", "-q", "--no-gpg-sign", "-m", "later");
	s.edit("v3 = 3", "v3 = 33");
	assert.equal(s.cli("patch", "new", "x", LIB_PATH, ...s.up("--description", "d", "--not-needed", "r")), 1);
	assert.match(s.lines.pop()!, /isn't at the record's commit/);
});

test("a second patch stacks on the first, and check takes both off", (t) => {
	const s = setup(t);
	s.edit("v3 = 3", "v3 = 33");
	assert.equal(s.cli("patch", "new", "bump-v3", LIB_PATH, ...s.up("--description", "Bump v3", "--not-needed", "local")), 0);
	s.edit("v10 = 10", "v10 = 1010");
	assert.equal(s.cli("patch", "new", "bump-v10", LIB_PATH, ...s.up("--description", "Bump v10", "--forward", "https://github.com/o/upstream/pull/3")), 0, s.lines.join("\n"));
	assert.deepEqual(readRecord(s.recFile).files[LIB_PATH]!.patches, ["0001-bump-v3.patch", "0002-bump-v10.patch"]);
	assert.doesNotMatch(readFileSync(path.join(s.patchDir, "0002-bump-v10.patch"), "utf8"), /v3 = 33/, "the second patch holds only its own change");
	assert.equal(s.cli("check", "--vault", s.vault), 0, s.lines.join("\n"));
});

test("patch upstream commits the patch on its own branch in the upstream checkout", (t) => {
	const s = setup(t);
	s.edit("v3 = 3", "v3 = 33");
	s.cli("patch", "new", "bump-v3", LIB_PATH, ...s.up("--description", "Bump v3 to 33", "--issue"));
	assert.equal(s.cli("patch", "upstream", "0001-bump-v3.patch", ...s.up()), 0, s.lines.join("\n"));
	assert.equal(git(s.upstream, "rev-parse", "--abbrev-ref", "HEAD"), "vendor-patch/0001-bump-v3");
	assert.equal(git(s.upstream, "log", "-1", "--format=%s"), "Bump v3 to 33");
	assert.match(readFileSync(path.join(s.upstream, "core", "scripts", "lib.ts"), "utf8"), /v3 = 33/);
	assert.equal(s.calls.length, 1, "no PR without --pr");
	assert.equal(git(s.remote, "branch", "--list", "vendor-patch/*"), "", "nothing pushed without --pr");
});

test("patch upstream --pr pushes, opens the PR closing the issue, and points Forwarded at it", (t) => {
	const s = setup(t);
	s.edit("v3 = 3", "v3 = 33");
	s.cli("patch", "new", "bump-v3", LIB_PATH, ...s.up("--description", "Bump v3 to 33", "--issue"));
	s.setGh("https://github.com/o/upstream/pull/13");
	assert.equal(s.cli("patch", "upstream", "0001-bump-v3.patch", ...s.up("--pr")), 0, s.lines.join("\n"));
	assert.match(git(s.remote, "branch", "--list", "vendor-patch/*"), /vendor-patch\/0001-bump-v3/, "pushed to origin");
	const pr = s.calls[1]!;
	assert.deepEqual(pr.slice(0, 11), ["pr", "create", "--repo", "o/upstream", "--head", "vendor-patch/0001-bump-v3", "--base", "main", "--title", "fix: bump v3 to 33", "--body"]);
	assert.match(pr[11]!, /Closes https:\/\/github\.com\/o\/upstream\/issues\/12/);
	const text = readFileSync(path.join(s.patchDir, "0001-bump-v3.patch"), "utf8");
	assert.match(text, /^Forwarded: https:\/\/github\.com\/o\/upstream\/pull\/13$/m);
	assert.match(text, /^Origin: https:\/\/github\.com\/o\/upstream\/issues\/12$/m, "the issue is kept as Origin");
	assert.equal(s.cli("check", "--vault", s.vault), 0, "the patch still checks");
});

test("patch upstream refuses a patch that no longer applies, and changes nothing", (t) => {
	const s = setup(t);
	s.edit("v3 = 3", "v3 = 33");
	s.cli("patch", "new", "bump-v3", LIB_PATH, ...s.up("--description", "d", "--not-needed", "r"));
	put(s.upstream, "core/scripts/lib.ts", LIB.replace("v3 = 3", "v3 = 300"));
	git(s.upstream, "commit", "-qam", "moved", "--no-gpg-sign");
	assert.equal(s.cli("patch", "upstream", "0001-bump-v3.patch", ...s.up("--pr")), 1);
	assert.match(s.lines.join("\n"), /doesn't apply to the upstream checkout/);
	assert.equal(git(s.upstream, "rev-parse", "--abbrev-ref", "HEAD"), "main", "no branch made");
	assert.equal(s.calls.length, 0);
});
