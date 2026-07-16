# firecrawl-pool

Multi-key Firecrawl proxy. Pools multiple API keys, routes to the healthiest, retries on 402, falls back to free tier.

## Quick Start

```bash
# 1. Install
pi install npm:firecrawl-pool

# 2. Setup (interactive wizard)
firecrawl-pool init

# 3. Verify
firecrawl-pool status

# 4. Add to your MCP config
# The pi extension handles this automatically
```

## CLI Commands

| Command | What it does |
|---|---|
| `firecrawl-pool init` | Interactive setup wizard — creates keys file |
| `firecrawl-pool status` | Show key balances and health |
| `firecrawl-pool validate` | Test that all keys work |
| `firecrawl-pool proxy` | Run the MCP proxy (default) |
| `firecrawl-pool help` | Show help |

## Keys File

Default location: `~/.config/firecrawl/keys.json`

Or set `FIRECRAWL_KEYS_FILE=/path/to/keys.json`.

```json
{
  "version": 1,
  "upstream": "https://api.firecrawl.dev",
  "cooldown": { "baseMs": 900000, "maxMs": 21600000 },
  "keys": [
    { "id": "personal", "apiKey": "fc-KEY-1", "enabled": true },
    { "id": "work", "apiKey": "fc-KEY-2", "enabled": true }
  ]
}
```

## Features

- Credit-aware routing (probes balances, routes to healthiest key)
- 402 auto-retry across keys
- Keyless fallback for search/scrape when all keys die
- Cooldown with exponential backoff
- Go binary (~5MB RAM) or Node.js fallback

## Auto-discovery

Looks for keys file in order:
1. `FIRECRAWL_KEYS_FILE` env var
2. `firecrawl-keys.json` next to the binary
3. `~/.config/firecrawl/keys.json`
4. `~/.firecrawl-keys.json`

## Tools

All 24 Firecrawl tools: scrape, search, map, crawl, extract, interact, agent, monitors, research, etc.
