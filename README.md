# immune-mcp — MnemoClaw immune memory for any MCP client

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Expose the [MnemoClaw immune system](https://github.com/Mnemoclaw/immune) — a
self-improving memory of **antibodies** (known errors to avoid) and
**strategies** (proven best practices) — to any
[Model Context Protocol](https://modelcontextprotocol.io) client:
**Claude Desktop, Claude Code, Cursor**, and every MCP-compatible host.

Your agent stops repeating past mistakes, everywhere.

## Tools

| Tool | What it does |
|---|---|
| `immune_recall` | Semantic search over antibodies + strategies (query, domains, tier, limit) |
| `immune_learn` | Learn a new antibody (error + fix) or strategy (best practice) |
| `immune_stats` | Memory health: counts, tiers, storage state |

## Requirements

- Node.js ≥ 18
- An immune install, **either**:
  - **Standalone (CPU)** — `npm install -g @mnemoclaw/immune && immune init`
    (local embeddings + FTS4 + RRF fusion, no GPU, no API key for retrieval)
  - **Full MnemoClaw install** — the adapter transparently upgrades to the GPU
    embed daemon (Nemotron embeddings + cross-encoder rerank) when reachable

The server locates `immune-adapter.js` automatically, in this order:

1. `$IMMUNE_DIR/immune-adapter.js`
2. `$MNEMOCLAW_HOME/workspace/immune/immune-adapter.js`
3. `~/.claude/skills/immune/immune-adapter.js` (npm standalone install)
4. `~/mnemoclaw-docker/workspace/immune/immune-adapter.js` (default full install)
5. `./immune-adapter.js` (git clone next to this package)

## Client configuration

### Claude Code

```bash
claude mcp add immune -- npx -y @mnemoclaw/immune-mcp
```

### Claude Desktop

`claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "immune": {
      "command": "npx",
      "args": ["-y", "@mnemoclaw/immune-mcp"],
      "env": {
        "MNEMOCLAW_HOME": "/home/you/mnemoclaw-docker"
      }
    }
  }
}
```

Omit `MNEMOCLAW_HOME` if you use the standalone install.

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "immune": {
      "command": "npx",
      "args": ["-y", "@mnemoclaw/immune-mcp"]
    }
  }
}
```

## How it works

```
MCP client (Claude/Cursor/…) ──stdio──▶ immune-mcp ──spawn──▶ immune-adapter.js
                                                                   │
                                                        engine delegated to adapter:
                                                        • CPU standalone (MiniLM+FTS4+RRF)
                                                        • or GPU daemon (Nemotron+rerank)
```

`immune-mcp` is deliberately thin: each tool call spawns the adapter CLI
(`get-antibodies` / `get-strategies` in parallel for `type: all`) and returns
its JSON. The retrieval engine lives in the adapter, so this server inherits
every improvement made there (one engine to keep in sync, one contract for
all hosts).

**First call is slow** on a cold standalone install: the embedding model
(~22 MB) downloads once, then embeddings warm up in a few seconds per call.

## Environment variables

| Var | Default | Description |
|---|---|---|
| `IMMUNE_DIR` | auto | Directory containing `immune-adapter.js` |
| `MNEMOCLAW_HOME` | auto | Root of a full MnemoClaw install |
| `IMMUNE_MCP_DEBUG` | off | `1` → verbose diagnostics on stderr |

## License

MIT — Jacques Chauvin
