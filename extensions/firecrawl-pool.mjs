// firecrawl-pool extension
// Registers the Firecrawl pool proxy as an MCP server for pi

import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Prefer Go binary (installed by postinstall), fall back to Node.js
const goBin = resolve(__dirname, '..', 'firecrawl-mcp-proxy');
const nodeScript = resolve(__dirname, '..', 'firecrawl-mcp-proxy.mjs');
const isWin = process.platform === 'win32';
const binary = (existsSync(goBin + (isWin ? '.exe' : '')) || existsSync(goBin))
  ? goBin
  : nodeScript;

const isNode = binary.endsWith('.mjs');

export default {
  name: 'firecrawl-pool',
  description: 'Multi-key Firecrawl proxy with credit-aware routing',

  mcp: {
    firecrawl: {
      command: isNode ? 'node' : binary,
      args: isNode ? [binary] : [],
      env: {
        FIRECRAWL_KEYS_FILE: process.env.FIRECRAWL_KEYS_FILE || '',
      },
    },
  },
};
