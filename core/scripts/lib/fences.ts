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
 *   as long as the opening run, with nothing after it but whitespace
 *   (CommonMark). A "```js" line or a shorter run inside it is content.
 * - A fence that never closes runs to the end of the note.
 *
 * The one case this gets wrong: at top level, a line of "    ```" is
 * indented code to Obsidian, a single line, but here it opens a fence that
 * runs to a matching close or the end of the note. It is rare, and shows
 * in a review of the links a note yields.
 */

/** The fence a scan is inside: its character and the length of its opening run. null outside one. */
export type OpenFence = { readonly char: "`" | "~"; readonly length: number } | null;

// [^]* rather than .*: a CRLF line split on \n keeps its \r, and . doesn't match it.
const OPENER = /^(`{3,}|~{3,})([^]*)$/;
const CLOSER = /^(`{3,}|~{3,})$/;

/** One line of the scan: whether it belongs to a fence, and the fence open after it. */
export function fenceStep(line: string, open: OpenFence): { fenced: boolean; open: OpenFence } {
	if (open !== null) {
		const run = CLOSER.exec(line.trim())?.[1];
		const closes = run !== undefined && run[0] === open.char && run.length >= open.length;
		return { fenced: true, open: closes ? null : open };
	}
	const m = OPENER.exec(line.trimStart());
	const run = m?.[1];
	if (run === undefined) return { fenced: false, open: null };
	const char = run[0] === "`" ? "`" : "~";
	if (char === "`" && (m?.[2] ?? "").includes("`")) return { fenced: false, open: null };
	return { fenced: true, open: { char, length: run.length } };
}
