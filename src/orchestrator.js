#!/usr/bin/env node
// ClaudeCat Orchestrator — v0 POC.
//
// Usage:
//   node src/orchestrator.js "build me a todo app with express and sqlite"
//
// What it does:
//   1. Creates a project directory on the host.
//   2. Spins up a workspace Docker container with the dir mounted.
//   3. Runs architect cat → reads handoff → runs coder cat → reads handoff.
//   4. Attempts to run the produced app inside the container.
//   5. Leaves code on disk, prints a summary.
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execSync, spawn } from 'node:child_process';
import chalk from 'chalk';
import { log } from './logger.js';
import { ProjectContainer, sweepOrphans } from './container.js';
import { runWorker, WorkerError } from './worker.js';
import { planTasks } from './planner.js';
import { ensureProxy, slugify, findFreePort, registerProject } from './proxy.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const IMAGE  = process.env.CLAUDECAT_IMAGE || 'claudecat/workspace:latest';
const TIMEOUT = parseInt(process.env.CLAUDECAT_WORKER_TIMEOUT || '600', 10) * 1000;
const PROJECTS_ROOT = path.resolve(process.cwd(), 'projects');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function newProjectId() {
  // short, filesystem-safe, collision-resistant enough for local use
  return randomBytes(4).toString('hex');
}

function banner() {
  log.raw('');
  log.raw(chalk.bold.magenta('  ╭─────────────────────────────────────╮'));
  log.raw(chalk.bold.magenta('  │   🐱  ClaudeCat POC v0              │'));
  log.raw(chalk.bold.magenta('  │   cats orchestrating cats           │'));
  log.raw(chalk.bold.magenta('  ╰─────────────────────────────────────╯'));
  log.raw('');
}

function summary(projectId, projectDir, handoffs, slug) {
  log.raw('');
  log.raw(chalk.bold.green('  ═══════════════════════════════════════'));
  log.raw(chalk.bold.green(`  Project ${projectId} complete 🎉`));
  log.raw(chalk.bold.green('  ═══════════════════════════════════════'));
  log.raw('');
  log.raw(`  ${chalk.bold('Location:')} ${projectDir}`);
  log.raw('');
  for (const h of handoffs) {
    log.raw(`  ${chalk.bold(h.task_id)}: ${h.summary}`);
  }
  log.raw('');
  if (slug) {
    log.raw(`  ${chalk.bold.cyan(`🌐 App running at: http://${slug}.localhost`)}`);
    log.raw('');
    log.raw(`  ${chalk.bold('Stop it:')}`);
    log.raw(`    cd ${projectDir} && docker compose down`);
  } else {
    log.raw(`  ${chalk.bold('Run it:')}`);
    log.raw(`    cd ${projectDir}`);
    log.raw(`    docker compose up --build`);
  }
  log.raw('');
}

/**
 * Launch the generated project via docker compose.
 * Assigns a random free host port, writes a compose override to map it,
 * registers the slug → port mapping with the proxy.
 */
async function launchProject(projectDir, slug, projectId) {
  log.step('launcher', 'Building and starting project containers...');

  // Find a free host port so projects never collide
  const hostPort = await findFreePort();

  // Write a compose override that maps the app's port 3000 to our free port.
  // This avoids needing the coder to know about port allocation at all.
  const override = [
    'services:',
    '  app:',
    '    ports:',
    `      - "${hostPort}:3000"`,
    '',
  ].join('\n');

  await fs.writeFile(path.join(projectDir, 'docker-compose.override.yml'), override);

  try {
    execSync('docker compose up --build -d', {
      cwd: projectDir,
      stdio: 'pipe',
      timeout: 120_000,
    });

    // Register with the proxy so <slug>.localhost routes here
    registerProject(slug, hostPort, projectId);

    log.ok('launcher', `Project live at http://${slug}.localhost`);
    return slug;
  } catch (e) {
    log.err('launcher', `docker compose up failed: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  banner();

  const goal = process.argv.slice(2).join(' ').trim();
  if (!goal) {
    log.err('system', 'Usage: claudecat "<what you want built>"');
    process.exit(1);
  }

  const sessionId = randomBytes(4).toString('hex');
  const projectId = newProjectId();
  const projectSlug = slugify(goal);
  const projectDir = path.join(PROJECTS_ROOT, projectId);

  log.info('orchestrator', `Goal:       ${chalk.italic(goal)}`);
  log.info('orchestrator', `Session:    ${sessionId}`);
  log.info('orchestrator', `Project:    ${projectId} (${projectSlug})`);
  log.info('orchestrator', `Directory:  ${projectDir}`);
  log.info('orchestrator', `URL:        http://${projectSlug}.localhost`);

  // Clean up orphans from previous runs.
  await sweepOrphans(sessionId);

  // Create project directory & subdirs cats will write into.
  await fs.mkdir(path.join(projectDir, '.claudecat', 'handoffs'), { recursive: true });
  await fs.mkdir(path.join(projectDir, '.claudecat', 'events'),   { recursive: true });
  await fs.mkdir(path.join(projectDir, '.claudecat', 'prompts'),  { recursive: true });

  const container = new ProjectContainer({
    projectId, projectDir, image: IMAGE, sessionId,
  });

  const handoffs = [];
  let failed = false;

  try {
    await container.start();

    const tasks = await planTasks(goal);
    log.info('orchestrator', `Plan: ${tasks.map((t) => t.id).join(' → ')}`);

    for (const task of tasks) {
      try {
        const h = await runWorker({
          container,
          projectDir,
          taskId: task.id,
          systemPrompt: task.system,
          taskPrompt: task.task,
          timeoutMs: TIMEOUT,
        });
        handoffs.push(h);
      } catch (e) {
        failed = true;
        if (e instanceof WorkerError) {
          log.err('orchestrator', `Task '${e.taskId}' failed: ${e.message}`);
          if (e.handoff) handoffs.push(e.handoff);
        } else {
          log.err('orchestrator', `Unexpected error in '${task.id}': ${e.message}`);
        }
        break; // POC: stop on first failure. Retry logic comes later.
      }
    }

    if (!failed) {
      // Stop the workspace container before launching the project's own containers.
      await container.stop();
      await container.remove();

      // Ensure Traefik proxy + shared network are ready
      await ensureProxy();

      // Launch the project — proxy routes <slug>.localhost to the app
      const launchedSlug = await launchProject(projectDir, projectSlug, projectId);

      summary(projectId, projectDir, handoffs, launchedSlug);
    } else {
      log.raw('');
      log.err('orchestrator', `Run did not complete. Artifacts are in ${projectDir} for inspection.`);
      log.raw('');
      await container.stop();
      await container.remove();
    }
  } catch (e) {
    await container.stop().catch(() => {});
    await container.remove().catch(() => {});
    throw e;
  }

  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  log.err('system', `Fatal: ${e.stack || e.message}`);
  process.exit(1);
});
