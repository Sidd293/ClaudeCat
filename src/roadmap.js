import fs from 'node:fs/promises';
import path from 'node:path';

const ROADMAP_PATH = ['.claudecat', 'roadmap.json'];

export class RoadmapError extends Error {
  constructor(message, { reason } = {}) {
    super(message);
    this.reason = reason;
  }
}

export async function readRoadmap(projectDir) {
  const roadmapPath = path.join(projectDir, ...ROADMAP_PATH);

  let raw;
  try {
    raw = await fs.readFile(roadmapPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new RoadmapError('No roadmap written by Product Manager Kitty', {
        reason: 'missing',
      });
    }
    throw new RoadmapError(`Could not read roadmap: ${e.message}`, {
      reason: 'io_error',
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new RoadmapError(`Roadmap is not valid JSON: ${e.message}`, {
      reason: 'invalid_json',
    });
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new RoadmapError('Roadmap must be a JSON object', {
      reason: 'invalid_shape',
    });
  }
  if (!Array.isArray(parsed.slices) || parsed.slices.length === 0) {
    throw new RoadmapError('Roadmap must include at least one slice', {
      reason: 'missing_slices',
    });
  }

  const normalizedSlices = parsed.slices.map((slice, index) => normalizeSlice(slice, index));
  return {
    goal: typeof parsed.goal === 'string' ? parsed.goal.trim() : '',
    strategy: typeof parsed.strategy === 'string' ? parsed.strategy.trim() : '',
    slices: normalizedSlices,
  };
}

function normalizeSlice(slice, index) {
  if (!slice || typeof slice !== 'object') {
    throw new RoadmapError(`Slice ${index + 1} must be an object`, {
      reason: 'invalid_slice',
    });
  }

  const priority = Number.isInteger(slice.priority) ? slice.priority : index + 1;
  const title = asNonEmptyString(slice.title, `Slice ${index + 1} is missing a title`);
  const id = slugifyId(slice.id || title || `slice-${index + 1}`);

  return {
    id,
    priority,
    title,
    description: asOptionalString(slice.description),
    user_value: asOptionalString(slice.user_value),
    depends_on: asStringArray(slice.depends_on),
    acceptance_criteria: asStringArray(slice.acceptance_criteria),
    manager_notes: asOptionalString(slice.manager_notes),
    coder_notes: asOptionalString(slice.coder_notes),
    devops_notes: asOptionalString(slice.devops_notes),
  };
}

function asNonEmptyString(value, message) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new RoadmapError(message, { reason: 'missing_field' });
}

function asOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim());
}

function slugifyId(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

  return slug || 'slice';
}
