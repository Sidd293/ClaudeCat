// Handoff contracts are how workers communicate results without the
// orchestrator ever reading their thinking / tool output. This module
// reads them from disk and validates shape.
//
// Design note: we validate minimally. Overly strict schemas make workers
// fail for dumb reasons. We require `status` and `summary`, everything
// else is informational. If a worker wrote the handoff at all, it's
// probably fine.
import fs from 'node:fs/promises';
import path from 'node:path';

const REQUIRED_FIELDS = ['task_id', 'status', 'summary'];
const VALID_STATUSES = ['completed', 'failed'];

export class HandoffError extends Error {
  constructor(message, { taskId, reason } = {}) {
    super(message);
    this.taskId = taskId;
    this.reason = reason;
  }
}

/**
 * Reads and validates a handoff JSON from a project.
 * @param {string} projectDir - Absolute path to the project on the host.
 * @param {string} taskId - e.g., 'architect', 'coder'.
 * @returns {Promise<object>} the parsed handoff.
 * @throws {HandoffError} if missing, invalid JSON, or missing required fields.
 */
export async function readHandoff(projectDir, taskId) {
  const handoffPath = path.join(projectDir, '.claudecat', 'handoffs', `${taskId}.json`);

  let raw;
  try {
    raw = await fs.readFile(handoffPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new HandoffError(`No handoff written by ${taskId}`, {
        taskId, reason: 'missing',
      });
    }
    throw new HandoffError(`Could not read handoff for ${taskId}: ${e.message}`, {
      taskId, reason: 'io_error',
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new HandoffError(`Handoff for ${taskId} is not valid JSON: ${e.message}`, {
      taskId, reason: 'invalid_json',
    });
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in parsed)) {
      throw new HandoffError(`Handoff for ${taskId} missing required field: ${field}`, {
        taskId, reason: 'missing_field',
      });
    }
  }

  if (!VALID_STATUSES.includes(parsed.status)) {
    throw new HandoffError(
      `Handoff for ${taskId} has invalid status '${parsed.status}' (must be one of ${VALID_STATUSES.join(', ')})`,
      { taskId, reason: 'invalid_status' }
    );
  }

  return parsed;
}

/**
 * Verifies that files a handoff claims to have created actually exist
 * and are non-trivial. Cheap sanity check — catches workers that lied.
 *
 * @param {string} projectDir
 * @param {object} handoff
 * @returns {Promise<{ok: boolean, missing: string[], empty: string[]}>}
 */
export async function verifyHandoffFiles(projectDir, handoff) {
  const claimed = [
    ...(handoff.files_created || []),
    ...(handoff.files_modified || []),
  ];
  const missing = [];
  const empty = [];

  for (const rel of claimed) {
    const abs = path.join(projectDir, rel);
    try {
      const stat = await fs.stat(abs);
      if (stat.size < 2) empty.push(rel);
    } catch {
      missing.push(rel);
    }
  }

  return { ok: missing.length === 0 && empty.length === 0, missing, empty };
}
