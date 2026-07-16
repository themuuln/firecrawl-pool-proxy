#!/usr/bin/env node
/**
 * postinstall.js — detects platform, installs binary, creates CLI symlink
 */

import { chmodSync, copyFileSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binDir = join(__dirname, 'bin');

// ─── Platform detection ─────────────────────────────────────────────────────

const platform = process.platform;
const arch = process.arch;
const archMap = { x64: 'amd64', arm64: 'arm64' };
const platformMap = { darwin: 'darwin', linux: 'linux', win32: 'windows' };

const goArch = archMap[arch];
const goPlatform = platformMap[platform];

// ─── Install Go binary ──────────────────────────────────────────────────────

if (goArch && goPlatform) {
  const ext = platform === 'win32' ? '.exe' : '';
  const binName = `firecrawl-mcp-proxy-${goPlatform}-${goArch}${ext}`;
  const binPath = join(__dirname, 'go', 'bin', binName);

  if (existsSync(binPath)) {
    const target = join(__dirname, `firecrawl-mcp-proxy${ext}`);
    try {
      copyFileSync(binPath, target);
      if (ext !== '.exe') chmodSync(target, 0o755);
      console.error(`[firecrawl-pool] ✓ Go binary installed (${goPlatform}/${goArch})`);
    } catch (err) {
      console.error(`[firecrawl-pool] ⚠ Failed to install binary: ${err.message}`);
    }
  }
}

// ─── Create CLI symlink ─────────────────────────────────────────────────────

try {
  const cliSource = join(__dirname, 'bin', 'firecrawl-pool.mjs');
  const cliTarget = join(__dirname, 'firecrawl-pool');

  if (existsSync(cliSource)) {
    // Remove old symlink/file if exists
    try { unlinkSync(cliTarget); } catch {}

    // Create symlink (works on Unix, falls back to copy on Windows)
    if (platform !== 'win32') {
      symlinkSync('bin/firecrawl-pool.mjs', cliTarget);
      chmodSync(cliTarget, 0o755);
    } else {
      copyFileSync(cliSource, cliTarget);
    }
  }
} catch (err) {
  // Non-fatal — users can still run via node bin/firecrawl-pool.mjs
}

console.error('[firecrawl-pool] Ready. Run: firecrawl-pool help');
