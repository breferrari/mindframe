// Rule 4. Expected order of the markers in the session context:
// MF-ORDER-10, MF-ORDER-TIE-A, MF-ORDER-TIE-B, MF-ORDER-15 (mf-order-decl),
// MF-ORDER-20, MF-ORDER-UNSET. Items are listed out of order on purpose,
// and the tie pair is listed with its ids reversed.
/** @type {import('../../scripts/core/index.ts').Extension} */
const extension = {
  id: 'mf-order',
  sections: [
    { id: 'p20', priority: 20, header: '## MF order 20', render: () => 'MF-ORDER-20' },
    { id: 'unset', header: '## MF order unset', render: () => 'MF-ORDER-UNSET' },
    { id: 'tie-b', priority: 12, header: '## MF order tie b', render: () => 'MF-ORDER-TIE-B' },
    { id: 'tie-a', priority: 12, header: '## MF order tie a', render: () => 'MF-ORDER-TIE-A' },
    { id: 'p10', priority: 10, header: '## MF order 10', render: () => 'MF-ORDER-10' },
  ],
}
export default extension
