 # firecrawl-pool-proxy

 A tiny proxy that rotates multiple Firecrawl API keys behind the `firecrawl-mcp` server.

 ## Why this exists

The [firecrawl-mcp](https://github.com/firecrawl/firecrawl-mcp-server) npm package takes one `FIRECRAWL_API_KEY`. When that key runs out of credits (HTTP 402), every search/scrape/crawl fails until next month.

If you have multiple Firecrawl accounts — maybe you signed up a few times to get separate free-tier quotas — this proxy sits in front of them and automatically tries the next key when one is exhausted.

**Important:** Firecrawl credits are per-account (team), not per-key. Two keys from the same account share the same credit pool. This proxy only helps when keys belong to different accounts with independent balances.

## How it works

```
Your MCP host (Claude Desktop, Cursor, OMP, etc.)
  │
  │  JSON-RPC over stdio
  ▼
firecrawl-pool-proxy.mjs
  │
  │  Spawns firecrawl-mcp as a child process,
  │  pointed at a localhost HTTP reverse proxy
  ▼
localhost HTTP proxy (picks a key per request)
  │
  │  Authorization: Bearer <selected-key>
  ▼
api.firecrawl.dev
```

 The proxy never parses MCP messages. It intercepts HTTP requests from the child, checks each key's credit balance on startup, and routes to the one with the most remaining credits. If a key gets a 402, it retries with the next one. When all keys are exhausted, it falls back to Firecrawl's free tier for search/scrape (no key required).

## Setup

### 1. Install

Clone this repo or copy `firecrawl-pool-proxy.mjs` somewhere.

```bash
git clone https://github.com/YOUR_USERNAME/firecrawl-pool-proxy.git
cd firecrawl-pool-proxy
```

You also need `firecrawl-mcp` available on your PATH (or npx will fetch it):

```bash
npm install -g firecrawl-mcp
```

### 2. Create your keys file

Copy the example and fill in your API keys:

```bash
cp firecrawl-keys.example.json firecrawl-keys.json
```

Edit `firecrawl-keys.json`:

```json
{
  "version": 1,
  "upstream": "https://api.firecrawl.dev",
  "cooldown": {
    "baseMs": 900000,
    "maxMs": 21600000
  },
  "keys": [
    { "id": "personal", "apiKey": "fc-your-key-here", "enabled": true },
    { "id": "work", "apiKey": "fc-another-key", "enabled": true }
  ]
}
```

Protect it:

```bash
chmod 600 firecrawl-keys.json
```

### 3. Point your MCP host at the proxy

Replace the `firecrawl` entry in your MCP config. Here's what it looks like for a typical setup:

**Before (single key):**

```json
{
  "mcpServers": {
    "firecrawl": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "fc-your-key"
      }
    }
  }
}
```

**After (pooled keys):**

```json
{
  "mcpServers": {
    "firecrawl": {
      "command": "node",
      "args": ["/absolute/path/to/firecrawl-pool-proxy.mjs"],
      "env": {
        "FIRECRAWL_KEYS_FILE": "/absolute/path/to/firecrawl-keys.json"
      }
    }
  }
}
```

Use absolute paths. Some MCP hosts don't expand `~`.

### 4. Restart your MCP host

That's it. The proxy logs to stderr so you can see key rotation happening.

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

 For **everything else** (crawl, agent, map, extract): the proxy returns a 503:

 ```json
 {
   "error": "All configured Firecrawl keys are exhausted",
   "nextRetry": "2026-07-16T18:30:00.000Z",
   "status": [...]
 }
 ```

 You can disable keyless fallback with `FIRECRAWL_NO_KEYLESS=1`.

 Blocked keys automatically become available again after their cooldown expires. No restart needed.

 ## Requirements

 - Node.js 22+ (uses built-in `fetch`)
 - `firecrawl-mcp` installed (npm or npx)

 ## Limitations

 - **No persistent state.** If the proxy restarts, cooldowns reset. That's fine for local use.
 - **Keyless fallback is limited.** Only search, scrape, and interact work without a key. Crawl, agent, and extract still need credits.
 - **Stateful tools (crawl, agent)** create account-owned resources. If a crawl starts on key A, polling it on key B might not work. This is fine for search and scrape — the common case.

## License

MIT
