/**
 * The extension API: what a vault's own behaviour looks like to the hooks.
 *
 * A vault declares its extensions in `vault-manifest.json` under
 * `extensions` (see Declaration). Each declared module exports an
 * `Extension`, as `default` or as `extension`. The registry (registry.ts)
 * loads them, orders what they contribute, holds each call to a time limit,
 * and isolates failures. The hook entry points only dispatch.
 *
 * This folder is the prototype of a shared core (SPEC.md §7.4). It imports
 * only the vendored libraries under ../lib, so it can be lifted out with a
 * `git mv`.
 */

/** The hook events an extension can serve. `pre-tool` and `mcp` are slots: declared, not dispatched yet. */
export type HookEvent = "session-start" | "stop" | "prompt" | "write" | "pre-tool" | "mcp";

export const HOOK_EVENTS: readonly HookEvent[] = ["session-start", "stop", "prompt", "write", "pre-tool", "mcp"];

/**
 * One entry of `extensions` in vault-manifest.json. Nothing is discovered by
 * side effect: an extension runs only for the events its entry lists.
 */
export type Declaration = {
	/** Must equal the `id` the module exports. */
	readonly id: string;
	/** Vault-relative path of the module, forward slashes. */
	readonly module: string;
	readonly events: readonly HookEvent[];
	/** Default priority for this extension's items that set none. Unset runs last. */
	readonly priority?: number;
	/** `false` turns the whole extension off. */
	readonly enabled?: boolean;
	/** Item ids to turn off, leaving the rest of the extension on. */
	readonly disable?: readonly string[];
	/** Per-call time limit in milliseconds. */
	readonly timeoutMs?: number;
};

/** What every extension call receives. */
export type HookContext = {
	/** Absolute path of the vault root. */
	readonly vaultRoot: string;
	/** The parsed `vault-manifest.json`, or null when absent or malformed. */
	readonly manifest: Readonly<Record<string, unknown>> | null;
	/** Milliseconds since the epoch, fixed for the whole hook run. */
	readonly now: number;
};

/** A value now or later. Every extension call may be async. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Lower runs first and is given up last. Unset falls back to the
 * declaration's priority, and runs last when that is unset too. Equal
 * priorities run in id order.
 */
type Item = {
	readonly id: string;
	readonly priority?: number;
};

/**
 * A section of the session context (SessionStart). Extensions return
 * sections; they never write to stdout. The core assembles them and holds
 * the result to the budget.
 */
export type Section = Item & {
	/** Markdown heading, e.g. "### Open questions". */
	readonly header: string;
	/** The section body, or null to leave the section out this run. */
	readonly render: (ctx: HookContext) => MaybePromise<string | null>;
	/**
	 * What the section becomes when the budget gives it up, or on a
	 * resume/compact re-entry. A section without a pointer is load-bearing:
	 * it is never given up and always renders in full.
	 */
	readonly pointer?: string;
};

/** One finding of a Stop detector. */
export type Finding = {
	/** One line the user sees in the summary, e.g. "2 concepts cite no source". */
	readonly claim: string;
	/** The full report lines the agent reads. */
	readonly lines: readonly string[];
};

/** A Stop and hygiene detector. Returns no findings when the vault is clean. */
export type Detector = Item & {
	readonly detect: (ctx: HookContext) => MaybePromise<readonly Finding[]>;
};

/** A line of the wrap-up checklist the Stop report opens with. */
export type ChecklistItem = Item & {
	/** The line as the agent reads it. */
	readonly full: string;
	/** The line as the user's one-line summary shows it. */
	readonly short: string;
};

/** A prompt signal (UserPromptSubmit): a routing hint when the prompt matches. */
export type Signal = Item & {
	readonly match: (prompt: string) => MaybePromise<boolean>;
	readonly hint: string;
};

/** A file just written (PostToolUse on Write or Edit). */
export type WriteTarget = {
	/** Vault-relative, forward slashes. */
	readonly relPath: string;
	readonly content: string;
};

/** A write validator. Returns warnings; an empty list means the note is fine. */
export type Validator = Item & {
	readonly appliesTo: (relPath: string) => boolean;
	readonly validate: (target: WriteTarget, ctx: HookContext) => MaybePromise<readonly string[]>;
};

/**
 * A vault's extension. Every point is optional. `preToolGuards` and
 * `mcpTools` are slots: the registry records them but does not dispatch
 * them yet. When guards are dispatched, an extension will be able to add a
 * block and never to remove one.
 */
export type Extension = {
	readonly id: string;
	readonly sections?: readonly Section[];
	readonly detectors?: readonly Detector[];
	readonly checklist?: readonly ChecklistItem[];
	readonly signals?: readonly Signal[];
	readonly validators?: readonly Validator[];
	readonly preToolGuards?: readonly unknown[];
	readonly mcpTools?: readonly unknown[];
};

/** Where a failure happened: loading, or one of the dispatched points. */
export type Point = "load" | "section" | "detector" | "checklist" | "signal" | "validator";

/** An extension, or one of its items, that threw, timed out or failed to load. It was skipped. */
export type Failure = {
	/** The extension's declared id, or the declaration itself when it had none. */
	readonly extension: string;
	readonly point: Point;
	/** The item's id; absent for a load failure. */
	readonly item?: string;
	readonly message: string;
};
