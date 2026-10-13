/**
 * The meter line's notes (#70): a note the core wants every session to see,
 * such as a migration step, rides on the meter, with or without a budget.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatInjectionSize } from "../lib/session-start.ts";

test("one argument, or no notes: the meter is unchanged", () => {
	assert.equal(formatInjectionSize(1234), "_context injected: 1.2kB_");
	assert.equal(formatInjectionSize(1234, { notes: [] }), "_context injected: 1.2kB_");
	assert.equal(formatInjectionSize(1234, { budgetBytes: 9000, notes: [] }), "_context injected: 1.2kB / 9.0kB budget_");
});

test("notes end the meter line, without a budget", () => {
	assert.equal(formatInjectionSize(1234, { notes: ["first", "second"] }), "_context injected: 1.2kB — first — second_");
});

test("notes end the meter line after everything else, with a budget", () => {
	assert.equal(
		formatInjectionSize(1234, { budgetBytes: 9000, collapsed: ["A"], cut: true, notes: ["n"] }),
		"_context injected: 1.2kB / 9.0kB budget — collapsed: A — truncated to fit the hook output cap — n_",
	);
});
