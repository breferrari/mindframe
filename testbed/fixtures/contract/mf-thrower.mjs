// Rule 5. One bad item per extension point. Each must be reported and
// skipped while the hook succeeds and every other extension's items arrive.
/** @type {import('../../scripts/core/types.ts').Extension} */
const extension = {
  id: 'mf-thrower',
  sections: [
    {
      id: 'throws',
      header: '## MF thrower',
      render: () => {
        throw new Error('mf-thrower section failed on purpose')
      },
    },
  ],
  detectors: [{ id: 'rejects', detect: () => Promise.reject(new Error('mf-thrower detector failed on purpose')) }],
  // Never settles: only the declaration's timeoutMs ends it.
  signals: [{ id: 'hangs', match: () => new Promise(() => {}), hint: 'MF-THROWER-HINT' }],
  // Wrong shape: a string where a list of warnings belongs.
  validators: [{ id: 'wrong-shape', appliesTo: () => true, validate: () => 'MF-THROWER-NOT-A-LIST' }],
}
export default extension
