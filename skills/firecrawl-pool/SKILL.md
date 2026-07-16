# firecrawl-pool

Multi-key Firecrawl proxy that pools multiple API keys for the `firecrawl-mcp` server.

## What it does

When you have multiple Firecrawl accounts (each with its own free-tier credits), this proxy rotates between them automatically. If one key runs out of credits (HTTP 402), it tries the next one. When all keys are exhausted, it falls back to Firecrawl's free tier for search/scrape.

## Setup

1. Get API keys from your Firecrawl accounts (https://www.firecrawl.dev/app/api-keys)

2. Create `~/.omp/agent/firecrawl-keys.json`:
```json
{
  "version": 1,
  "upstream": "https://api.firecrawl.dev",
  "cooldown": { "baseMs": 900000, "maxMs": 21600000 },
  "keys": [
    { "id": "account-1", "apiKey": "fc-YOUR-KEY-1", "enabled": true },
    { "id": "account-2", "apiKey": "fc-YOUR-KEY-2", "enabled": true }
  ]
}
```

3. Set env var: `FIRECRAWL_KEYS_FILE=/path/to/firecrawl-keys.json`

## Features

- **Credit-aware routing**: Probes each key's balance on startup, routes to the healthiest
- **402 auto-retry**: When a key is exhausted, retries with the next one
- **Keyless fallback**: Search/scrape still work via Firecrawl's free tier when all keys die
- **Cooldown with backoff**: Blocked keys auto-recover after exponential cooldown

## Tools

All 24 Firecrawl MCP tools are supported: scrape, search, map, crawl, extract, interact, agent, monitors, research, etc.
