#!/usr/bin/env node
/**
 * firecrawl-pool-proxy
 *
 * Round-robin proxy for multiple Firecrawl API keys with credit-aware routing.
 *
 * Architecture: MCP host → stdio → firecrawl-mcp child → HTTP → localhost proxy → api.firecrawl.dev
 *
 * Features:
 * - Credit-aware routing: probes each key's balance, routes to the healthiest
 * - 402 retry: auto-retries with next key when one is exhausted
 * - Keyless fallback: uses Firecrawl's free tier for search/scrape when all keys dead
 * - Cooldown: blocked keys auto-recover after exponential backoff
 *
 * Usage:
 *   node firecrawl-pool-proxy.mjs
 *
 * Env:
 *   FIRECRAWL_KEYS_FILE     — path to keys JSON (default: ./firecrawl-keys.json)
 *   FIRECRAWL_NO_KEYLESS    — set to "1" to disable keyless fallback
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Tools that work on Firecrawl's keyless free tier (rate-limited)
const KEYLESS_SAFE_TOOLS = new Set([
  'firecrawl_search',
  'firecrawl_scrape',
  'firecrawl_interact',
]);

// ─── Config ─────────────────────────────────────────────────────────────────

function loadConfig() {
  const configPath = process.env.FIRECRAWL_KEYS_FILE
    || resolve(__dirname, 'firecrawl-keys.json');
  const raw = readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);

  if (!config.keys?.length) {
    throw new Error(`No keys defined in ${configPath}`);
  }

  return {
    upstream: config.upstream || 'https://api.firecrawl.dev',
    cooldownMs: config.cooldown?.baseMs ?? 900_000,
    maxCooldownMs: config.cooldown?.maxMs ?? 21_600_000,
    keylessEnabled: process.env.FIRECRAWL_NO_KEYLESS !== '1',
    keys: config.keys.map(k => ({
      id: k.id,
      apiKey: k.apiKey,
      enabled: k.enabled !== false,
      blockedUntil: 0,
      consecutive402s: 0,
      credits: null, // populated by checkCredits
    })),
  };
}

// ─── Credit Checking ────────────────────────────────────────────────────────

async function checkCredits(upstream, apiKey) {
  try {
    const res = await fetch(`${upstream}/v1/team/credit-usage`, {
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'x-firecrawl-api-key': apiKey,
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.remaining_credits ?? null;
  } catch {
    return null;
  }
}

async function checkAllCredits(config) {
  const results = await Promise.all(
    config.keys.map(async (key) => {
      const credits = await checkCredits(config.upstream, key.apiKey);
      return { id: key.id, credits };
    }),
  );
  return results;
}

// ─── Key Pool ───────────────────────────────────────────────────────────────

class KeyPool {
  constructor(keys, cooldownMs, maxCooldownMs) {
    this.keys = keys;
    this.cooldownMs = cooldownMs;
    this.maxCooldownMs = maxCooldownMs;
  }

  /**
   * Credit-aware acquisition: picks the enabled, unblocked key with the most
   * remaining credits. Falls back to round-robin if credits are unknown.
   */
  acquire(exclude = new Set()) {
    const now = Date.now();
    const eligible = this.keys.filter(k => {
      if (!k.enabled) return false;
      if (k.blockedUntil > now) return false;
      if (exclude.has(k.id)) return false;
      return true;
    });

    if (eligible.length === 0) return null;

    // Sort by credits descending (null credits treated as 0)
    eligible.sort((a, b) => (b.credits ?? 0) - (a.credits ?? 0));
    return eligible[0];
  }

  mark402(key) {
    key.consecutive402s++;
    key.credits = 0; // 402 means no credits
    const cooldown = Math.min(
      this.cooldownMs * Math.pow(2, key.consecutive402s - 1),
      this.maxCooldownMs,
    );
    key.blockedUntil = Date.now() + cooldown;
    log(`Key ${key.id} blocked ${Math.round(cooldown / 1000)}s (402 #${key.consecutive402s})`);
  }

  markSuccess(key) {
    key.consecutive402s = 0;
    key.blockedUntil = 0;
  }

  nextRetryAt() {
    let earliest = Infinity;
    const now = Date.now();
    for (const key of this.keys) {
      if (key.blockedUntil > now && key.blockedUntil < earliest) {
        earliest = key.blockedUntil;
      }
    }
    return earliest === Infinity ? null : new Date(earliest).toISOString();
  }

  allBlocked() {
    const now = Date.now();
    return this.keys.every(k => !k.enabled || k.blockedUntil > now);
  }

  status() {
    const now = Date.now();
    return this.keys.map(k => ({
      id: k.id,
      credits: k.credits,
      enabled: k.enabled,
      blocked: k.blockedUntil > now,
      blockedUntil: k.blockedUntil > now
        ? new Date(k.blockedUntil).toISOString()
        : null,
      consecutive402s: k.consecutive402s,
    }));
  }
}

// Map Firecrawl API URL paths to MCP tool names
const PATH_TO_TOOL = {
  '/v2/search': 'firecrawl_search',
  '/v2/scrape': 'firecrawl_scrape',
  '/v2/crawl': 'firecrawl_crawl',
  '/v2/map': 'firecrawl_map',
  '/v2/extract': 'firecrawl_extract',
  '/v2/interact': 'firecrawl_interact',
};

