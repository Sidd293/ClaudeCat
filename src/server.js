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
import { planRoadmapTask, planExecutionTasks } from './planner.js';
import { ensureProxy, slugify, findFreePort, registerProject } from './proxy.js';
import { loadSettings, getSettings, getSafeSettings, saveSettings as persistSettings } from './settings.js';
import { readRoadmap } from './roadmap.js';

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
  checksum: '0000',       // 4-bit visual state: [orchestrator, pm/manager, coder, devops]
  url: null,              // final project URL for conference hall
  activeTask: null,
  tasks: [],              // completed task summaries
  kanbanItems: [],
  error: null,
};

function updateState(patch) {
  Object.assign(officeState, patch);
  broadcast('state', officeState);
}

function initializeKanban(roadmap) {
  const items = [...roadmap.slices]
    .sort((a, b) => a.priority - b.priority)
    .map((slice, index) => ({
      id: slice.id,
      order: index + 1,
      title: slice.title,
      description: slice.description || '',
      status: 'ready',
      currentRole: null,
      summary: '',
      error: null,
    }));

  updateState({ kanbanItems: items });
}

function patchKanbanItem(sliceId, patch) {
  const nextItems = officeState.kanbanItems.map((item) =>
    item.id === sliceId ? { ...item, ...patch } : item
  );
  updateState({ kanbanItems: nextItems });
}

function getTaskRole(task) {
  if (task?.role) return task.role;

  const id = typeof task === 'string' ? task : task?.id;
  if (!id) return null;
  if (id === 'pm' || id.startsWith('pm-')) return 'pm';
  if (id === 'manager' || id.startsWith('manager-') || id === 'architect' || id.startsWith('architect-')) return 'manager';
  if (id === 'coder' || id.startsWith('coder-')) return 'coder';
  if (id === 'devops' || id.startsWith('devops-')) return 'devops';
  return null;
}

function checksumForRole(role) {
  const bits = ['1', '0', '0', '0'];
  if (role === 'pm' || role === 'manager') bits[1] = '1';
  if (role === 'coder') bits[2] = '1';
  if (role === 'devops') bits[3] = '1';
  return bits.join('');
}

async function writeRoleAlias(projectDir, role, handoff) {
  if (!['manager', 'coder', 'devops'].includes(role)) return;

  const aliasPath = path.join(projectDir, '.claudecat', 'handoffs', `${role}.json`);
  const aliasHandoff = {
    ...handoff,
    task_id: role,
    source_task_id: handoff.task_id,
  };
  await fs.writeFile(aliasPath, JSON.stringify(aliasHandoff, null, 2));
}

