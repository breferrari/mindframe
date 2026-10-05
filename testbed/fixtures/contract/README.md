# Contract fixture extensions

Extensions that exist only to test the core's extension contract (`docs/DESIGN.md`) in real sessions, through `testbed/specs/contract.json`. They carry marker strings and no behaviour. Each one is copied into the bed under `.claude/extensions/` and declared in the bed's `vault-manifest.json`.

| Extension | Tests |
|-----------|-------|
| `mf-order` | Rule 4: item priorities, unset last, ties broken by item id whatever the declaration order |
| `mf-order-decl` | Rule 4: an item with no priority takes its declaration's |
| `mf-budget` | Rule 7: under a tight byte budget, sections with pointers collapse from the highest number (and unset) down; the load-bearing one never does |
| `mf-thrower` | Rule 5: one bad item per extension point. It throws, rejects, never settles, or returns the wrong shape |
| `mf-getter` | Rule 5: a list getter that throws, so the whole extension is skipped at load and reported, and the others still load. Rule 3: it is declared for `session-start` only, so its failure must appear there and nowhere else |
| `mf-witness` | Rule 5: a healthy item at every point, which must still arrive beside `mf-thrower` |

They reference the API types from the core's public entry (`.claude/scripts/core/index.ts`) in JSDoc only. Nothing is imported at runtime, so they load in any vault that implements the contract.
