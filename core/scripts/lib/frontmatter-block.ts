/**
 * Where a note's frontmatter is: the core's one rule, which every reader that
 * looks for frontmatter goes through (#82). It follows what Obsidian reads as a
 * note's properties.
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
const BOM = "\uFEFF";

/**
 * The frontmatter in a list of lines (split on `\n`, so a line may keep its
 * `\r`): the index of the closing delimiter (the opener is line 0), or null when
 * the note has none.
 */
export function frontmatterLines(lines: readonly string[]): { readonly close: number } | null {
	const first = lines[0];
	if (first === undefined || !DELIMITER.test(first.startsWith(BOM) ? first.slice(1) : first)) return null;
	for (let i = 1; i < lines.length; i++) if (DELIMITER.test(lines[i] ?? "")) return { close: i };
	return null;
}

/**
 * The frontmatter in a note's text: its yaml (the lines between the delimiters,
 * each without its `\r`, joined by `\n`), and the offset where the body starts,
 * just past the closing line's newline. Null when the note has none. It reads
 * only as far as the closing line.
 */
export function frontmatterBlock(content: string): { readonly yaml: string; readonly body: number } | null {
	const lineAt = (start: number): { text: string; next: number } => {
		const end = content.indexOf("\n", start);
		return end === -1 ? { text: content.slice(start), next: content.length } : { text: content.slice(start, end), next: end + 1 };
	};
	const opener = lineAt(0);
	if (!DELIMITER.test(opener.text.startsWith(BOM) ? opener.text.slice(1) : opener.text)) return null;
	const yaml: string[] = [];
	for (let at = opener.next; at < content.length; ) {
		const line = lineAt(at);
		if (DELIMITER.test(line.text)) return { yaml: yaml.join("\n"), body: line.next };
		yaml.push(line.text.replace(/\r$/, ""));
		at = line.next;
	}
	return null;
}
