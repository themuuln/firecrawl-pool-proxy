// firecrawl-pool extension
// Registers the Firecrawl pool proxy as an MCP server for pi

import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, '..');

// Prefer CLI > Go binary > Node.js script
const cli = resolve(pkgDir, 'bin', 'firecrawl-pool.mjs');
const goBin = resolve(pkgDir, 'firecrawl-mcp-proxy');
const nodeScript = resolve(pkgDir, 'firecrawl-mcp-proxy.mjs');
const isWin = process.platform === 'win32';

let command, args;

if (existsSync(cli)) {
  // CLI mode — handles everything including key discovery
  command = 'node';
  args = [cli, 'proxy'];
} else if (existsSync(goBin + (isWin ? '.exe' : '')) || existsSync(goBin)) {
  // Go binary
  command = goBin;
  args = [];
} else {
  // Node.js fallback
  command = 'node';
  args = [nodeScript];
}

export default {
  name: 'firecrawl-pool',
  description: 'Multi-key Firecrawl proxy with credit-aware routing',

  mcp: {
    firecrawl: {
      command,
      args,
      env: {
        FIRECRAWL_KEYS_FILE: process.env.FIRECRAWL_KEYS_FILE || '',
      },
    },
  },
};
