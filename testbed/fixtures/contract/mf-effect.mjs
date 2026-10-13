// Rule 5, effects. An effect that marks each event it runs on in a file in
// the bed, and a Stop detector that reports what it marked, so the hooks'
// output shows the effect ran: the test bed grades output, not files.
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MARKS = '.mf-effect-ran'

/** @type {import('../../scripts/core/index.ts').Extension} */
const extension = {
  id: 'mf-effect',
  effects: [
    {
      id: 'marks',
      on: ['session-start', 'write', 'stop'],
      run: (trigger, ctx) => appendFileSync(join(ctx.vaultRoot, MARKS), `${trigger.event}\n`),
    },
  ],
  // wiki-mind's Stop entry runs effects before detectors, so this Stop's mark is in.
  detectors: [
    {
      id: 'ran',
      detect: (ctx) => {
        let marks = ''
        try {
          marks = readFileSync(join(ctx.vaultRoot, MARKS), 'utf8')
        } catch {
          return [{ claim: 'MF-EFFECT-RAN: none', lines: [] }]
        }
        // Each event once, in the order it first ran. The contract spec's turn-1 Stop row is the
        // one that proves effects run before the detectors: from turn 2 on, stop is already marked.
        const events = [...new Set(marks.split('\n').filter(Boolean))]
        return [{ claim: `MF-EFFECT-RAN: ${events.join(', ')}`, lines: [] }]
      },
    },
  ],
}
export default extension
