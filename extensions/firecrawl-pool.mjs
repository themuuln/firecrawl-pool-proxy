// firecrawl-pool extension
// Registers the Firecrawl pool proxy as an MCP server for pi

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default {
  name: 'firecrawl-pool',
  description: 'Multi-key Firecrawl proxy with credit-aware routing',

  // Register MCP server
  mcp: {
    firecrawl: {
      command: 'node',
      args: [resolve(__dirname, '..', 'firecrawl-mcp-proxy.mjs')],
      env: {
        FIRECRAWL_KEYS_FILE: process.env.FIRECRAWL_KEYS_FILE || '',
      },
    },
  },
};
