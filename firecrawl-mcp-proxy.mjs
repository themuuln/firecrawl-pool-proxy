#!/usr/bin/env node
/**
 * firecrawl-mcp-proxy
 *
 * Self-contained MCP server + key-pool proxy in a single process.
 * Handles MCP JSON-RPC protocol directly — no firecrawl-mcp child, no npx.
 *
 * Architecture: OMP → stdio → THIS process → api.firecrawl.dev
 *
 * Features:
 * - Handles MCP initialize, tools/list, tools/call over stdio
 * - Credit-aware key routing (probes balances on startup)
 * - 402 auto-retry across keys
 * - Keyless fallback for search/scrape/interact
 * - Cooldown with exponential backoff
 *
 * Usage:
 *   node firecrawl-mcp-proxy.mjs
 *
 * Env:
 *   FIRECRAWL_KEYS_FILE   — path to keys JSON (default: ./firecrawl-keys.json)
 *   FIRECRAWL_NO_KEYLESS  — "1" to disable keyless fallback
 */

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
  if (!config.keys?.length) throw new Error(`No keys in ${configPath}`);
  return {
    upstream: config.upstream || 'https://api.firecrawl.dev',
    cooldownMs: config.cooldown?.baseMs ?? 900_000,
    maxCooldownMs: config.cooldown?.maxMs ?? 21_600_000,
    keylessEnabled: process.env.FIRECRAWL_NO_KEYLESS !== '1',
    keys: config.keys.map(k => ({
      id: k.id, apiKey: k.apiKey, enabled: k.enabled !== false,
      blockedUntil: 0, consecutive402s: 0, credits: null,
    })),
  };
}

// ─── Credit Checking ────────────────────────────────────────────────────────

async function checkCredits(upstream, apiKey) {
  try {
    const res = await fetch(`${upstream}/v1/team/credit-usage`, {
      headers: { 'authorization': `Bearer ${apiKey}`, 'x-firecrawl-api-key': apiKey },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.remaining_credits ?? null;
  } catch { return null; }
}

// ─── Key Pool ───────────────────────────────────────────────────────────────

class KeyPool {
  constructor(keys, cooldownMs, maxCooldownMs) {
    this.keys = keys;
    this.cooldownMs = cooldownMs;
    this.maxCooldownMs = maxCooldownMs;
  }

  acquire(exclude = new Set()) {
    const now = Date.now();
    const eligible = this.keys.filter(k =>
      k.enabled && k.blockedUntil <= now && !exclude.has(k.id));
    if (!eligible.length) return null;
    eligible.sort((a, b) => (b.credits ?? 0) - (a.credits ?? 0));
    return eligible[0];
  }

  mark402(key) {
    key.consecutive402s++;
    key.credits = 0;
    key.blockedUntil = Date.now() + Math.min(
      this.cooldownMs * Math.pow(2, key.consecutive402s - 1),
      this.maxCooldownMs);
  }

  markSuccess(key) { key.consecutive402s = 0; key.blockedUntil = 0; }

  nextRetryAt() {
    let earliest = Infinity;
    const now = Date.now();
    for (const k of this.keys) if (k.blockedUntil > now && k.blockedUntil < earliest) earliest = k.blockedUntil;
    return earliest === Infinity ? null : new Date(earliest).toISOString();
  }

  allBlocked() {
    const now = Date.now();
    return this.keys.every(k => !k.enabled || k.blockedUntil > now);
  }
}

// ─── Tool → API Mapping ────────────────────────────────────────────────────

// Map MCP tool names to Firecrawl API paths
const TOOL_ROUTES = {
  firecrawl_scrape:            { path: '/v2/scrape',            method: 'POST' },
  firecrawl_search:            { path: '/v2/search',            method: 'POST' },
  firecrawl_map:               { path: '/v2/map',               method: 'POST' },
  firecrawl_crawl:             { path: '/v2/crawl',             method: 'POST' },
  firecrawl_check_crawl_status:{ path: '/v2/crawl',             method: 'GET',  idInUrl: true },
  firecrawl_extract:           { path: '/v2/extract',           method: 'POST' },
  firecrawl_parse:             { path: '/v2/parse',             method: 'POST' },
  firecrawl_interact:          { path: '/v2/interact',          method: 'POST' },
  firecrawl_interact_stop:     { path: '/v2/interact',          method: 'POST' },
  firecrawl_agent:             { path: '/v2/agent',             method: 'POST' },
  firecrawl_agent_status:      { path: '/v2/agent',             method: 'GET',  idInUrl: true },
  firecrawl_search_feedback:   { path: '/v2/search/feedback',   method: 'POST' },
  firecrawl_feedback:          { path: '/v2/feedback',          method: 'POST' },
  firecrawl_monitor_create:    { path: '/v2/monitors',          method: 'POST' },
  firecrawl_monitor_list:      { path: '/v2/monitors',          method: 'GET' },
  firecrawl_monitor_get:       { path: '/v2/monitors',          method: 'GET',  idInUrl: true },
  firecrawl_monitor_update:    { path: '/v2/monitors',          method: 'PATCH', idInUrl: true },
  firecrawl_monitor_delete:    { path: '/v2/monitors',          method: 'DELETE', idInUrl: true },
  firecrawl_monitor_run:       { path: '/v2/monitors',          method: 'POST', subPath: '/run', idInUrl: true },
  firecrawl_monitor_checks:    { path: '/v2/monitors',          method: 'GET',  subPath: '/checks', idInUrl: true },
  firecrawl_monitor_check:     { path: '/v2/monitors',          method: 'GET',  subPath: '/checks', idInUrl: true },
  firecrawl_research_search_papers:   { path: '/v2/research/search/papers',   method: 'POST' },
  firecrawl_research_inspect_paper:   { path: '/v2/research/inspect/paper',   method: 'POST' },
  firecrawl_research_related_papers:  { path: '/v2/research/related/papers',  method: 'POST' },
  firecrawl_research_read_paper:      { path: '/v2/research/read/paper',      method: 'POST' },
  firecrawl_research_search_github:   { path: '/v2/research/search/github',   method: 'POST' },
};

// Tools where keyless fallback is safe
const KEYLESS_SAFE = new Set(['firecrawl_search', 'firecrawl_scrape', 'firecrawl_interact']);

// ─── HTTP Request Execution ─────────────────────────────────────────────────

async function executeRequest(config, pool, toolName, args) {
  const route = TOOL_ROUTES[toolName];
  if (!route) throw new Error(`Unknown tool: ${toolName}`);

  const isKeylessSafe = config.keylessEnabled && KEYLESS_SAFE.has(toolName);
  const attempted = new Set();

  // Build URL
  let urlPath = route.path;
  if (route.idInUrl && args.id) {
    urlPath += `/${args.id}`;
    if (route.subPath) urlPath += route.subPath;
  }

  // Build body (for POST/PATCH) or query params (for GET)
  let fetchOpts = { method: route.method };

  if (route.method === 'GET') {
    // Some GET endpoints accept query params
    const params = new URLSearchParams();
    if (args.limit) params.set('limit', String(args.limit));
    if (args.offset) params.set('offset', String(args.offset));
    if (args.status) params.set('status', args.status);
    const qs = params.toString();
    if (qs) urlPath += `?${qs}`;
  } else {
    // Strip id from body since it's in the URL
    const body = { ...args };
    delete body.id;
    fetchOpts.body = JSON.stringify(body);
    fetchOpts.headers = { 'content-type': 'application/json' };
  }

  // Try with keys
  while (true) {
    const key = pool.acquire(attempted);
    if (!key) {
      // Keyless fallback
      if (isKeylessSafe) {
        try {
          const res = await fetch(`${config.upstream}${urlPath}`, {
            ...fetchOpts, headers: { 'content-type': 'application/json' },
          });
          return await res.json();
        } catch (err) { log(`Keyless failed: ${err.message}`); }
      }
      return { error: 'All keys exhausted', nextRetry: pool.nextRetryAt() };
    }

    attempted.add(key.id);

    try {
      const res = await fetch(`${config.upstream}${urlPath}`, {
        ...fetchOpts,
        headers: {
          ...fetchOpts.headers,
          'authorization': `Bearer ${key.apiKey}`,
          'x-firecrawl-api-key': key.apiKey,
        },
      });

      if (res.status === 402) { pool.mark402(key); continue; }
      pool.markSuccess(key);
      return await res.json();
    } catch (err) { log(`Key ${key.id}: ${err.message}`); continue; }
  }
}

// ─── MCP Protocol ───────────────────────────────────────────────────────────

const MCP_SERVER_INFO = {
  name: 'firecrawl-pool-proxy',
  version: '2.0.0',
};

const MCP_TOOLS = Object.keys(TOOL_ROUTES).map(name => ({
  name,
  description: `Firecrawl ${name.replace('firecrawl_', '')} — see https://docs.firecrawl.dev`,
  inputSchema: { type: 'object', properties: {}, additionalProperties: true },
}));

function handleMcpMessage(config, pool, msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: MCP_SERVER_INFO,
          instructions: 'Firecrawl MCP proxy with key pooling. Use firecrawl_search/firecrawl_scrape as primary search tools.',
        },
      };

    case 'notifications/initialized':
      return null; // notifications don't get responses

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };

    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments || {};
      return { jsonrpc: '2.0', id, _async: true, toolName, args };
    }

    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// ─── Stdin Reader (line-delimited JSON) ─────────────────────────────────────

