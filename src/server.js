#!/usr/bin/env node
// ClaudeCat Server — serves the cat-office UI and orchestrates builds.
//
// The office HTML connects via Server-Sent Events (SSE) to get live
// updates as cats are spawned and tasks complete. When the project is
// done, the conference hall iframe loads the final app URL.
import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { log } from './logger.js';
import { ProjectContainer, sweepOrphans } from './container.js';
import { runWorker, WorkerError } from './worker.js';
import { planTasks } from './planner.js';
import { ensureProxy, slugify, findFreePort, registerProject } from './proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SERVER_PORT = parseInt(process.env.CLAUDECAT_SERVER_PORT || '3333', 10);
const IMAGE = process.env.CLAUDECAT_IMAGE || 'claudecat/workspace:latest';
const TIMEOUT = parseInt(process.env.CLAUDECAT_WORKER_TIMEOUT || '600', 10) * 1000;
const PROJECTS_ROOT = path.resolve(ROOT, 'projects');

// ---------------------------------------------------------------------------
// SSE — broadcast events to all connected cat-office clients
// ---------------------------------------------------------------------------
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

// Current office state — shared across SSE reconnects
const officeState = {
  phase: 'idle',          // idle | building | done | error
  goal: null,
  slug: null,
  projectId: null,
  checksum: '0000',       // 4-bit: [orchestrator, manager, coder, devops]
  url: null,              // final project URL for conference hall
  activeTask: null,
  tasks: [],              // completed task summaries
  error: null,
};

function updateState(patch) {
  Object.assign(officeState, patch);
  broadcast('state', officeState);
}

// ---------------------------------------------------------------------------
// Express server
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// Serve cat-office.html at root
app.get('/', async (req, res) => {
  const htmlPath = path.join(ROOT, 'cat-office.html');
  const html = await fs.readFile(htmlPath, 'utf8');
  res.type('html').send(html);
});

// Serve static assets (sprites, etc.)
app.use('/stripes', express.static(path.join(ROOT, 'stripes')));

