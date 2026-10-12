/**
 * Wikilink extraction + resolution — pure helpers behind the vault's
 * broken-link zero gate (tests/vault-wikilinks.test.ts).
 *
 * Resolution implements the vault's link semantics, deliberately including
 * one assumption beyond stock Obsidian: a `[[target]]` also RESOLVES when
 * some file lists the target in its frontmatter `aliases:`. Alias links
 * are the vault's dominant idiom — `[[obsidian-mind]]` (×144) and
 * `[[ShardMind]]` (×138) point at project READMEs via aliases — and the
 * graph treats them as edges, so the gate must too.
 *
 * Rules:
 *  - Fenced code blocks AND inline code spans are stripped before
 *    extraction — CLAUDE.md and the skills carry literal `[[...]]`
 *    syntax examples that are documentation, not edges.
 *  - `!` embed prefix, `|alias` tails (including the table-escaped `\|`
 *    form), `#heading` and `#^block` fragments are stripped from targets.
 *  - `[[#Heading]]` (same-file anchor) always resolves.
 *  - `{{placeholder}}` targets (templates) and non-note asset targets
 *    (.png, .canvas, …) are ignored — the gate covers note edges only.
 *  - `./` / `../` targets resolve against the source file's directory;
 *    `/`-containing targets also resolve by path suffix (Obsidian
 *    shortest-path semantics, approximated); bare targets resolve by
 *    case-insensitive basename or alias.
 */

const ASSET_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"svg",
	"webp",
	"pdf",
	"canvas",
	"base",
	"excalidraw",
	"html",
	"htm",
	"mp3",
	"mp4",
	"mov",
	"zip",
]);

/**
 * Remove fenced code blocks (``` / ~~~) and inline code spans so literal
 * wikilink examples inside them never count as edges. Fence-aware line
 * scan (not a lazy regex) so an unclosed fence strips to EOF instead of
 * leaking the tail.
 */
export function stripCodeRegions(content: string): string {
	const out: string[] = [];
	let marker = "";
	for (const line of content.split("\n")) {
		const step = fenceStep(line, marker);
		marker = step.marker;
		if (step.fenced) continue;
		out.push(line.replace(INLINE_CODE, ""));
	}
	return out.join("\n");
}

/**
 * Inline code spans: `...` runs, including multi-backtick spans (``…`` —
 * CommonMark closes N backticks with exactly N, and shorter runs are legal
 * INSIDE the span, so ``[[x]]`` and ``code with ` inside`` both match
 * whole). Content charwise forbids starting the same-length run early; the
 * trailing (?!`) pins the closer to an exact-length run.
 */
const INLINE_CODE = /(`+)(?:(?!\1)[^\n])*?\1(?!`)/g;

/** A wikilink or embed, `[[...]]` or `![[...]]`, on one line. */
const WIKILINK = /!?\[\[([^\[\]\n]+?)\]\]/g;

/**
 * One line of the fence scan: whether the line belongs to a fence, and the
 * open fence's marker after it ("" outside one). A ``` or ~~~ line opens a
 * fence, and the next line starting with the same three characters closes
 * it. stripCodeRegions and lineRegions both step through this, so they
 * agree on every line.
 */
function fenceStep(line: string, marker: string): { fenced: boolean; marker: string } {
	const trimmed = line.trimStart();
	if (marker !== "") return { fenced: true, marker: trimmed.startsWith(marker) ? "" : marker };
	if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) return { fenced: true, marker: trimmed.slice(0, 3) };
	return { fenced: false, marker: "" };
}

/** An ATX heading: up to three spaces, one to six #s, then a space, a tab or the end of the line. */
const HEADING = /^ {0,3}#{1,6}([ \t]|$)/;

/** Which part of a note a line is in. */
export type LineRegion = "frontmatter" | "fence" | "heading" | "body";

