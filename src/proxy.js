// Lightweight reverse proxy for ClaudeCat projects.
//
// Runs as a background Node.js process on the host (not in Docker).
// Routes http://<slug>.localhost → container's mapped port on localhost.
//
// Registry file: ~/.claudecat/proxy-registry.json
//   { "todo-app": { port: 49201, projectId: "abc123" }, ... }
//
// Why not Traefik/nginx-proxy? Docker Desktop for Mac has socket
// compatibility issues with container-based proxies. A host-side
// Node.js proxy just works, and we already have Node as a dependency.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execSync, fork } from 'node:child_process';
import { log } from './logger.js';

const REGISTRY_DIR  = path.join(os.homedir(), '.claudecat');
const REGISTRY_PATH = path.join(REGISTRY_DIR, 'proxy-registry.json');
const PID_PATH      = path.join(REGISTRY_DIR, 'proxy.pid');
const PROXY_PORT    = 80;

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeRegistry(reg) {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

/**
 * Register a project slug → port mapping.
 */
export function registerProject(slug, port, projectId) {
  const reg = readRegistry();
  reg[slug] = { port, projectId, registeredAt: new Date().toISOString() };
  writeRegistry(reg);
}

/**
 * Remove a project from the registry.
 */
export function unregisterProject(slug) {
  const reg = readRegistry();
  delete reg[slug];
  writeRegistry(reg);
}

// ---------------------------------------------------------------------------
// Port allocation
// ---------------------------------------------------------------------------

/**
 * Find a free port on the host.
 */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Proxy server (runs as a detached background process)
// ---------------------------------------------------------------------------

/**
 * The actual proxy handler. Looks up the Host header in the registry
 * and forwards the request to the corresponding localhost port.
 */
function createProxyServer() {
  return http.createServer((req, res) => {
    const host = (req.headers.host || '').split(':')[0]; // strip port
    const slug = host.replace(/\.localhost$/, '');

    const reg = readRegistry();
    const entry = reg[slug];

    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body style="font-family:monospace;background:#121210;color:#e8e4d8;padding:40px">
          <h2>🐱 ClaudeCat — no project here</h2>
          <p>No project registered for <strong>${host}</strong></p>
          <p>Active projects:</p>
          <ul>${Object.entries(reg).map(([s, e]) =>
            `<li><a href="http://${s}.localhost" style="color:#9dc4ff">${s}.localhost</a> → :${e.port}</li>`
          ).join('') || '<li>none</li>'}</ul>
        </body></html>
      `);
      return;
    }

    // Forward the request to the project's mapped port
    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: entry.port,
      path: req.url,
      method: req.method,
      headers: req.headers,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', () => {
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body style="font-family:monospace;background:#121210;color:#e8e4d8;padding:40px">
          <h2>🐱 ClaudeCat — project offline</h2>
          <p><strong>${slug}</strong> is registered but not responding on port ${entry.port}.</p>
          <p>Try: <code>cd projects/${entry.projectId} && docker compose up -d</code></p>
        </body></html>
      `);
    });

    req.pipe(proxyReq);
  });
}

// ---------------------------------------------------------------------------
// Lifecycle: ensure proxy is running
// ---------------------------------------------------------------------------

function isProxyRunning() {
  try {
    const pid = parseInt(fs.readFileSync(PID_PATH, 'utf8').trim(), 10);
    process.kill(pid, 0); // signal 0 = check if alive
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the proxy is running. Starts it as a detached background
 * process if not already up.
 */
export async function ensureProxy() {
  if (isProxyRunning()) {
    log.dim('proxy', 'Reverse proxy already running on port 80');
    return;
  }

  // Check if port 80 is available
  const portFree = await new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(); resolve(true); });
    srv.listen(PROXY_PORT);
  });

  if (!portFree) {
    log.warn('proxy', 'Port 80 is in use — projects will use direct port URLs instead');
    return;
  }

  log.step('proxy', 'Starting reverse proxy on port 80');

  // Fork this file as a detached background process
  const child = fork(import.meta.filename, ['--serve'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Wait a moment for it to start
  await new Promise((r) => setTimeout(r, 500));

  if (isProxyRunning()) {
    log.ok('proxy', 'Proxy running — projects available at <name>.localhost');
  } else {
    log.warn('proxy', 'Proxy failed to start — projects will use direct port URLs');
  }
}

/**
 * Turn a user goal into a URL-safe slug for the subdomain.
 * "build me a simple todo app" → "todo-app"
 */
export function slugify(goal) {
  const stopWords = new Set([
    'a', 'an', 'the', 'me', 'my', 'i', 'build', 'create', 'make',
    'write', 'generate', 'simple', 'basic', 'please', 'want', 'need',
    'with', 'using', 'and', 'or', 'for', 'to', 'of', 'in', 'that',
  ]);

  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter((w) => w && !stopWords.has(w))
    .slice(0, 4)
    .join('-');

  return slug || 'project';
}

// ---------------------------------------------------------------------------
// If invoked directly with --serve, run the proxy server
// ---------------------------------------------------------------------------
if (process.argv.includes('--serve')) {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  const server = createProxyServer();
  server.listen(PROXY_PORT, () => {
    fs.writeFileSync(PID_PATH, String(process.pid));
    // Stays alive as a background daemon
  });

  // Clean up PID file on exit
  process.on('SIGTERM', () => { try { fs.unlinkSync(PID_PATH); } catch {} process.exit(0); });
  process.on('SIGINT',  () => { try { fs.unlinkSync(PID_PATH); } catch {} process.exit(0); });
}
