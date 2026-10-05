# mindframe

The agent layer for Obsidian vaults that work with Claude Code: hook scripts, a Claude Code mod, and an MCP server, built as a small core that each vault extends with its own behaviour, without editing the core.

> **Status:** not usable yet. The extension API is being prototyped inside [wiki-mind](https://github.com/breferrari/wiki-mind) and moves here once it has passed a real-session test run. The machinery it generalizes ships today in [obsidian-mind](https://github.com/breferrari/obsidian-mind).

## The shape

```
core/          the extension registry, hook input and output with the output budget,
               vault-root discovery, the mod and its flag protocol,
               frontmatter and wikilink parsing
extensions/    first-party and optional; a vault picks the ones it wants
testbed/       runs every hook and the mod in real Claude Code sessions against a vault
docs/          design rationale: the extension contract and why it is shaped that way
```

The build order is in [ROADMAP.md](ROADMAP.md); how to work on the repo is in [CONTRIBUTING.md](CONTRIBUTING.md).

- **The core declares extension points per lifecycle event:** session-start sections, Stop and hygiene detectors, prompt signals, write validators, pre-tool guards, and MCP tools.
- **A vault's own behaviour lives outside the core,** in its `.claude/extensions/`, declared in `vault-manifest.json`. Updating the core never touches it.
- **The core owns what an extension must not get wrong:** ordering, the session-start byte budget (low-priority sections degrade first), and failure isolation (an extension that throws is reported and skipped, and never blocks the hook).
- **Vaults vendor it.** A vault keeps working with no network and no package manager, so it carries a copy of the core and its chosen extensions, recorded in a `VENDOR.json` that names the commit it came from.
- **Claude Code and the rest.** On Claude Code 2.1.287 and later the mod delivers the session context and the Stop report; elsewhere, including Codex and Gemini CLI, the same scripts run as plain settings hooks.

## License

[MIT](LICENSE)