/**
 * The region of each line of a note, for an extension that rewrites a note
 * line by line. Lines may keep a trailing \r (CRLF split on \n).
 *
 * - Frontmatter is what stripFrontmatter removes: a first line starting
 *   with `---`, to the first line after it that is exactly `---`. A `---`
 *   inside a value doesn't end it, and an unterminated block is no
 *   frontmatter at all.
 * - Fences are the ones stripCodeRegions finds in the note without its
 *   frontmatter, so the links on body and heading lines are exactly
 *   extractWikilinkTargets(stripFrontmatter(note)).
 * - A heading is up to three spaces, one to six #s, then a space, a tab
 *   or the end of the line.
 */
export function lineRegions(lines: readonly string[]): LineRegion[] {
	const bare = lines.map((l) => l.replace(/\r$/, ""));
	// stripFrontmatter's rule, restated for lines. The core holds several
	// copies of the frontmatter rule, and they drift; #82 makes them one.
	const close = bare[0]?.startsWith("---") ? bare.indexOf("---", 1) : -1;
	let marker = "";
	return bare.map((line, i): LineRegion => {
		if (i <= close) return "frontmatter";
		const step = fenceStep(line, marker);
		marker = step.marker;
		if (step.fenced) return "fence";
		return HEADING.test(line) ? "heading" : "body";
	});
}

/** A wikilink on a line: its target as extractWikilinkTargets reads it, and where the whole link sits. */
export type WikilinkSpan = { readonly target: string; readonly start: number; readonly end: number };

/**
 * Every wikilink on one line, with its offsets: `line.slice(start, end)`
 * is the whole link as written, `!` and alias tail included. Links are
 * found after inline code is removed, as stripCodeRegions removes it, so
 * a link extraction reads is a link here too; inline code written inside
 * or between a link's brackets falls inside its span, so replacing the
 * span replaces that code as well. Each target is read as
 * extractWikilinkTargets reads it, so aliases, table escapes, fragments,
 * embeds, assets and placeholders follow its rules: a link it drops has
 * no span. Fences span lines; use lineRegions for them.
 */
export function wikilinkSpans(line: string): WikilinkSpan[] {
	// Remove inline code as stripCodeRegions does, and keep where each kept
	// character came from: links are found in what's left, as extraction
	// finds them (`[[A`x`B]]` reads as AB), and their offsets map back.
	let kept = line;
	let from = (i: number) => i;
	if (line.includes("`")) {
		const at: number[] = [];
		const parts: string[] = [];
		let next = 0;
		for (const code of line.matchAll(INLINE_CODE)) {
			parts.push(line.slice(next, code.index));
			for (let i = next; i < code.index; i++) at.push(i);
			next = code.index + code[0].length;
		}
		parts.push(line.slice(next));
		for (let i = next; i < line.length; i++) at.push(i);
		kept = parts.join("");
		from = (i) => {
			const original = at[i];
			if (original === undefined) throw new Error(`wikilinkSpans: no source offset for ${i}`);
			return original;
		};
	}
	const spans: WikilinkSpan[] = [];
	for (const m of kept.matchAll(WIKILINK)) {
		const target = targetOf(m[1] ?? "");
		if (target !== null) spans.push({ target, start: from(m.index), end: from(m.index + m[0].length - 1) + 1 });
	}
	return spans;
}

/**
 * Extract resolution targets from every `[[...]]` in the content
 * (code regions pre-stripped). Returns raw target strings — alias tails,
 * fragments, and embed prefixes removed; empties/placeholders/assets
 * dropped.
 */
export function extractWikilinkTargets(content: string): string[] {
	const targets: string[] = [];
	for (const m of stripCodeRegions(content).matchAll(WIKILINK)) {
		const target = targetOf(m[1] ?? "");
		if (target !== null) targets.push(target);
	}
	return targets;
}

/** The target inside one `[[...]]`, or null for a link that isn't a note edge. */
function targetOf(inner: string): string | null {
	// Table-escaped alias pipes — both forms Obsidian accepts inside
	// tables: backslash (`[[Target\|alias]]`) and HTML entity
	// (`[[Target&#124;alias]]`). Normalize before splitting so the
	// target doesn't keep a trailing `\` or `&`.
	const normal = inner.replaceAll("\\|", "|").replaceAll("&#124;", "|");
	const target = (normal.split("|")[0] ?? "").split("#")[0]?.trim() ?? "";
	if (target === "") return null; // [[#heading]] / [[|alias]] — same-file
	if (target.includes("{{")) return null; // template placeholder
	const ext = target.includes(".")
		? (target.split(".").pop() ?? "").toLowerCase()
		: "";
	if (ASSET_EXTENSIONS.has(ext)) return null;
	return target;
}