function detectToolFromUrl(url) {
  for (const [path, tool] of Object.entries(PATH_TO_TOOL)) {
    if (url.startsWith(path)) return tool;
  }
  return null;
}

// ─── HTTP Reverse Proxy ─────────────────────────────────────────────────────

function createProxy(config) {
  const pool = new KeyPool(config.keys, config.cooldownMs, config.maxCooldownMs);

  const server = createServer(async (req, res) => {
    const body = await collectBody(req);
    const toolName = detectToolFromUrl(req.url);
    const isKeylessSafe = config.keylessEnabled && toolName && KEYLESS_SAFE_TOOLS.has(toolName);

    // Try with keys first
    const attempted = new Set();

    while (true) {
      const key = pool.acquire(attempted);

      if (!key) {
        // All keys exhausted — try keyless fallback for safe tools
        if (isKeylessSafe) {
          log(`All keys exhausted, falling back to keyless for ${toolName}`);
          try {
            const upstreamUrl = new URL(req.url, config.upstream);
            const headers = {
              'content-type': req.headers['content-type'] || 'application/json',
            };
            const upstreamRes = await fetch(upstreamUrl, {
              method: req.method,
              headers,
              body: body.length > 0 ? body : undefined,
            });
            const respHeaders = {};
            upstreamRes.headers.forEach((v, k) => { respHeaders[k] = v; });
            res.writeHead(upstreamRes.status, respHeaders);
            const respBody = await upstreamRes.arrayBuffer();
            res.end(Buffer.from(respBody));
            return;
          } catch (err) {
            log(`Keyless fallback failed: ${err.message}`);
          }
        }

        // No fallback available
        const retryAt = pool.nextRetryAt();
        log(`All keys exhausted${isKeylessSafe ? ' (keyless also failed)' : ''}. Next retry: ${retryAt || 'unknown'}`);
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'All configured Firecrawl keys are exhausted',
          nextRetry: retryAt,
          status: pool.status(),
        }));
        return;
      }

      attempted.add(key.id);

      try {
        const upstreamUrl = new URL(req.url, config.upstream);
        const headers = {
          'content-type': req.headers['content-type'] || 'application/json',
          'authorization': `Bearer ${key.apiKey}`,
          'x-firecrawl-api-key': key.apiKey,
        };

        const upstreamRes = await fetch(upstreamUrl, {
          method: req.method,
          headers,
          body: body.length > 0 ? body : undefined,
        });

        if (upstreamRes.status === 402) {
          pool.mark402(key);
          log(`Key ${key.id}: 402, trying next...`);
          continue;
        }

        pool.markSuccess(key);
        const respHeaders = {};
        upstreamRes.headers.forEach((v, k) => { respHeaders[k] = v; });
        res.writeHead(upstreamRes.status, respHeaders);
        const respBody = await upstreamRes.arrayBuffer();
        res.end(Buffer.from(respBody));
        return;
      } catch (err) {
        log(`Key ${key.id}: error — ${err.message}`);
        continue;
      }
    }
  });

  return { server, pool };
}

function collectBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// ─── Logging ────────────────────────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[firecrawl-pool] ${msg}\n`);
}

// ─── Spawn firecrawl-mcp ────────────────────────────────────────────────────

function spawnMcpChild(port) {
  const child = spawn('npx', ['-y', 'firecrawl-mcp'], {
    env: {
      ...process.env,
      FIRECRAWL_API_URL: `http://127.0.0.1:${port}`,
      FIRECRAWL_API_KEY: 'proxy-placeholder',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stderr.on('data', (chunk) => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      log(`[child] ${line}`);
    }
  });

  child.on('exit', (code) => {
    log(`Child exited with code ${code}`);
    process.exit(code ?? 1);
  });

  child.on('error', (err) => {
    log(`Child spawn error: ${err.message}`);
    process.exit(1);
  });

  return child;
}

// ─── Stdio Relay ────────────────────────────────────────────────────────────

function setupStdioRelay(child) {
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();
  log(`Loaded ${config.keys.length} key(s)`);

  // Probe credit balances on startup
  log('Checking credit balances...');
  const balances = await checkAllCredits(config);
  for (const b of balances) {
    const key = config.keys.find(k => k.id === b.id);
    if (key) key.credits = b.credits;
  }

  // Log summary
  const total = balances.reduce((sum, b) => sum + (b.credits ?? 0), 0);
  const summaries = balances.map(b => `${b.id}:${b.credits ?? '?'}`).join(' | ');
  log(`Credits: ${summaries} (total: ${total})`);

  // Start proxy
  const { server, pool } = createProxy(config);

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const port = server.address().port;
  log(`Proxy on 127.0.0.1:${port}`);
  if (config.keylessEnabled) log('Keyless fallback enabled for search/scrape/interact');

  const child = spawnMcpChild(port);
  setupStdioRelay(child);

  const shutdown = (signal) => {
    log(`Shutting down (${signal})`);
    child.kill(signal);
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