async function executeTaskSequence({ container, projectDir, tasks, handoffs }) {
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const role = getTaskRole(task);

    if (role === 'devops') {
      const siblingCoderId = task.id.replace(/^devops/, 'coder');
      const coderHandoff = handoffs.find((h) => h.task_id === siblingCoderId);
      if (coderHandoff?._synthesized) {
        log.warn('orchestrator', `Skipping ${task.id} — coder output was auto-recovered and may be incomplete`);
        broadcast('task:start', { taskId: task.id, role, model: task.model, index: i, total: tasks.length, sliceTitle: task.slice?.title || null });
        broadcast('task:done', { taskId: task.id, role, summary: 'Skipped — coder output incomplete' });
        const skipped = {
          task_id: task.id,
          status: 'completed',
          summary: 'Skipped — coder output was auto-recovered',
          _skipped: true,
        };
        handoffs.push(skipped);
        await writeRoleAlias(projectDir, role, skipped);
        updateState({
          tasks: handoffs.map((h) => ({ id: h.task_id, summary: h.summary })),
        });
        if (task.slice?.id) {
          patchKanbanItem(task.slice.id, {
            status: 'done',
            currentRole: null,
            summary: skipped.summary,
            error: null,
          });
        }
        continue;
      }
    }

    updateState({ checksum: checksumForRole(role), activeTask: task.id });
    if (task.slice?.id) {
      patchKanbanItem(task.slice.id, {
        status: 'in_progress',
        currentRole: role,
        error: null,
      });
    }
    broadcast('task:start', {
      taskId: task.id,
      role,
      model: task.model,
      index: i,
      total: tasks.length,
      sliceTitle: task.slice?.title || null,
    });

    try {
      const handoff = await runWorker({
        container,
        projectDir,
        taskId: task.id,
        systemPrompt: task.system,
        taskPrompt: task.task,
        model: task.model,
        timeoutMs: TIMEOUT,
      });
      handoffs.push(handoff);
      await writeRoleAlias(projectDir, role, handoff);
      if (task.slice?.id) {
        patchKanbanItem(task.slice.id, {
          status: role === 'devops' ? 'done' : 'in_progress',
          currentRole: role === 'devops' ? null : role,
          summary: role === 'devops' ? handoff.summary : '',
          error: null,
        });
      }
      updateState({
        tasks: handoffs.map((h) => ({ id: h.task_id, summary: h.summary })),
      });
      broadcast('task:done', { taskId: task.id, role, summary: handoff.summary });
    } catch (e) {
      if (task.slice?.id) {
        patchKanbanItem(task.slice.id, {
          status: 'in_progress',
          currentRole: role,
          error: e.message,
        });
      }
      broadcast('task:error', { taskId: task.id, role, error: e.message });
      if (e instanceof WorkerError) {
        log.err('orchestrator', `Task '${e.taskId}' failed: ${e.message}`);
        if (e.handoff) handoffs.push(e.handoff);
      } else {
        log.err('orchestrator', `Unexpected error in '${task.id}': ${e.message}`);
      }
      throw new Error(`Task ${task.id} failed: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// BA Cat — contextual question generator
// ---------------------------------------------------------------------------
const BA_PROMPT = `You are a business analyst for a web app builder. Given a user's project idea, generate exactly 5 follow-up questions that would help a developer build exactly what the user wants.

Each question must have:
- "id": a short snake_case identifier
- "question": the question text (keep it concise, under 15 words)
- "options": array of 4-7 short selectable choices relevant to this specific project
- "placeholder": hint text for the free-text input (starts with "or ...")

Make questions SPECIFIC to the project — not generic. Cover: data/entities, user access, UI style, key features, and scope.

Respond with ONLY a JSON array. No markdown, no explanation. Example format:
[{"id":"data","question":"What fields should each dog profile have?","options":["Name","Breed","Age","Photo","Bio","Location"],"placeholder":"or describe your own fields..."}]`;

async function generateBAQuestions(goal) {
  try {
    const { execSync } = await import('node:child_process');
    const escaped = goal.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    const result = execSync(
      `claude --model claude-haiku-4-5-20251001 -p "Project idea: \\"${escaped}\\"" --append-system-prompt "${BA_PROMPT.replace(/"/g, '\\"')}" --output-format text 2>/dev/null`,
      { encoding: 'utf8', timeout: 30_000 }
    ).trim();

    // Extract JSON array from response (handle potential markdown wrapping)
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array in response');
    const questions = JSON.parse(jsonMatch[0]);

    if (!Array.isArray(questions) || questions.length === 0) throw new Error('Empty questions');
    // Validate shape
    return questions.filter(q => q.id && q.question && Array.isArray(q.options)).slice(0, 6);
  } catch (e) {
    log.warn('analyst', `AI question generation failed (${e.message}), using fallback`);
    return fallbackQuestions(goal);
  }
}