/**
 * Split a YAML inline list's contents on its SEPARATORS.
 *
 * A blind `split(",")` cannot be used here, because a comma inside a quoted
 * scalar is content: `["Smith, John", Nickname]` is two aliases, and splitting
 * it blindly yields three fragments, each carrying a stray quote character —
 * names that match nothing and that nobody could type to work around.
 *
 * Quote state is all this needs to track. A backslash escape is consumed whole
 * inside a double-quoted scalar, and the `''` of a single-quoted scalar is
 * stepped over rather than read as a close, so neither hides a separator or
 * invents one.
 */
function splitInlineList(inner: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i]!;
		if (quote === null) {
			if (ch === '"' || ch === "'") quote = ch;
			else if (ch === ",") {
				out.push(cur);
				cur = "";
				continue;
			}
		} else if (ch === "\\" && quote === '"' && i + 1 < inner.length) {
			cur += ch + inner[++i]!;
			continue;
		} else if (ch === quote) {
			if (quote === "'" && inner[i + 1] === "'") {
				cur += "''";
				i++;
				continue;
			}
			quote = null;
		}
		cur += ch;
	}
	out.push(cur);
	return out;
}

/**
 * Minimal frontmatter `aliases:` reader — YAML block list and inline
 * `[a, b]` forms, quoted or bare. Returns [] when absent/malformed.
 *
 * "Minimal" is bounded by ownership. `parseFrontmatter` in memory-recall may
 * accept a small subset because this repo writes every file it reads; these
 * aliases come from USER notes, written by Obsidian, by hand, by templates and
 * by other agents, so the shapes below are ordinary input rather than
 * malformed input — and against a zero gate, a shape this misreads costs the
 * whole check, not one link.
 */
