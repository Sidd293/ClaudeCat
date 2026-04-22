// Worker: runs a single "cat" (Claude Code instance) inside the project
// container with a specific system prompt and task.
//
// Key decisions:
// - We use Claude Code's non-interactive mode (`--print` / `-p`).
//   This gives a one-shot run: stdin is the task, stdout is the final
//   response. No interactive prompts means no hanging.
// - System prompt is injected via `--append-system-prompt`.
// - `--dangerously-skip-permissions` is on because we're in a sandboxed
//   container. On the host we'd never do this. Inside Docker with
//   resource caps, the blast radius is bounded.
// - We do NOT read Claude Code's stdout into the orchestrator's context.
//   We read the handoff JSON from disk. Worker output is streamed to a
//   log file for debugging only.
import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from './logger.js';
import { readHandoff, verifyHandoffFiles, HandoffError } from './handoff.js';

/**
 * Run a worker (cat) on a task.
 *
 * @param {object} opts
 * @param {ProjectContainer} opts.container - Running project container.
 * @param {string} opts.projectDir - Host path (for reading handoff after).
 * @param {string} opts.taskId - e.g., 'architect', 'coder'.
 * @param {string} opts.systemPrompt - The cat's persona.
 * @param {string} opts.taskPrompt - What we want done.
 * @param {number} opts.timeoutMs
 * @returns {Promise<object>} the validated handoff.
 */