function fallbackQuestions(goal) {
  return [
    { id: 'data', question: 'What are the main data items in this app?', options: ['Text entries', 'Users', 'Images', 'Categories', 'Timestamps'], placeholder: 'or describe your entities...' },
    { id: 'auth', question: 'How should users access the app?', options: ['No login needed', 'Simple username', 'Email + password', 'Shared app'], placeholder: 'or describe your preference...' },
    { id: 'ui', question: 'Look & feel preferences?', options: ['Dark theme', 'Light theme', 'Minimal/Clean', 'Colorful', 'Mobile-friendly'], placeholder: 'or describe your style...' },
    { id: 'features', question: 'What key features should be included?', options: ['Search', 'Filters', 'CRUD operations', 'Real-time updates', 'Export'], placeholder: 'or describe your features...' },
    { id: 'extras', question: 'Anything else the cats should know?', options: ['Keep it simple', 'Add demo data', 'Loading states', 'Responsive'], placeholder: 'any other notes...' },
  ];
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

// Settings
app.get('/api/settings', (req, res) => {
  res.json(getSafeSettings());
});

app.post('/api/settings', async (req, res) => {
  const incoming = req.body;
  const current = getSettings();

  // Preserve existing API key when browser sends `true` (meaning "keep existing")
  if (incoming.auth?.apiKey === true) {
    incoming.auth.apiKey = current.auth.apiKey;
  }
  if (incoming.auth?.apiKey === '') {
    incoming.auth.apiKey = null;
  }

  await persistSettings(incoming);
  res.json(getSafeSettings());
});

// BA cat — generate follow-up questions for a goal
app.post('/api/analyze', async (req, res) => {
  const { goal } = req.body;
  if (!goal || typeof goal !== 'string') {
    return res.status(400).json({ error: 'goal is required' });
  }

  const questions = await generateBAQuestions(goal);
  res.json({ questions });
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

// List existing projects (for the projects panel)
app.get('/api/projects', async (req, res) => {
  try {
    let dirs;
    try {
      dirs = await fs.readdir(PROJECTS_ROOT);
    } catch {
      return res.json([]);
    }

    const projects = [];
    for (const dirName of dirs) {
      const projectDir = path.join(PROJECTS_ROOT, dirName);
      const stat = await fs.stat(projectDir).catch(() => null);
      if (!stat || !stat.isDirectory()) continue;

      // Try to read project metadata from handoffs and README
      const meta = { id: dirName, dir: projectDir, createdAt: stat.birthtime };

      // Read coder handoff for summary
      try {
        const coderHandoff = JSON.parse(
          await fs.readFile(path.join(projectDir, '.claudecat', 'handoffs', 'coder.json'), 'utf8')
        );
        meta.summary = coderHandoff.summary;
        meta.files = coderHandoff.files_created;
        meta.status = coderHandoff.status;
      } catch { /* no coder handoff */ }

      // Read manager handoff for the original goal
      try {
        const mgrHandoff = JSON.parse(
          await fs.readFile(path.join(projectDir, '.claudecat', 'handoffs', 'manager.json'), 'utf8')
        );
        meta.managerSummary = mgrHandoff.summary;
      } catch {
        // Try architect.json (older projects)
        try {
          const archHandoff = JSON.parse(
            await fs.readFile(path.join(projectDir, '.claudecat', 'handoffs', 'architect.json'), 'utf8')
          );
          meta.managerSummary = archHandoff.summary;
        } catch { /* no manager handoff */ }
      }

      // Check for README
      try {
        await fs.access(path.join(projectDir, 'README.md'));
        meta.hasReadme = true;
      } catch {
        meta.hasReadme = false;
      }

      // Read the original goal from the PM prompt if available.
      try {
        const taskPrompt = await fs.readFile(
          path.join(projectDir, '.claudecat', 'prompts', 'pm.task.md'), 'utf8'
        );
        const goalMatch = taskPrompt.match(/The user wants:\s*(.+)/);
        if (goalMatch) meta.goal = goalMatch[1].trim();
      } catch {
        // Fall back to older manager prompt format.
        try {
          const taskPrompt = await fs.readFile(
            path.join(projectDir, '.claudecat', 'prompts', 'manager.task.md'), 'utf8'
          );
          const goalMatch = taskPrompt.match(/The user wants:\s*(.+)/);
          if (goalMatch) meta.goal = goalMatch[1].trim();
        } catch { /* no task prompt */ }
      }

      // Check if it has docker-compose (i.e. was successfully built)
      try {
        await fs.access(path.join(projectDir, 'docker-compose.yml'));
        meta.hasCompose = true;
      } catch {
        meta.hasCompose = false;
      }

      // Only include projects that have at least a handoff or compose file
      if (meta.summary || meta.managerSummary || meta.hasCompose) {
        projects.push(meta);
      }
    }

    // Sort newest first
    projects.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(projects);
  } catch (e) {
    log.err('server', `Failed to list projects: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Read a project's README
app.get('/api/projects/:id/readme', async (req, res) => {
  const projectDir = path.join(PROJECTS_ROOT, req.params.id);
  try {
    const readme = await fs.readFile(path.join(projectDir, 'README.md'), 'utf8');
    res.json({ readme });
  } catch {
    res.status(404).json({ error: 'No README found for this project' });
  }
});

// Trigger an iterative rebuild on an existing project
app.post('/api/rebuild', (req, res) => {
  const { projectId, goal } = req.body;
  if (!projectId || !goal || typeof goal !== 'string') {
    return res.status(400).json({ error: 'projectId and goal are required' });
  }
  if (officeState.phase === 'building') {
    return res.status(409).json({ error: 'A build is already in progress' });
  }

  const projectDir = path.join(PROJECTS_ROOT, projectId);

  // Derive slug from the update goal
  const projectSlug = slugify(goal);

  res.json({ projectId, slug: projectSlug, status: 'rebuilding' });

  runRebuild(goal, projectId, projectSlug, projectDir).catch((e) => {
    log.err('server', `Rebuild failed: ${e.message}`);
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
    kanbanItems: [],
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
    const pmTask = await planRoadmapTask(goal);
    await executeTaskSequence({
      container,
      projectDir,
      tasks: [pmTask],
      handoffs,
    });

    const roadmap = await readRoadmap(projectDir);
    initializeKanban(roadmap);
    const executionTasks = await planExecutionTasks({ userGoal: goal, roadmap });
    log.info('orchestrator', `Roadmap: ${roadmap.slices.map((slice) => slice.title).join(' → ')}`);
    log.info('orchestrator', `Execution plan: ${executionTasks.map((t) => t.id).join(' → ')}`);

    await executeTaskSequence({
      container,
      projectDir,
      tasks: executionTasks,
      handoffs,
    });

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
    updateState({ phase: 'error', error: e.message, checksum: '1000', activeTask: null });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Rebuild pipeline — iterative updates on an existing project
// ---------------------------------------------------------------------------
async function runRebuild(goal, projectId, projectSlug, projectDir) {
  const sessionId = randomBytes(4).toString('hex');

  log.info('orchestrator', `Rebuild: ${chalk.italic(goal)}`);
  log.info('orchestrator', `Project: ${projectId}`);

  updateState({
    phase: 'building',
    goal: `[update] ${goal}`,
    slug: projectSlug,
    projectId,
    checksum: '1000',
    url: null,
    activeTask: null,
    tasks: [],
    kanbanItems: [],
    error: null,
  });

  await sweepOrphans(sessionId);

  // Ensure .claudecat dirs exist (they should from the original build)
  await fs.mkdir(path.join(projectDir, '.claudecat', 'handoffs'), { recursive: true });
  await fs.mkdir(path.join(projectDir, '.claudecat', 'events'), { recursive: true });
  await fs.mkdir(path.join(projectDir, '.claudecat', 'prompts'), { recursive: true });

  // Stop any running containers for this project before rebuilding
  try {
    execSync('docker compose down', {
      cwd: projectDir, stdio: 'pipe', timeout: 30_000,
    });
    log.dim('orchestrator', 'Stopped existing project containers');
  } catch { /* not running, that's fine */ }

  // Clear old handoffs so workers start fresh
  const handoffDir = path.join(projectDir, '.claudecat', 'handoffs');
  try {
    const oldHandoffs = await fs.readdir(handoffDir);
    for (const f of oldHandoffs) {
      await fs.unlink(path.join(handoffDir, f));
    }
  } catch { /* empty or missing */ }

  const container = new ProjectContainer({
    projectId, projectDir, image: IMAGE, sessionId,
  });

  const handoffs = [];

  try {
    await container.start();
    const pmTask = await planRoadmapTask(goal, { isUpdate: true });
    await executeTaskSequence({
      container,
      projectDir,
      tasks: [pmTask],
      handoffs,
    });

    const roadmap = await readRoadmap(projectDir);
    initializeKanban(roadmap);
    const executionTasks = await planExecutionTasks({ userGoal: goal, roadmap, isUpdate: true });
    log.info('orchestrator', `Update roadmap: ${roadmap.slices.map((slice) => slice.title).join(' → ')}`);
    log.info('orchestrator', `Update execution plan: ${executionTasks.map((t) => t.id).join(' → ')}`);

    await executeTaskSequence({
      container,
      projectDir,
      tasks: executionTasks,
      handoffs,
    });

    // All tasks done — relaunch the updated project
    await container.stop();
    await container.remove();

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
    log.ok('launcher', `Updated project live at ${projectUrl}`);

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
    updateState({ phase: 'error', error: e.message, checksum: '1000', activeTask: null });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
loadSettings().then(() => {
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
});