// SSE endpoint — cat-office connects here for live updates
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`event: state\ndata: ${JSON.stringify(officeState)}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// Current state (for polling fallback)
app.get('/api/state', (req, res) => {
  res.json(officeState);
});

// Trigger a build
app.post('/api/build', (req, res) => {
  const { goal } = req.body;
  if (!goal || typeof goal !== 'string') {
    return res.status(400).json({ error: 'goal is required' });
  }
  if (officeState.phase === 'building') {
    return res.status(409).json({ error: 'A build is already in progress' });
  }

  const projectSlug = slugify(goal);
  const projectId = randomBytes(4).toString('hex');

  res.json({ projectId, slug: projectSlug, status: 'started' });

  // Run the build in the background
  runBuild(goal, projectId, projectSlug).catch((e) => {
    log.err('server', `Build failed: ${e.message}`);
    updateState({ phase: 'error', error: e.message, checksum: '0000' });
  });
});

// ---------------------------------------------------------------------------
// Build pipeline (same logic as orchestrator.js, but with SSE events)
// ---------------------------------------------------------------------------
async function runBuild(goal, projectId, projectSlug) {
  const sessionId = randomBytes(4).toString('hex');
  const projectDir = path.join(PROJECTS_ROOT, projectId);

  log.info('orchestrator', `Goal: ${chalk.italic(goal)}`);
  log.info('orchestrator', `Project: ${projectId} (${projectSlug})`);

  // Phase: starting — orchestrator cat appears in main office
  updateState({
    phase: 'building',
    goal,
    slug: projectSlug,
    projectId,
    checksum: '1000',
    url: null,
    activeTask: null,
    tasks: [],
    error: null,
  });

  await sweepOrphans(sessionId);
  await fs.mkdir(path.join(projectDir, '.claudecat', 'handoffs'), { recursive: true });
  await fs.mkdir(path.join(projectDir, '.claudecat', 'events'), { recursive: true });
  await fs.mkdir(path.join(projectDir, '.claudecat', 'prompts'), { recursive: true });

  const container = new ProjectContainer({
    projectId, projectDir, image: IMAGE, sessionId,
  });

  const handoffs = [];

  try {
    await container.start();
    const allTasks = await planTasks(goal);
    log.info('orchestrator', `Plan: ${allTasks.map((t) => t.id).join(' → ')}`);

    for (let i = 0; i < allTasks.length; i++) {
      const task = allTasks[i];

      // Update checksum: bit 0 = orchestrator (always on), bit 1 = manager, bit 2 = coder, bit 3 = devops
      const bits = ['1', '0', '0', '0'];
      if (task.id === 'manager') bits[1] = '1';
      if (task.id === 'coder') bits[2] = '1';
      if (task.id === 'devops') bits[3] = '1';
      updateState({ checksum: bits.join(''), activeTask: task.id });

      broadcast('task:start', { taskId: task.id, index: i, total: allTasks.length });

      try {
        const h = await runWorker({
          container, projectDir,
          taskId: task.id,
          systemPrompt: task.system,
          taskPrompt: task.task,
          timeoutMs: TIMEOUT,
        });
        handoffs.push(h);
        updateState({
          tasks: handoffs.map((h) => ({ id: h.task_id, summary: h.summary })),
        });
        broadcast('task:done', { taskId: task.id, summary: h.summary });
      } catch (e) {
        broadcast('task:error', { taskId: task.id, error: e.message });

        if (e instanceof WorkerError) {
          log.err('orchestrator', `Task '${e.taskId}' failed: ${e.message}`);
          if (e.handoff) handoffs.push(e.handoff);
        } else {
          log.err('orchestrator', `Unexpected error in '${task.id}': ${e.message}`);
        }

        updateState({
          phase: 'error',
          error: `Task ${task.id} failed: ${e.message}`,
          checksum: '1000',
          activeTask: null,
        });
        await container.stop().catch(() => {});
        await container.remove().catch(() => {});
        return;
      }
    }

    // All tasks done — launch the project
    await container.stop();
    await container.remove();

    // Orchestrator + devops active during launch
    updateState({ checksum: '1001', activeTask: 'launching' });
    broadcast('launch:start', {});

    await ensureProxy();

    const hostPort = await findFreePort();
    const override = [
      'services:', '  app:', '    ports:', `      - "${hostPort}:3000"`, '',
    ].join('\n');
    await fs.writeFile(path.join(projectDir, 'docker-compose.override.yml'), override);

    try {
      execSync('docker compose up --build -d', {
        cwd: projectDir, stdio: 'pipe', timeout: 120_000,
      });
      registerProject(projectSlug, hostPort, projectId);
    } catch (e) {
      log.err('launcher', `docker compose up failed: ${e.message}`);
      updateState({ phase: 'error', error: `Launch failed: ${e.message}`, checksum: '0000' });
      return;
    }

    const projectUrl = `http://${projectSlug}.localhost`;
    log.ok('launcher', `Project live at ${projectUrl}`);

    // Final state: show the URL in the conference hall, all cats celebrate
    updateState({
      phase: 'done',
      checksum: '1111',
      url: projectUrl,
      activeTask: null,
    });
    broadcast('launch:done', { url: projectUrl, slug: projectSlug });

  } catch (e) {
    await container.stop().catch(() => {});
    await container.remove().catch(() => {});
    updateState({ phase: 'error', error: e.message, checksum: '0000' });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(SERVER_PORT, () => {
  log.raw('');
  log.raw(chalk.bold.magenta('  ╭─────────────────────────────────────╮'));
  log.raw(chalk.bold.magenta('  │   🐱  ClaudeCat Office Server       │'));
  log.raw(chalk.bold.magenta('  │   cats orchestrating cats           │'));
  log.raw(chalk.bold.magenta('  ╰─────────────────────────────────────╯'));
  log.raw('');
  log.raw(`  ${chalk.bold('Open the office:')} ${chalk.cyan(`http://localhost:${SERVER_PORT}`)}`);
  log.raw('');
});