export async function runWorker({
  container,
  projectDir,
  taskId,
  systemPrompt,
  taskPrompt,
  model,
  timeoutMs = 10 * 60 * 1000,
}) {
  log.step(taskId, `Worker starting${model ? ` (model: ${model})` : ''}`);

  // Write the system prompt to a file inside the workspace so we don't
  // have to deal with shell-escaping multiline content. Claude Code can
  // read it from a file via --append-system-prompt "$(cat prompt.md)".
  const promptDir = path.join(projectDir, '.claudecat', 'prompts');
  await fs.mkdir(promptDir, { recursive: true });
  const systemPromptPath = path.join(promptDir, `${taskId}.system.md`);
  const taskPromptPath   = path.join(promptDir, `${taskId}.task.md`);

  // Inject the task ID so the worker knows what to name its handoff file,
  // regardless of what the system prompt template says.
  const systemWithId = systemPrompt +
    `\n\n## IMPORTANT: Your Task ID\n\n` +
    `Your task ID for this run is \`${taskId}\`.\n` +
    `Write your handoff to \`.claudecat/handoffs/${taskId}.json\` with \`"task_id": "${taskId}"\`.\n` +
    `This overrides any other task_id or filename mentioned above.\n`;

  await fs.writeFile(systemPromptPath, systemWithId);
  await fs.writeFile(taskPromptPath, taskPrompt);

  const logPath = path.join(projectDir, '.claudecat', 'events', `${taskId}.log`);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  let logFd = await fs.open(logPath, 'w');

  // The actual Claude Code invocation, as run inside the container.
  // -p <prompt>: non-interactive, print final response
  // --append-system-prompt: layered on top of the default CC system prompt
  // --dangerously-skip-permissions: skip per-tool approval (OK in sandbox)
  // --output-format stream-json: machine-readable output stream
  const cmdParts = [
    'cd /workspace &&',
    'claude',
    '--append-system-prompt "$(cat .claudecat/prompts/' + taskId + '.system.md)"',
    '--dangerously-skip-permissions',
    '--output-format stream-json',
    '--verbose',
  ];
  if (model) cmdParts.push(`--model ${model}`);
  cmdParts.push('-p "$(cat .claudecat/prompts/' + taskId + '.task.md)"');
  const cmd = cmdParts.join(' ');

  // ---------------------------------------------------------------------------
  // Retry loop — retries on 429 (rate limit) and 401 (expired token)
  // ---------------------------------------------------------------------------
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [30_000, 60_000, 120_000]; // 30s, 60s, 120s

  let handoff;
  let lastError;
  let logClosed = false;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delaySec = RETRY_DELAYS[attempt - 1] / 1000;
      log.warn(taskId, `Retrying in ${delaySec}s (attempt ${attempt + 1}/${MAX_RETRIES + 1})...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt - 1]));
      // Re-open log file for new attempt (append mode)
      if (!logClosed) await logFd.close().catch(() => {});
      logFd = await fs.open(logPath, 'a');
      logClosed = false;
      await logFd.write(`\n--- RETRY ATTEMPT ${attempt + 1} ---\n\n`);
    }

    const startedAt = Date.now();
    let exitCode;
    logClosed = false;
    try {
      const result = await container.exec(cmd, {
        timeoutMs,
        onOutput: (chunk, which) => {
          if (!logClosed) logFd.write(`[${which}] ${chunk}`).catch(() => {});
        },
      });
      exitCode = result.exitCode;
    } catch (e) {
      logClosed = true;
      await logFd.close().catch(() => {});
      log.err(taskId, `Worker crashed: ${e.message}`);
      throw new WorkerError(`Worker ${taskId} crashed: ${e.message}`, { taskId, reason: 'crash' });
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

    if (exitCode !== 0) {
      log.warn(taskId, `Exited with code ${exitCode} after ${elapsed}s`);

      // Check if this was a retryable error (429 or 401)
      if (await isRetryableError(logPath) && attempt < MAX_RETRIES) {
        log.warn(taskId, `Detected retryable error (rate limit or auth expiry)`);
        lastError = new WorkerError(`Worker ${taskId} hit retryable error`, { taskId, reason: 'retryable' });
        continue; // retry
      }
    } else {
      log.ok(taskId, `Completed in ${elapsed}s`);
    }

    // Try reading the handoff
    try {
      handoff = await readHandoff(projectDir, taskId);
    } catch (e) {
      if (e instanceof HandoffError && e.reason === 'missing') {
        const shimHandoff = await synthesizeHandoff(projectDir, taskId, exitCode);
        if (shimHandoff) {
          log.warn(taskId, `No handoff written — synthesized from produced files (worker likely hit rate limit or crashed)`);
          handoff = shimHandoff;
        } else if (attempt < MAX_RETRIES && exitCode !== 0) {
          // No files produced, exit code non-zero — retry
          lastError = new WorkerError(
            `Worker ${taskId} produced no handoff or files`,
            { taskId, reason: 'missing' }
          );
          continue;
        } else {
          throw new WorkerError(
            `Worker ${taskId} did not produce a valid handoff and no files were found. ` +
            `Check .claudecat/events/${taskId}.log for details.`,
            { taskId, reason: e.reason }
          );
        }
      } else if (e instanceof HandoffError) {
        throw new WorkerError(
          `Worker ${taskId} did not produce a valid handoff (${e.reason}). ` +
          `Check .claudecat/events/${taskId}.log for details.`,
          { taskId, reason: e.reason }
        );
      } else {
        throw e;
      }
    }

    // Got a handoff — break out of retry loop
    break;
  }

  if (!logClosed) await logFd.close().catch(() => {});

  if (!handoff) {
    throw lastError || new WorkerError(`Worker ${taskId} failed after ${MAX_RETRIES + 1} attempts`, { taskId, reason: 'max_retries' });
  }

  if (handoff.status === 'failed') {
    log.err(taskId, `Reported failure: ${handoff.summary}`);
    throw new WorkerError(`Worker ${taskId} reported failure: ${handoff.summary}`, {
      taskId, reason: 'reported_failure', handoff,
    });
  }

  // Cheap verification: did the files the handoff claims to have created
  // actually land on disk and have content?
  // Skip for synthesized handoffs — we already verified the files exist.
  if (!handoff._synthesized) {
    const verification = await verifyHandoffFiles(projectDir, handoff);
    if (!verification.ok) {
      log.warn(taskId, `Handoff verification failed. Missing: ${verification.missing.join(', ') || 'none'}. Empty: ${verification.empty.join(', ') || 'none'}`);
      throw new WorkerError(
        `Worker ${taskId} lied about what it produced. Missing: ${verification.missing.join(', ')}`,
        { taskId, reason: 'verification_failed', handoff }
      );
    }
  }

  log.ok(taskId, `Handoff verified: ${handoff.summary}`);
  return handoff;
}

/**
 * Check the worker log for retryable errors (429 rate limit, 401 auth expired).
 */
async function isRetryableError(logPath) {
  try {
    const logContent = await fs.readFile(logPath, 'utf8');
    // Check last 2000 chars for the error markers
    const tail = logContent.slice(-2000);
    return /\"api_error_status\":\s*(429|401)/.test(tail) ||
           /\"error\":\s*\"(rate_limit|authentication_failed)\"/.test(tail);
  } catch {
    return false;
  }
}

/**
 * Post-exec handoff shim. If a worker produced files but crashed before
 * writing its handoff (e.g., rate limit, timeout), scan the project dir
 * and synthesize a handoff so the pipeline can continue.
 */
async function synthesizeHandoff(projectDir, taskId, exitCode) {
  // Scan for key project files the worker likely created
  const keyFiles = [
    'server.js', 'app.js', 'index.js',
    'package.json',
    'Dockerfile', 'docker-compose.yml',
    'spec.md',
  ];

  const found = [];
  for (const f of keyFiles) {
    try {
      const stat = await fs.stat(path.join(projectDir, f));
      if (stat.size > 2) found.push(f);
    } catch { /* not found, skip */ }
  }

  // Also check public/ directory
  try {
    const publicDir = await fs.readdir(path.join(projectDir, 'public'));
    for (const f of publicDir) found.push(`public/${f}`);
  } catch { /* no public dir */ }

  // Only synthesize if the worker actually produced something meaningful
  if (found.length < 2) return null;

  const hasDockerCompose = found.includes('docker-compose.yml');
  const hasDockerfile = found.includes('Dockerfile');

  const shimHandoff = {
    task_id: taskId,
    status: 'completed',
    summary: `[auto-recovered] Worker exited (code ${exitCode}) before writing handoff. Found ${found.length} files on disk.`,
    files_created: found,
    run_command: hasDockerCompose ? 'docker compose up --build' : 'npm start',
    port: 3000,
    assumptions_made: ['Handoff was synthesized by orchestrator — worker did not self-report'],
    open_questions: [],
    _synthesized: true,
  };

  // Write the shim to disk so it's inspectable
  const handoffPath = path.join(projectDir, '.claudecat', 'handoffs', `${taskId}.json`);
  await fs.writeFile(handoffPath, JSON.stringify(shimHandoff, null, 2));

  return shimHandoff;
}

export class WorkerError extends Error {
  constructor(msg, { taskId, reason, handoff } = {}) {
    super(msg);
    this.taskId = taskId;
    this.reason = reason;
    this.handoff = handoff;
  }
}