export function extractAliases(content: string): string[] {
	if (!content.startsWith("---")) return [];
	// CRLF first, and before anything indexes or matches. Obsidian-on-Windows
	// rewrites LF to CRLF on edit (the reason .gitattributes normalizes), and
	// `.` does not match CR — it is a line terminator — while `$` without `m`
	// anchors past it. The block-list item pattern therefore failed on item
	// ONE of every CRLF note, and `break` read that as an empty list, so the
	// file's whole alias set went missing with nothing to distinguish it from
	// a note that declares none.
	const text = content.replace(/\r\n/g, "\n");
	const end = text.indexOf("\n---", 3);
	if (end === -1) return [];
	const fm = text.slice(3, end);
	const lines = fm.split("\n");
	const idx = lines.findIndex((l) => /^aliases:\s*(\[.*\])?\s*$/.test(l.trim()) || /^aliases:\s*\[/.test(l.trim()));
	if (idx === -1) return [];
	const head = lines[idx]?.trim() ?? "";
	// Undo the quoting rather than merely removing the quote marks — the two
	// differ on exactly the values that need it. A YAML single-quoted scalar
	// escapes an apostrophe by DOUBLING it, so `'the writer''s two facts'`
	// stripped charwise yields an alias no link can ever cite. Any writer
	// emitting YAML quotes a value containing an apostrophe, and aliases are
	// commonly the note's own title, so this is a steady fraction of generated
	// notes rather than an edge case — and against a zero gate one false
	// positive turns the whole check red.
	//
	// The two styles need SEPARATE rules because they escape differently, not
	// because only one escapes: single-quoted doubles the apostrophe, and
	// double-quoted uses a backslash. Passing the double-quoted form through
	// charwise left `"the \"good\" parts"` as an alias carrying literal
	// backslashes, which is the same defect the single-quoted branch was fixed
	// for and reaches the gate the same way.
	//
	// Only `\\` and `\"` are undone. YAML's double-quoted form also defines
	// `\n`, `\t`, `\/` and `\uXXXX`, which do not occur in a note title at any
	// rate worth carrying a decoder for; each one added is a rule that has to
	// stay correct forever. This matches `unquoteScalar` in
	// `lib/mcp-memory-bridge.ts`, which is the copy that already reasons about
	// escaping, so the two agree rather than drifting.
	const unquote = (s: string): string => {
		const t = s.trim();
		if (t.length < 2) return t; // a lone `'` starts and ends with itself
		if (t.startsWith('"') && t.endsWith('"')) {
			// Left to right, so `\\"` yields a backslash and then ends the scalar
			// rather than treating the escaped backslash's quote as escaped.
			return t.slice(1, -1).replace(/\\(["\\])/g, "$1");
		}
		if (t.startsWith("'") && t.endsWith("'")) {
			return t.slice(1, -1).replaceAll("''", "'");
		}
		return t;
	};
	// A trailing `# comment` is ordinary YAML. Without tolerating it the exact
	// match failed, the reader fell through to the block branch, found no
	// indented items, and reported the list as empty.
	const inline = head.match(/^aliases:\s*\[(.*)\]\s*(?:#.*)?$/);
	if (inline) {
		return splitInlineList(inline[1] ?? "")
			.map(unquote)
			.filter((s) => s !== "");
	}
	const out: string[] = [];
	for (let i = idx + 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const item = line.match(/^\s+-\s+(.*)$/);
		if (!item) {
			// A blank line or a comment between entries is legal YAML and the
			// sequence continues past it; only a line that is neither ends it.
			// Stopping on them truncated the list at the first one.
			if (line.trim() === "" || line.trim().startsWith("#")) continue;
			break; // end of the block list
		}
		const value = unquote(item[1] ?? "");
		if (value !== "") out.push(value);
	}
	return out;
}

const stripMdExt = (p: string): string => p.replace(/\.md$/i, "");

/** POSIX-normalize `dir/../x` style paths; returns null when escaping root. */
function normalizeRelative(path: string): string | null {
	const parts: string[] = [];
	for (const seg of path.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (parts.length === 0) return null;
			parts.pop();
			continue;
		}
		parts.push(seg);
	}
	return parts.join("/");
}

export type Resolver = (target: string, sourceRelPath: string) => boolean;

/**
 * Build a resolver over the vault's file set.
 *
 * @param files vault-relative POSIX paths of every .md file (target set)
 * @param aliasesByFile frontmatter aliases per file (same path keys)
 */
export function buildResolver(
	files: readonly string[],
	aliasesByFile: ReadonlyMap<string, readonly string[]>,
): Resolver {
	const pathSet = new Set(files.map((f) => stripMdExt(f).toLowerCase()));
	const basenames = new Set(
		files.map((f) => {
			const base = f.split("/").pop() ?? f;
			return stripMdExt(base).toLowerCase();
		}),
	);
	const aliases = new Set(
		[...aliasesByFile.values()].flat().map((a) => a.toLowerCase()),
	);

	return (target: string, sourceRelPath: string): boolean => {
		const clean = stripMdExt(target.replace(/\\/g, "/")).toLowerCase();

		// Source-relative (./ or ../) — resolve against the source's dir.
		if (clean.startsWith("./") || clean.startsWith("../")) {
			const sourceDir = sourceRelPath
				.replace(/\\/g, "/")
				.toLowerCase()
				.split("/")
				.slice(0, -1)
				.join("/");
			const resolved = normalizeRelative(
				sourceDir === "" ? clean : `${sourceDir}/${clean}`,
			);
			return resolved !== null && pathSet.has(resolved);
		}

		// Path-form target — exact vault path or unambiguous suffix.
		if (clean.includes("/")) {
			if (pathSet.has(clean)) return true;
			for (const p of pathSet) {
				if (p.endsWith(`/${clean}`)) return true;
			}
			return false;
		}

		// Bare name — basename or alias.
		return basenames.has(clean) || aliases.has(clean);
	};
}
