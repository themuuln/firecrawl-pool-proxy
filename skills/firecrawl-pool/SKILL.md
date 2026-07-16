# firecrawl-pool

Multi-key Firecrawl proxy. Pools multiple API keys, routes to the healthiest, retries on 402, falls back to free tier.

## Setup

1. Get API keys from your Firecrawl accounts (https://www.firecrawl.dev/app/api-keys)

2. Create `~/.omp/agent/firecrawl-keys.json`:
```json
{
  "version": 1,
  "upstream": "https://api.firecrawl.dev",
  "cooldown": { "baseMs": 900000, "maxMs": 21600000 },
  "keys": [
    { "id": "account-1", "apiKey": "fc-KEY-1", "enabled": true },
    { "id": "account-2", "apiKey": "fc-KEY-2", "enabled": true }
  ]
}
```

3. Set env: `FIRECRAWL_KEYS_FILE=/path/to/firecrawl-keys.json`

## Features

- Credit-aware routing (probes balances, routes to healthiest key)
- 402 auto-retry across keys
- Keyless fallback for search/scrape when all keys die
- Cooldown with exponential backoff
- Go binary (~5MB RAM) or Node.js fallback

## Tools

All 24 Firecrawl tools: scrape, search, map, crawl, extract, interact, agent, monitors, research, etc.
