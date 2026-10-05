// Writes the North Star fixtures beside this file: North Stars too long for
// the session-start hook budget, to measure whether a session still knows
// the vault's goals (obsidian-mind#304). Every live bullet starts with a
// [[link]] and a clause, and carries one invented marker word that appears
// nowhere else, so a session's recall of the goals can be counted. The
// goals are neutral and invented. Live bullets are ASCII; sizes are in bytes.
//
//   node testbed/fixtures/north-star/generate.mjs
//
// Deterministic: running it again rewrites the same bytes.
//
// Two shapes:
// - "30x380": #304's repro, 30 live bullets of 380 bytes each.
// - "12-live": the size profile of a real vault whose North Star doesn't
//   fit (sizes only, no content): 12 live bullets with median 626 bytes,
//   p90 1,150, max 1,360 and 8,000 bytes in all, plus 3 completed bullets
//   marked with a check mark, for about 12.3 kB of Current Focus.
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MARKERS = [
  'Brindlewick', 'Corvantine', 'Dashmere', 'Elvorrow', 'Fennigast', 'Glimmerholt', 'Harrowind', 'Islemont', 'Jasperlane', 'Kettlevane',
  'Lumbrisk', 'Marrowgate', 'Nettlecombe', 'Orrinsby', 'Pellucine', 'Quarrowe', 'Rimblestone', 'Saltreach', 'Thistlemark', 'Umberlith',
  'Vexmoor', 'Wrenhallow', 'Yarrowdeep', 'Zelkovan', 'Ambrelin', 'Bossenrow', 'Cindervale', 'Drowsmere', 'Embergast', 'Foxmantle',
]

const AREAS = ['the release pipeline', 'the onboarding guide', 'the metrics dashboard', 'the test harness', 'the design review', 'the data migration']
const VERBS = ['finish', 'ship', 'stabilise', 'document', 'simplify', 'measure']
const FILLER =
  ', so the team can rely on it without asking first; agree the scope in writing, keep a short log of each decision, name an owner for every open question, check the numbers weekly against the baseline, and close the loop with a review once the change has been in use for two weeks and the numbers have settled'

/** One live bullet of exactly `bytes` bytes, carrying its marker word once. */
export function liveBullet(i, marker, bytes) {
  const n = String(i + 1).padStart(2, '0')
  const head = `- [[Goal ${n}]] - ${VERBS[i % VERBS.length]} ${AREAS[i % AREAS.length]} under the ${marker} plan`
  let text = head
  while (text.length < bytes) text += FILLER
  return text.slice(0, bytes - 1) + '.'
}

/**
 * One completed bullet, marked with a check mark rather than struck through.
 * session-start drops struck (`- ~~`) bullets from the slice, but not these,
 * so they still cost bytes: the shape of the real vault, whose 30-line slice
 * is about 12.2 kB. Exactly `bytes` bytes of UTF-8.
 */
function doneBullet(i, bytes) {
  const head = `- ✅ [[Done ${i + 1}]] - wrapped up an earlier milestone`
  let text = head
  while (Buffer.byteLength(text) < bytes) text += FILLER
  while (Buffer.byteLength(text) > bytes - 1) text = text.slice(0, -1)
  return text + '.'
}

const LIVE_12 = [260, 330, 400, 480, 540, 610, 642, 680, 740, 808, 1150, 1360]
const DONE_12 = [1430, 1430, 1440]

export const SHAPES = {
  '30x380': { markers: MARKERS.slice(0, 30), bullets: () => MARKERS.slice(0, 30).map((m, i) => liveBullet(i, m, 380)) },
  '12-live': {
    markers: MARKERS.slice(0, 12),
    bullets: () => {
      const live = MARKERS.slice(0, 12).map((m, i) => liveBullet(i, m, LIVE_12[i]))
      // Completed bullets sit among the live ones, as they do in a real file.
      return [...live.slice(0, 3), doneBullet(0, DONE_12[0]), ...live.slice(3, 7), doneBullet(1, DONE_12[1]), ...live.slice(7, 11), doneBullet(2, DONE_12[2]), live[11]]
    },
  },
}

export function northStar(shape) {
  return [
    '---',
    'date: 2026-01-01',
    'description: "Bed fixture: a North Star whose Current Focus is too long for the session-start budget"',
    'tags:',
    '  - brain',
    '  - north-star',
    '---',
    '',
    '# North Star',
    '',
    '## Current Focus',
    '',
    ...SHAPES[shape].bullets(),
    '',
    '## Goals',
    '',
    '- See Current Focus.',
    '',
  ].join('\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  for (const shape of Object.keys(SHAPES)) {
    const out = path.join(dir, `North Star ${shape}.md`)
    writeFileSync(out, northStar(shape))
    console.log(`wrote ${path.basename(out)}`)
  }
}