let pending = 0;
let stdinEnded = false;

function maybeExit() {
  if (stdinEnded && pending === 0) process.exit(0);
}

function readStdinLines(callback) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) callback(line);
    }
  });
  process.stdin.on('end', () => { stdinEnded = true; maybeExit(); });
}

// ─── Logging ────────────────────────────────────────────────────────────────

function log(msg) { process.stderr.write(`[firecrawl-pool] ${msg}\n`); }

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();
  const pool = new KeyPool(config.keys, config.cooldownMs, config.maxCooldownMs);

  log(`${config.keys.length} key(s) loaded`);

  // Probe credits
  const balances = await Promise.all(
    config.keys.map(async k => ({ id: k.id, credits: await checkCredits(config.upstream, k.apiKey) })));
  for (const b of balances) pool.keys.find(k => k.id === b.id).credits = b.credits;

  const total = balances.reduce((s, b) => s + (b.credits ?? 0), 0);
  log(`Credits: ${balances.map(b => `${b.id}:${b.credits ?? '?'}`).join(' | ')} (total: ${total})`);

  if (config.keylessEnabled) log('Keyless fallback enabled');

  // Handle MCP messages
  readStdinLines(async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    const response = handleMcpMessage(config, pool, msg);
    if (!response) return; // notification, no response

    if (response._async) {
      pending++;
      try {
        const { toolName, args } = response;
        const result = await executeRequest(config, pool, toolName, args);
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: response.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError: !!result.error,
          },
        }) + '\n');
      } catch (err) {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: response.id,
          result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true },
        }) + '\n');
      } finally {
        pending--;
        maybeExit();
      }
    } else {
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  });
}

main().catch((err) => { log(`Fatal: ${err.message}`); process.exit(1); });
