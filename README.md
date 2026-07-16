# firecrawl-pool

Multi-key proxy for Firecrawl API. Pools multiple API keys, routes to the healthiest, retries on 402, falls back to free tier.

## Why this exists

The [firecrawl-mcp](https://github.com/firecrawl/firecrawl-mcp-server) npm package takes one `FIRECRAWL_API_KEY`. When that key runs out of credits (HTTP 402), every search/scrape/crawl fails until next month.

If you have multiple Firecrawl accounts — maybe you signed up a few times to get separate free-tier quotas — this proxy sits in front of them and automatically tries the next key when one is exhausted.

**Important:** Firecrawl credits are per-account (team), not per-key. Two keys from the same account share the same credit pool. This proxy only helps when keys belong to different accounts with independent balances.

## Install

```bash
# For pi coding agent
pi install npm:firecrawl-pool

# Or globally via npm
npm install -g firecrawl-pool
```

## Quick Start

```bash
# 1. Run the setup wizard
firecrawl-pool init

# 2. Check your keys
firecrawl-pool status

# 3. Add to your MCP config (or use pi extension)
```

## CLI

| Command | What it does |
|---|---|
| `firecrawl-pool init` | Interactive setup wizard |
| `firecrawl-pool status` | Show key balances and health |
| `firecrawl-pool validate` | Test that all keys work |
| `firecrawl-pool proxy` | Run the MCP proxy (default) |

## Setup (Manual)

### 1. Create your keys file

```bash
cp firecrawl-keys.example.json ~/.config/firecrawl/keys.json
chmod 600 ~/.config/firecrawl/keys.json
```

Edit `~/.config/firecrawl/keys.json`:

```json
{
  "version": 1,
  "upstream": "https://api.firecrawl.dev",
  "cooldown": { "baseMs": 900000, "maxMs": 21600000 },
  "keys": [
    { "id": "personal", "apiKey": "fc-your-key-here", "enabled": true },
    { "id": "work", "apiKey": "fc-another-key", "enabled": true }
  ]
}
```

### 2. Point your MCP host at the proxy

**Before (single key):**

```json
{
  "mcpServers": {
    "firecrawl": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": { "FIRECRAWL_API_KEY": "fc-your-key" }
    }
  }
}
```

**After (pooled keys):**

```json
{
  "mcpServers": {
    "firecrawl": {
      "command": "firecrawl-pool",
      "env": { "FIRECRAWL_KEYS_FILE": "/path/to/keys.json" }
    }
  }
}
```

Or for pi coding agent — the extension handles this automatically.

## Auto-discovery

The proxy looks for keys file in order:
1. `FIRECRAWL_KEYS_FILE` env var
2. `firecrawl-keys.json` next to the binary
3. `~/.config/firecrawl/keys.json`
4. `~/.firecrawl-keys.json`

## How it works

```
MCP host → stdio → firecrawl-pool → api.firecrawl.dev
```

Single process, handles MCP protocol directly. Go binary (~5MB RAM) or Node.js fallback.

- **Credit-aware routing**: Probes each key's balance on startup, routes to the healthiest
- **402 auto-retry**: When a key is exhausted, retries with the next one
- **Keyless fallback**: Search/scrape still work via Firecrawl's free tier when all keys die
- **Cooldown with backoff**: Blocked keys auto-recover after exponential cooldown

## Config options

| Field | Default | What it does |
|-------|---------|-------------|
| `upstream` | `https://api.firecrawl.dev` | Firecrawl API base URL. Change only if self-hosting. |
| `cooldown.baseMs` | `900000` (15 min) | Initial cooldown when a key gets a 402. |
| `cooldown.maxMs` | `21600000` (6 hrs) | Maximum cooldown (doubles each consecutive 402). |
| `keys[].id` | — | Label for logging. Pick something you recognize. |
| `keys[].apiKey` | — | Your `fc-...` API key. |
| `keys[].enabled` | `true` | Set to `false` to temporarily skip a key without removing it. |

## What happens when keys run out

For **search, scrape, and interact**: the proxy falls back to Firecrawl's keyless free tier (rate-limited, no API key needed). You'll get results, just slower.

For **everything else** (crawl, agent, map, extract): the proxy returns a 503.

Blocked keys automatically become available again after their cooldown expires. No restart needed.

## License

MIT
