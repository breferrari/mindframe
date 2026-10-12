/**
 * The core's one fence rule, for every scanner that reads a note line by
 * line (wikilinks.ts, prose-width.ts). The guide is what Obsidian renders as
 * code: a link inside it is not an edge, and a wrapped line inside it is
 * not prose.
 *
 * - A fence opens on a line whose text, at any indentation, starts with a
 *   run of three or more backticks or tildes. Any indentation, because a
 *   fence nested under a list item is commonly indented four spaces and a
 *   line scanner can't see the list. A backtick opener's info string may
 *   not hold a backtick: "``` x ```" is inline code (CommonMark).
 * - It closes only on a line that is a run of the same character, at least
 *   as long as the opening run, with nothing after it but whitespace, and
 *   indented no more than three spaces deeper than its opener (CommonMark).
 *   A "```js" line, a shorter run, or a deeper-indented run inside it is
 *   content.
 * - A fence inside a blockquote or callout lives inside that quote: it is
 *   read past exactly as many `>` markers as its opener had, and a line
 *   with fewer ends the quote and the fence with it (code in a quote has no
 *   lazy continuation), then is read afresh. A run at a deeper quote level
 *   is content.
 * - Indentation is counted in columns, a tab reaching the next multiple of
 *   four. A closer may sit at most three columns in from the fence's
 *   container: the margin for an opener indented under four columns, the
 *   opener's own column for one indented four or more (a list-nested fence).
 * - A fence that never closes runs to the end of the note.
 *
 * The one case this gets wrong: at top level, a line of "    ```" is
 * indented code to Obsidian, a single line, but here it opens a fence that
 * runs to a matching close or the end of the note. It is rare, and shows
 * in a review of the links a note yields.
 */

/**
 * The fence a scan is inside: its character, the length of its opening run,
 * how many quote markers its opener had, and the deepest column a closer may
 * start at. null outside one.
 */
export type OpenFence = {
	readonly char: "`" | "~";
	readonly length: number;
	readonly depth: number;
	readonly closerColumn: number;
} | null;

// [^]* rather than .*: a CRLF line split on \n keeps its \r, and . doesn't match it.
const OPENER = /^(`{3,}|~{3,})([^]*)$/;
const CLOSER = /^(`{3,}|~{3,})$/;
/** One blockquote or callout marker: up to three spaces, `>`, and one optional space or tab. */
const QUOTE_MARK = /^ {0,3}>[ \t]?/;

/** The line's quote markers counted, up to `limit`, and what follows them. */
function unquote(line: string, limit = Number.POSITIVE_INFINITY): { depth: number; rest: string } {
	let depth = 0;
	let rest = line;
	for (let m = QUOTE_MARK.exec(rest); m !== null && depth < limit; m = QUOTE_MARK.exec(rest)) {
		rest = rest.slice(m[0].length);
		depth++;
	}
	return { depth, rest };
}

/** The column the text starts at, a tab reaching the next multiple of four. */
function startColumn(text: string): number {
	let column = 0;
	for (const ch of text) {
		if (ch === " ") column++;
		else if (ch === "\t") column += 4 - (column % 4);
		else break;
	}
	return column;
}

/** One line of the scan: whether it belongs to a fence, and the fence open after it. */
export function fenceStep(line: string, open: OpenFence): { fenced: boolean; open: OpenFence } {
	if (open !== null) {
		const all = unquote(line);
		// Fewer markers: the quote holding the fence has ended, and the fence with it.
		if (all.depth < open.depth) return fenceStep(line, null);
		const text = unquote(line, open.depth).rest;
		const run = CLOSER.exec(text.trim())?.[1];
		const closes = run !== undefined && run[0] === open.char && run.length >= open.length && startColumn(text) <= open.closerColumn;
		return { fenced: true, open: closes ? null : open };
	}
	const { depth, rest } = unquote(line);
	const [, run, info = ""] = OPENER.exec(rest.trimStart()) ?? [];
	if (run === undefined) return { fenced: false, open: null };
	const char = run.startsWith("`") ? "`" : "~";
	if (char === "`" && info.includes("`")) return { fenced: false, open: null };
	const column = startColumn(rest);
	return { fenced: true, open: { char, length: run.length, depth, closerColumn: (column >= 4 ? column : 0) + 3 } };
}
