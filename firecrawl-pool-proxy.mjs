#!/usr/bin/env node
/**
 * firecrawl-pool-proxy
 *
 * Round-robin proxy for multiple Firecrawl API keys.
 * Sits between your MCP host and firecrawl-mcp, rotating keys
 * and retrying on 402 (credits exhausted).
 *
 * Usage:
 *   node firecrawl-pool-proxy.mjs
 *
 * Env:
 *   FIRECRAWL_KEYS_FILE — path to keys JSON (default: ./firecrawl-keys.json)
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    keys: config.keys.map(k => ({
      id: k.id,
      apiKey: k.apiKey,
      enabled: k.enabled !== false,
      blockedUntil: 0,
      consecutive402s: 0,
    })),
  };
}

// ─── Key Pool ───────────────────────────────────────────────────────────────

class KeyPool {
  constructor(keys, cooldownMs, maxCooldownMs) {
    this.keys = keys;
    this.cooldownMs = cooldownMs;
    this.maxCooldownMs = maxCooldownMs;
    this.cursor = 0;
  }

  acquire(exclude = new Set()) {
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.cursor + i) % this.keys.length;
      const key = this.keys[idx];
      if (!key.enabled) continue;
      if (key.blockedUntil > now) continue;
      if (exclude.has(key.id)) continue;
      this.cursor = (idx + 1) % this.keys.length;
      return key;
    }
    return null;
  }

  mark402(key) {
    key.consecutive402s++;
    const cooldown = Math.min(
      this.cooldownMs * Math.pow(2, key.consecutive402s - 1),
      this.maxCooldownMs,
    );
    key.blockedUntil = Date.now() + cooldown;
    log(`Key ${key.id} blocked for ${Math.round(cooldown / 1000)}s (402 #${key.consecutive402s})`);
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
      enabled: k.enabled,
      blocked: k.blockedUntil > now,
      blockedUntil: k.blockedUntil > now
        ? new Date(k.blockedUntil).toISOString()
        : null,
      consecutive402s: k.consecutive402s,
    }));
  }
}

// ─── HTTP Reverse Proxy ─────────────────────────────────────────────────────

function createProxy(config) {
  const pool = new KeyPool(config.keys, config.cooldownMs, config.maxCooldownMs);

  const server = createServer(async (req, res) => {
    const body = await collectBody(req);
    const attempted = new Set();

    while (true) {
      const key = pool.acquire(attempted);

      if (!key) {
        const retryAt = pool.nextRetryAt();
        log(`All keys exhausted. Next retry: ${retryAt || 'unknown'}`);
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
        log(`Key ${key.id}: request error — ${err.message}`);
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

  const { server } = createProxy(config);

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const port = server.address().port;
  log(`Proxy on 127.0.0.1:${port}`);

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
