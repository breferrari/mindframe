/**
 * The vendor command line.
 *
 *   node --experimental-strip-types core/vendor/cli.ts check   [--vault <dir>] [--record <path>]
 *   node --experimental-strip-types core/vendor/cli.ts record  --upstream <checkout> [--vault <dir>] [--record <path>]
 *        [--set <key>=<value>]... [<path>...]
 *   node --experimental-strip-types core/vendor/cli.ts migrate --upstream <checkout> [--vault <dir>] [--record <path>]
 *   node --experimental-strip-types core/vendor/cli.ts patch new <slug> <file>... --upstream <checkout>
 *        --description "<the change to make>" (--forward <url> | --issue | --not-needed "<reason>")
 *   node --experimental-strip-types core/vendor/cli.ts patch upstream <NNNN-slug.patch> --upstream <checkout> [--pr] [--base <branch>]
 *
 * `check` exits 0 when every vendored file is exactly upstream plus its
 * recorded patches and every patch says where it went upstream, and 1 with
 * one line per problem otherwise. `record` (re)hashes the given paths, or
 * every path already in the record; the commit is the upstream checkout's
 * HEAD, which must have no uncommitted changes. `migrate` converts a
 * schema-2 record, writing a patch per modified file into `vendor-patches/`
 * beside the record.
 *
 * `patch new` turns local edits to vendored files into the next patch, and
 * won't write one without an upstream answer: a URL it is given, an issue it
 * files with gh (--issue; the Description is the issue's title, so write it
 * as the change to make), or a reason the change isn't needed upstream.
 * `patch upstream` applies a patch on a new branch in the upstream checkout
 * and commits it; with --pr it pushes the branch, opens the pull request, and
 * writes its URL into the patch's Forwarded.
 *
 * Every vault option takes --vault and --record. Exit 2 is a usage error.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { applyFile, formatPatch } from "./patch.ts";
import {
	DEFAULT_RECORD,
	PATCH_NAME,
	VendorError,
	buildRecord,
	checkRecord,
	formatRecord,
	headerOf,
	migrate,
	newPatch,
	patchDirFor,
	readPatchDir,
	readRecord,
	repoSlug,
	resolveInside,
	upstreamPathOf,
	withHeader,
} from "./vendor.ts";

/** Runs a program and returns its trimmed stdout; tests pass a stand-in for gh. */
export type Run = (cmd: string, args: readonly string[], cwd: string) => string;
const realRun: Run = (cmd, args, cwd) => execFileSync(cmd, [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

class UsageError extends Error {}

function pairs(list: readonly string[] | undefined, flag: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const item of list ?? []) {
		const at = item.indexOf("=");
		if (at <= 0) throw new UsageError(`${flag} takes <key>=<value>, got ${item}`);
		out[item.slice(0, at)] = item.slice(at + 1);
	}
	return out;
}

/** The upstream checkout's HEAD, refusing one with uncommitted changes. */
function cleanHead(run: Run, upstreamRoot: string): string {
	const commit = run("git", ["rev-parse", "HEAD"], upstreamRoot);
	if (run("git", ["status", "--porcelain"], upstreamRoot) !== "") throw new VendorError("the upstream checkout has uncommitted changes; use a clean checkout");
	return commit;
}

/** The last line of a command's output: gh prints the new issue's or PR's URL last. */
const lastLine = (out: string): string => out.split("\n").pop()!.trim();

/** "Give the meter a newline." as a PR title: "fix: give the meter a newline". */
export const prTitle = (description: string): string => `fix: ${description.charAt(0).toLowerCase()}${description.slice(1).replace(/\.$/, "")}`;

export function main(
	argv: readonly string[],
	log: (line: string) => void = console.log,
	today: () => string = () => new Date().toISOString().slice(0, 10),
	run: Run = realRun,
): number {
	const [command, ...rest] = argv;
	try {
		const { values, positionals } = parseArgs({
			args: [...rest],
			allowPositionals: true,
			options: {
				vault: { type: "string", default: "." },
				record: { type: "string", default: DEFAULT_RECORD },
				upstream: { type: "string" },
				set: { type: "string", multiple: true },
				description: { type: "string" },
				forward: { type: "string" },
				issue: { type: "boolean", default: false },
				"not-needed": { type: "string" },
				pr: { type: "boolean", default: false },
				base: { type: "string" },
			},
		});
		const vault = path.resolve(values.vault!);
		const recordFile = resolveInside(vault, values.record!);
		const patchDir = patchDirFor(recordFile);

		if (command === "check") {
			if (!existsSync(recordFile)) {
				log(`vendor: no record at ${values.record}`);
				return 1;
			}
			const record = readRecord(recordFile);
			const problems = checkRecord(vault, record, readPatchDir(patchDir));
			for (const p of problems) log(`vendor: ${p.file === null ? "" : `${p.file}: `}${p.problem}`);
			if (problems.length === 0) {
				const patched = Object.values(record.files).filter((f) => (f.patches ?? []).length > 0).length;
				log(`vendor: ${Object.keys(record.files).length} files are upstream${patched ? ` plus patches (${patched} patched)` : ""}, per ${values.record} (${record.repository} at ${record.commit.slice(0, 7)})`);
			}
			return problems.length === 0 ? 0 : 1;
		}

		if (command === "record") {
			if (!values.upstream) throw new UsageError("record needs --upstream <checkout>");
			const upstreamRoot = path.resolve(values.upstream);
			const commit = cleanHead(run, upstreamRoot);
			const existing = existsSync(recordFile) ? readRecord(recordFile) : null;
			if (existing && existing.schemaVersion === 2 && Object.values(existing.files).some((f) => f.modified)) {
				throw new VendorError("this schema-2 record has modified files; run migrate first, so each change becomes a patch");
			}
			const set = pairs(values.set, "--set");
			for (const k of ["schemaVersion", "commit", "files"]) if (k in set) throw new UsageError(`--set cannot set ${k}`);
			const base = { ...(existing ?? {}), ...set } as Parameters<typeof buildRecord>[0]["base"];
			if (typeof base.repository !== "string") throw new UsageError("a new record needs --set repository=<url>");
			const paths = positionals.length ? positionals : Object.keys(existing?.files ?? {});
			if (paths.length === 0) throw new UsageError("record needs paths, or an existing record to re-record");
			const record = buildRecord({ vault, upstreamRoot, commit, base, paths, patches: readPatchDir(patchDir) });
			writeFileSync(recordFile, formatRecord(record));
			log(`vendor: recorded ${Object.keys(record.files).length} files from ${record.repository} at ${commit.slice(0, 7)}`);
			return 0;
		}

		if (command === "migrate") {
			if (!values.upstream) throw new UsageError("migrate needs --upstream <checkout> at the record's commit");
			const upstreamRoot = path.resolve(values.upstream);
			const record = readRecord(recordFile);
			const commit = cleanHead(run, upstreamRoot);
			if (commit !== record.commit) throw new VendorError(`the upstream checkout is at ${commit.slice(0, 7)}, not the record's ${record.commit.slice(0, 7)}`);
			const existing = [...readPatchDir(patchDir).keys()];
			const { record: next, patches } = migrate({ vault, upstreamRoot, record, existing, today: today() });
			if (patches.length) mkdirSync(patchDir, { recursive: true });
			for (const p of patches) writeFileSync(path.join(patchDir, p.name), p.text);
			writeFileSync(recordFile, formatRecord(next));
			log(`vendor: migrated ${values.record} to schema 3 with ${patches.length} patch${patches.length === 1 ? "" : "es"}`);
			for (const p of patches) log(`vendor: ${p.name}: fill in Forwarded (the upstream issue or PR URL, or not-needed: <reason>); check fails until you do`);
			return 0;
		}

		if (command === "patch") {
			const [sub, ...args] = positionals;
			if (sub !== "new" && sub !== "upstream") throw new UsageError("patch takes new or upstream");
			if (!values.upstream) throw new UsageError(`patch ${sub} needs --upstream <checkout>`);
			const upstreamRoot = path.resolve(values.upstream);
			const record = readRecord(recordFile);
			const patches = readPatchDir(patchDir);

			if (sub === "new") {
				const [slug, ...files] = args;
				if (!slug || files.length === 0) throw new UsageError("patch new needs a slug and the files it changes");
				const routes = [values.forward !== undefined, values.issue === true, values["not-needed"] !== undefined].filter(Boolean).length;
				if (routes !== 1) throw new UsageError('patch new needs exactly one of --forward <url>, --issue, or --not-needed "<reason>": a patch is made with its upstream answer');
				const description = values.description?.trim();
				if (!description) throw new UsageError('patch new needs --description "<the change to make>"');
				if (cleanHead(run, upstreamRoot) !== record.commit) throw new VendorError(`the upstream checkout isn't at the record's commit ${record.commit.slice(0, 7)}`);
				const header = (forwarded: string): Array<[string, string]> => [
					["Description", description],
					["Forwarded", forwarded],
					["Last-Update", today()],
				];
				// Everything is checked with a placeholder before anything is filed upstream.
				const dry = newPatch({ vault, upstreamRoot, record, patches, slug, files, header: header("not-needed: placeholder") });
				let forwarded = values.forward ?? `not-needed: ${values["not-needed"] ?? ""}`;
				if (values.issue) {
					const diff = dry.text.slice(dry.text.indexOf("diff --git"));
					const fence = "```";
					const body = `A vault that vendors this repository carries this change as a patch.\n\n${fence}diff\n${diff}${fence}\n`;
					forwarded = lastLine(run("gh", ["issue", "create", "--repo", repoSlug(record.repository), "--title", description, "--body", body], vault));
				}
				const made = newPatch({ vault, upstreamRoot, record, patches, slug, files, header: header(forwarded) });
				mkdirSync(patchDir, { recursive: true });
				writeFileSync(path.join(patchDir, made.name), made.text);
				writeFileSync(recordFile, formatRecord(made.record));
				log(`vendor: wrote ${made.name} (Forwarded: ${forwarded})`);
				return 0;
			}

			// patch upstream
			const [name] = args;
			if (!name || !PATCH_NAME.test(name)) throw new UsageError("patch upstream needs a patch file name, like 0001-fix-the-thing.patch");
			const entry = patches.get(name);
			if (!entry?.patch) throw new VendorError(`${name}: ${entry?.error ?? "not in vendor-patches/"}`);
			const patch = entry.patch;
			cleanHead(run, upstreamRoot);
			const description = headerOf(patch, "Description") ?? name;
			const base = values.base ?? run("git", ["rev-parse", "--abbrev-ref", "HEAD"], upstreamRoot);
			const branch = `vendor-patch/${name.replace(/\.patch$/, "")}`;
			// Every file is applied first, so a patch that no longer fits changes nothing.
			const writes: Array<[string, string]> = [];
			for (const f of patch.files) {
				const target = resolveInside(upstreamRoot, upstreamPathOf(record, f.path));
				try {
					writes.push([target, applyFile(readFileSync(target, "utf8"), f)]);
				} catch (err) {
					throw new VendorError(`${name} doesn't apply to the upstream checkout: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			run("git", ["checkout", "-q", "-b", branch], upstreamRoot);
			for (const [target, text] of writes) writeFileSync(target, text);
			run("git", ["add", "-A"], upstreamRoot);
			run("git", ["commit", "-q", "-m", description], upstreamRoot);
			if (!values.pr) {
				log(`vendor: committed ${name} on ${branch} in the upstream checkout; push it, or rerun with --pr`);
				return 0;
			}
			run("git", ["push", "-q", "-u", "origin", branch], upstreamRoot);
			const previous = headerOf(patch, "Forwarded") ?? "";
			const closes = /\/issues\/\d+$/.test(previous) ? `\n\nCloses ${previous}` : "";
			const body = `${description}\n\nThis change was carried downstream as a vendored patch (${name}).${closes}\n`;
			const url = lastLine(run("gh", ["pr", "create", "--repo", repoSlug(record.repository), "--head", branch, "--base", base, "--title", prTitle(description), "--body", body], upstreamRoot));
			let updated = withHeader(patch, "Forwarded", url);
			if (closes && headerOf(patch, "Origin") === undefined) updated = withHeader(updated, "Origin", previous);
			writeFileSync(path.join(patchDir, name), formatPatch(updated));
			log(`vendor: opened ${url} for ${name}; Forwarded now points at it`);
			return 0;
		}

		throw new UsageError(command ? `unknown command ${command}` : "no command: check, record, migrate or patch");
	} catch (err) {
		const code = (err as { code?: unknown }).code;
		if (err instanceof UsageError || (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS"))) {
			log(`vendor: ${(err as Error).message}`);
			return 2;
		}
		if (err instanceof VendorError) {
			for (const line of err.message.split("\n")) log(`vendor: ${line}`);
			return 1;
		}
		throw err;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = main(process.argv.slice(2));
}
