// Rule 7. One load-bearing section (no pointer) and three that can be given
// up for their pointer. Each body is long enough that the bed's tight budget
// forces collapses: the unset one first, then 930, and 920 survives.
// Priorities sit above any vault section's, so only these collapse.
const filler = (tag) => `${tag}\n` + `${tag.toLowerCase()} filler. `.repeat(80)

/** @type {import('../../scripts/core/index.ts').Extension} */
const extension = {
  id: 'mf-budget',
  sections: [
    { id: 'core', priority: 1, header: '## MF budget core', render: () => 'MF-BUDGET-CORE-BODY' },
    { id: 'p920', priority: 920, header: '## MF budget 920', pointer: 'MF-BUDGET-920-POINTER', render: () => filler('MF-BUDGET-920-BODY') },
    { id: 'p930', priority: 930, header: '## MF budget 930', pointer: 'MF-BUDGET-930-POINTER', render: () => filler('MF-BUDGET-930-BODY') },
    { id: 'unset', header: '## MF budget unset', pointer: 'MF-BUDGET-UNSET-POINTER', render: () => filler('MF-BUDGET-UNSET-BODY') },
  ],
}
export default extension
