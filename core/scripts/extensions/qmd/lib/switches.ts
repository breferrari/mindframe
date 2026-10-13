/**
 * The qmd extension's two switches, each read only with the exact value
 * `off`: one home, so every reader means the same by them (#95).
 */

type Env = Readonly<Record<string, string | undefined>>;

/** The environment variable that turns all of QMD's work off: notes, probes and every refresh. */
export const QMD_SWITCH = "VAULT_QMD";

/**
 * The environment variable that turns off only the detached refresh, session
 * start's update or bootstrap and the debounced worker, so a test run that
 * sets it leaves no qmd work behind (#94, the same switch as obsidian-mind
 * #338). obsidian-mind's and wiki-mind's copies read the same variable the
 * same way, and one variable must mean the same to every vault's hooks.
 */
export const REFRESH_SWITCH = "VAULT_QMD_REFRESH";

/** Whether all of QMD's work is off. */
export function qmdOff(env: Env): boolean {
	return env[QMD_SWITCH] === "off";
}

/** Whether the detached refresh is off. */
export function refreshDisabled(env: Env = process.env): boolean {
	return env[REFRESH_SWITCH] === "off";
}
