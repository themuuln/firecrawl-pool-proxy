#!/usr/bin/env node
/**
 * postinstall.js — detects platform and makes the right binary executable
 */

import { chmodSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binDir = join(__dirname, 'bin');

const platform = process.platform;  // 'darwin', 'linux', 'win32'
const arch = process.arch;          // 'arm64', 'x64'

const archMap = { x64: 'amd64', arm64: 'arm64' };
const platformMap = { darwin: 'darwin', linux: 'linux', win32: 'windows' };

const goArch = archMap[arch];
const goPlatform = platformMap[platform];

if (!goArch || !goPlatform) {
  console.error(`[firecrawl-pool] Unsupported platform: ${platform}/${arch}`);
  console.error(`[firecrawl-pool] Falling back to Node.js version`);
  process.exit(0);
}

const ext = platform === 'win32' ? '.exe' : '';
const binName = `firecrawl-mcp-proxy-${goPlatform}-${goArch}${ext}`;
const binPath = join(binDir, binName);

if (!existsSync(binPath)) {
  console.error(`[firecrawl-pool] Binary not found: ${binName}`);
  console.error(`[firecrawl-pool] Falling back to Node.js version`);
  process.exit(0);
}

// Copy to a stable location and make executable
const target = join(__dirname, `firecrawl-mcp-proxy${ext}`);
try {
  copyFileSync(binPath, target);
  if (ext !== '.exe') {
    chmodSync(target, 0o755);
  }
  console.log(`[firecrawl-pool] Ready: ${goPlatform}/${goArch} binary installed`);
} catch (err) {
  console.error(`[firecrawl-pool] Failed to install binary: ${err.message}`);
  console.error(`[firecrawl-pool] Falling back to Node.js version`);
}
