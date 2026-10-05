// Rule 4: this item sets no priority, so it takes its declaration's (15).
/** @type {import('../../scripts/core/types.ts').Extension} */
const extension = {
  id: 'mf-order-decl',
  sections: [{ id: 'from-declaration', header: '## MF order 15', render: () => 'MF-ORDER-15' }],
}
export default extension
