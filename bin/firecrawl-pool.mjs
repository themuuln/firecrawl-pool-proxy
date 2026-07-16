#!/usr/bin/env node
/**
 * firecrawl-pool CLI
 *
 * Commands:
 *   init      Interactive setup wizard
 *   status    Show key balances and health
 *   validate  Test that keys work
 *   proxy     Run the MCP proxy (default)
 */

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'));

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(msg) { console.error(`[firecrawl-pool] ${msg}`); }
function warn(msg) { console.error(`[firecrawl-pool] ⚠ ${msg}`); }
function ok(msg) { console.error(`[firecrawl-pool] ✓ ${msg}`); }
function die(msg) { console.error(`[firecrawl-pool] ✗ ${msg}`); process.exit(1); }

function findKeysFile() {
  // Priority: env > standard locations
  const envPath = process.env.FIRECRAWL_KEYS_FILE;
  if (envPath) return envPath;

  const candidates = [
    resolve(__dirname, '..', 'firecrawl-keys.json'),  // next to package
    resolve(process.env.HOME || '~', '.config', 'firecrawl', 'keys.json'),
    resolve(process.env.HOME || '~', '.firecrawl-keys.json'),
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function loadConfig(keysPath) {
  if (!keysPath) {
    die(
      'No keys file found.\n\n' +
      '  Create one:\n' +
      '    firecrawl-pool init\n\n' +
      '  Or set FIRECRAWL_KEYS_FILE=/path/to/keys.json\n\n' +
      '  Or place keys.json next to the binary.'
    );
  }

  try {
    const raw = readFileSync(keysPath, 'utf8');
    const config = JSON.parse(raw);
    if (!config.keys?.length) die(`No keys in ${keysPath}`);
    return { configPath: keysPath, ...config };
  } catch (err) {
    if (err.code === 'ENOENT') die(`Keys file not found: ${keysPath}`);
    die(`Invalid keys file: ${err.message}`);
  }
}

async function checkCredits(upstream, apiKey) {
  try {
    const r = await fetch(`${upstream}/v1/team/credit-usage`, {
      headers: { 'authorization': `Bearer ${apiKey}`, 'x-firecrawl-api-key': apiKey },
    });
    if (!r.ok) return { credits: null, error: r.status };
    const d = await r.json();
    return { credits: d.data?.remaining_credits ?? null };
  } catch {
    return { credits: null, error: 'network' };
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'proxy';
  return { cmd, args: args.slice(1) };
}

// ─── Commands ───────────────────────────────────────────────────────────────

async function cmdInit() {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ask = (q) => new Promise(r => rl.question(q, r));

  console.error('\n  🔥 firecrawl-pool setup\n');
  console.error('  This wizard creates a keys file for multi-key Firecrawl proxying.\n');
  console.error('  Get your API keys at: https://www.firecrawl.dev/app/api-keys\n');

  const keys = [];
  let i = 1;
  while (true) {
    const id = await ask(`  Account ${i} name (or Enter to finish): `);
    if (!id?.trim()) break;
    const apiKey = await ask(`  API key (fc-...): `);
    if (!apiKey?.trim()) { warn('Skipping empty key'); continue; }
    keys.push({ id: id.trim(), apiKey: apiKey.trim(), enabled: true });
    i++;
  }

  rl.close();

  if (keys.length === 0) die('No keys entered. Nothing to save.');

  const config = {
    version: 1,
    upstream: 'https://api.firecrawl.dev',
    cooldown: { baseMs: 900000, maxMs: 21600000 },
    keys,
  };

  // Default location: ~/.config/firecrawl/keys.json
  const outDir = resolve(process.env.HOME || '~', '.config', 'firecrawl');
  const outPath = resolve(outDir, 'keys.json');

  // Also accept --output flag
  const customPath = process.argv.includes('--output')
    ? resolve(process.argv[process.argv.indexOf('--output') + 1])
    : null;
  const target = customPath || outPath;

  writeFileSync(target, JSON.stringify(config, null, 2) + '\n');
  chmodSync(target, 0o600);

  ok(`Keys saved to ${target}`);
  console.error('');
  console.error('  Next steps:');
  console.error('');
  console.error(`  1. Set env: export FIRECRAWL_KEYS_FILE=${target}`);
  console.error('  2. Add to your MCP config:');
  console.error('');
  console.error('     {');
  console.error('       "mcpServers": {');
  console.error('         "firecrawl": {');
  console.error(`           "command": "${resolve(__dirname, '..', 'bin', 'firecrawl-pool')}",`);
  console.error(`           "env": { "FIRECRAWL_KEYS_FILE": "${target}" }`);
  console.error('         }');
  console.error('       }');
  console.error('     }');
  console.error('');
  console.error('  Or for pi coding agent: pi install npm:firecrawl-pool');
  console.error('');
}

async function cmdStatus() {
  const keysPath = findKeysFile();
  const config = loadConfig(keysPath);

  console.error(`\n  🔥 firecrawl-pool status\n`);
  console.error(`  Keys file: ${config.configPath}`);
  console.error(`  Upstream:  ${config.upstream}\n`);

  const upstream = config.upstream || 'https://api.firecrawl.dev';
  const results = await Promise.all(
    config.keys.map(async (k) => {
      const { credits, error } = await checkCredits(upstream, k.apiKey);
      return { ...k, credits, error };
    })
  );

  let total = 0;
  console.error('  ┌─────────────┬──────────┬─────────┬────────┐');
  console.error('  │ Account     │ Status   │ Credits │ Key    │');
  console.error('  ├─────────────┼──────────┼─────────┼────────┤');
  for (const k of results) {
    const status = !k.enabled ? 'disabled' : k.error ? 'error' : 'ok';
    const credits = String(k.credits != null ? k.credits : k.error ?? '?');
    const key = k.apiKey.slice(0, 8) + '...';
    const name = k.id.padEnd(11);
    console.error(`  │ ${name} │ ${status.padEnd(8)} │ ${credits.padStart(7)} │ ${key} │`);
    if (k.credits != null) total += k.credits;
  }
  console.error('  └─────────────┴──────────┴─────────┴────────┘');
  console.error(`\n  Total credits: ${total}\n`);
}

async function cmdValidate() {
  const keysPath = findKeysFile();
  const config = loadConfig(keysPath);

  console.error(`\n  🔥 Validating ${config.keys.length} keys...\n`);

  let allOk = true;
  for (const k of config.keys) {
    const { credits, error } = await checkCredits(config.upstream, k.apiKey);
    if (error) {
      warn(`${k.id}: FAILED (${error})`);
      allOk = false;
    } else {
      ok(`${k.id}: ${credits} credits remaining`);
    }
  }

  console.error('');
  if (allOk) ok('All keys valid');
  else { warn('Some keys failed — check above'); process.exit(1); }
}

function cmdProxy() {
  // Import and run the main proxy
  import(resolve(__dirname, '..', 'firecrawl-mcp-proxy.mjs'));
}

// ─── Main ───────────────────────────────────────────────────────────────────

const { cmd } = parseArgs(process.argv);

switch (cmd) {
  case 'init': await cmdInit(); break;
  case 'status': await cmdStatus(); break;
  case 'validate': await cmdValidate(); break;
  case 'proxy': case undefined: cmdProxy(); break;
  case 'help': case '--help': case '-h':
    console.error(`
  firecrawl-pool — multi-key Firecrawl proxy

  Usage:
    firecrawl-pool              Run the MCP proxy (default)
    firecrawl-pool init         Interactive setup wizard
    firecrawl-pool status       Show key balances
    firecrawl-pool validate     Test that keys work
    firecrawl-pool help         Show this help

  Install:
    pi install npm:firecrawl-pool
    npm install -g firecrawl-pool

  Docs: https://github.com/themuuln/firecrawl-pool-proxy
`);
    break;
  default:
    die(`Unknown command: ${cmd}\nRun 'firecrawl-pool help' for usage.`);
}
