/**
 * Where a note's frontmatter is: the core's one rule, which every reader that
 * looks for frontmatter goes through (#82). The guide is what Obsidian reads as
 * a note's properties.
 *
 * - The first line is `---`, after an optional byte order mark: a note an
 *   editor saved with a BOM still has its properties.
 * - The block closes at the first later line that is `---`. A `---` inside a
 *   value, or a `----` line, doesn't close it.
 * - A delimiter line may end in `\r`, spaces or tabs (inferred: YAML's document
 *   marker allows trailing whitespace; Obsidian's own parser couldn't be read).
 *   So a CRLF note whose closing `---\r` has no final newline still closes.
 * - A block that never closes is no frontmatter at all.
 * - A first line of `----` or `---x` opens nothing.
 */

/** A delimiter line: `---`, then at most spaces, tabs or a `\r`. */
const DELIMITER = /^---[ \t\r]*$/;

/** The byte order mark an editor may put before the first line. */
const BOM = "﻿";

/**
 * The frontmatter in a list of lines (split on `\n`, so a line may keep its
 * `\r`): the index of the opening and the closing delimiter, or null when the
 * note has none.
 */
export function frontmatterLines(lines: readonly string[]): { readonly open: 0; readonly close: number } | null {
	const first = lines[0];
	if (first === undefined || !DELIMITER.test(first.startsWith(BOM) ? first.slice(1) : first)) return null;
	for (let i = 1; i < lines.length; i++) if (DELIMITER.test(lines[i] ?? "")) return { open: 0, close: i };
	return null;
}

/**
 * The frontmatter in a note's text: its yaml (the lines between the delimiters,
 * each without its `\r`, joined by `\n`), and the offset where the body starts,
 * just past the closing line's newline. Null when the note has none.
 */
export function frontmatterBlock(content: string): { readonly yaml: string; readonly body: number } | null {
	const lines = content.split("\n");
	const span = frontmatterLines(lines);
	if (span === null) return null;
	const yaml = lines
		.slice(1, span.close)
		.map((l) => l.replace(/\r$/, ""))
		.join("\n");
	let body = 0;
	for (let i = 0; i <= span.close; i++) body += (lines[i] ?? "").length + 1;
	return { yaml, body: Math.min(body, content.length) };
}
