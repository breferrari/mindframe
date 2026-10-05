// Rule 5. A list whose getter throws. The registry can't read the
// extension's shape, so it skips the whole extension at load and reports
// it; every other extension still loads. Kept apart from mf-thrower, whose
// per-point failures would otherwise never run.
/** @type {import('../../scripts/core/index.ts').Extension} */
const extension = {
  id: 'mf-getter',
  get sections() {
    throw new Error('mf-getter sections getter failed on purpose')
  },
}
export default extension
