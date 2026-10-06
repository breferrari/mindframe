/**
 * The vendor command line.
 *
 *   node --experimental-strip-types core/vendor/cli.ts check   [--vault <dir>] [--record <path>]
 *   node --experimental-strip-types core/vendor/cli.ts record  --upstream <checkout> [--vault <dir>] [--record <path>]
 *        [--set <key>=<value>]... [<path>...]
 *   node --experimental-strip-types core/vendor/cli.ts migrate --upstream <checkout> [--vault <dir>] [--record <path>]
 *
 * `check` exits 0 when every vendored file is exactly upstream plus its
 * recorded patches and every patch says where it went upstream, and 1 with
 * one line per problem otherwise. `record` (re)hashes the given paths, or
 * every path already in the record; the commit is the upstream checkout's
 * HEAD, which must have no uncommitted changes. `migrate` converts a
 * schema-2 record, writing a patch per modified file into `vendor-patches/`
 * beside the record. Exit 2 is a usage error.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
	DEFAULT_RECORD,
	VendorError,
	buildRecord,
	checkRecord,
	formatRecord,
	migrate,
	patchDirFor,
	readPatchDir,
	readRecord,
	resolveInside,
} from "./vendor.ts";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

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
function cleanHead(upstreamRoot: string): string {
	const commit = git(upstreamRoot, ["rev-parse", "HEAD"]);
	if (git(upstreamRoot, ["status", "--porcelain"]) !== "") throw new VendorError("the upstream checkout has uncommitted changes; use a clean checkout");
	return commit;
}

export function main(argv: readonly string[], log: (line: string) => void = console.log, today: () => string = () => new Date().toISOString().slice(0, 10)): number {
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
			const commit = cleanHead(upstreamRoot);
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
			const commit = cleanHead(upstreamRoot);
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

		throw new UsageError(command ? `unknown command ${command}` : "no command: check, record or migrate");
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
