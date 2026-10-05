// Rule 5. A healthy item at every point. Its markers must arrive whatever
// mf-thrower does.
/** @type {import('../../scripts/core/types.ts').Extension} */
const extension = {
  id: 'mf-witness',
  sections: [{ id: 'section', priority: 50, header: '## MF witness', render: () => 'MF-WITNESS-SECTION' }],
  detectors: [{ id: 'finding', detect: () => [{ claim: 'MF-WITNESS-CLAIM', lines: ['MF-WITNESS-FINDING'] }] }],
  checklist: [{ id: 'check', full: 'MF-WITNESS-CHECK', short: 'mf witness check' }],
  signals: [{ id: 'ping', match: (prompt) => prompt.includes('MF-PING'), hint: 'MF-WITNESS-HINT' }],
  validators: [{ id: 'warn', appliesTo: (relPath) => relPath.endsWith('.md'), validate: () => ['MF-WITNESS-WARNING'] }],
}
export default extension
