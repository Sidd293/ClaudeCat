// Planner: turns a user goal into a roadmap-driven task sequence.
//
// The Product Manager creates a prioritized roadmap of small, complete
// slices. Each slice is then executed in order by manager -> coder -> devops.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getModels } from './settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKERS_DIR = path.resolve(__dirname, '..', 'workers');

async function readSystemPrompt(name) {
  return fs.readFile(path.join(WORKERS_DIR, `${name}.md`), 'utf8');
}

export async function planRoadmapTask(userGoal, { isUpdate = false } = {}) {
  const MODELS = getModels();
  const pmSystem = await readSystemPrompt('product-manager');

  return {
    id: 'pm',
    role: 'pm',
    model: MODELS.pm,
    system: pmSystem,
    task: [
      isUpdate
        ? `This is an UPDATE to an existing project in /workspace.`
        : `This is a NEW project build. The workspace starts mostly empty.`,
      ``,
      `The user wants: ${userGoal}`,
      ``,
      isUpdate
        ? `Read /workspace/README.md first if it exists. Also read /workspace/spec.md if it exists.`
        : `Plan from the user's goal and produce a small-slice execution roadmap.`,
      `Break the work into prioritized slices that each leave the app in a runnable, user-valuable state.`,
      `Write .claudecat/roadmap.json and your handoff.`,
    ].join('\n'),
  };
}

export async function planExecutionTasks({ userGoal, roadmap, isUpdate = false }) {
  const MODELS = getModels();
  const managerSystem = await readSystemPrompt('architect');
  const coderSystem = await readSystemPrompt('coder');
  const devopsSystem = await readSystemPrompt('devops');

  const sortedSlices = [...roadmap.slices].sort((a, b) => a.priority - b.priority);
  const tasks = [];

  for (let index = 0; index < sortedSlices.length; index++) {
    const slice = sortedSlices[index];
    const ordinal = String(index + 1).padStart(2, '0');
    const suffix = `${ordinal}-${slice.id}`;

    tasks.push({
      id: `manager-${suffix}`,
      role: 'manager',
      slice,
      sliceIndex: index,
      sliceCount: sortedSlices.length,
      model: MODELS.manager,
      system: managerSystem,
      task: buildManagerTask({
        userGoal,
        roadmap,
        slice,
        index,
        isUpdate,
      }),
    });

    tasks.push({
      id: `coder-${suffix}`,
      role: 'coder',
      slice,
      sliceIndex: index,
      sliceCount: sortedSlices.length,
      model: MODELS.coder,
      system: coderSystem,
      task: buildCoderTask({
        userGoal,
        roadmap,
        slice,
        index,
        isUpdate,
      }),
    });

    tasks.push({
      id: `devops-${suffix}`,
      role: 'devops',
      slice,
      sliceIndex: index,
      sliceCount: sortedSlices.length,
      model: MODELS.devops,
      system: devopsSystem,
      task: buildDevopsTask({
        userGoal,
        roadmap,
        slice,
        index,
        isUpdate,
      }),
    });
  }

  return tasks;
}

function buildManagerTask({ userGoal, roadmap, slice, index, isUpdate }) {
  return [
    isUpdate
      ? `This is an incremental UPDATE to an existing project in /workspace.`
      : `This project is being built incrementally in prioritized slices.`,
    ``,
    `Overall user goal: ${userGoal}`,
    `Roadmap strategy: ${roadmap.strategy || 'Build the product as a sequence of small complete slices.'}`,
    `Current slice: ${formatSliceLabel(index, slice)}`,
    ``,
    `Read /workspace/.claudecat/roadmap.json before writing anything.`,
    `Read /workspace/README.md first if it exists so you preserve the current product state.`,
    `Read /workspace/spec.md if it exists, then update it for this slice.`,
    `Design ONLY the current slice while keeping the app runnable after this step.`,
    `Your spec must reflect the cumulative architecture after this slice, but the file changes list should focus on what needs to change now.`,
    `Produce spec.md and your handoff.`,
    ``,
    formatSliceDetails(slice),
    ``,
    `Keep the slice vertically integrated: a small but complete feature, not just plumbing.`,
  ].join('\n');
}

function buildCoderTask({ userGoal, slice, index, isUpdate }) {
  return [
    isUpdate
      ? `This is an incremental UPDATE to an existing project in /workspace.`
      : `This project is being built incrementally in small complete slices.`,
    ``,
    `Overall user goal: ${userGoal}`,
    `Current slice: ${formatSliceLabel(index, slice)}`,
    ``,
    `Read /workspace/README.md FIRST if it exists to understand the current project.`,
    `Then read /workspace/.claudecat/roadmap.json and /workspace/spec.md.`,
    `Implement ONLY the current slice while preserving everything already working.`,
    `Modify existing files rather than rewriting from scratch where possible.`,
    `Keep the project runnable after this slice completes.`,
    `Update README.md so it describes the cumulative product state after this slice.`,
    `Run the install step to catch errors. Then write your handoff.`,
    ``,
    formatSliceDetails(slice),
    ``,
    `If this slice depends on earlier slices, assume they are already present on disk and build on top of them.`,
  ].join('\n');
}

function buildDevopsTask({ userGoal, slice, index, isUpdate }) {
  return [
    isUpdate
      ? `The coder has finished an incremental update slice.`
      : `The coder has finished one prioritized build slice.`,
    ``,
    `Overall user goal: ${userGoal}`,
    `Current slice: ${formatSliceLabel(index, slice)}`,
    ``,
    `Read /workspace/README.md, /workspace/.claudecat/roadmap.json, and /workspace/spec.md if present.`,
    `Audit the infrastructure for the current cumulative project state.`,
    `Check Dockerfile, docker-compose.yml, .dockerignore, and verify the app can still start after this slice.`,
    `Write your handoff.`,
    ``,
    formatSliceDetails(slice),
  ].join('\n');
}

function formatSliceLabel(index, slice) {
  return `#${index + 1} (${slice.title})`;
}

function formatSliceDetails(slice) {
  return [
    `Slice title: ${slice.title}`,
    `Description: ${slice.description || 'No description provided.'}`,
    `User value: ${slice.user_value || 'Make meaningful user-facing progress.'}`,
    `Depends on: ${slice.depends_on.join(', ') || 'none'}`,
    formatList('Acceptance criteria', slice.acceptance_criteria),
    `Manager notes: ${slice.manager_notes || 'None.'}`,
    `Coder notes: ${slice.coder_notes || 'None.'}`,
    `DevOps notes: ${slice.devops_notes || 'None.'}`,
  ].join('\n');
}

function formatList(label, items) {
  if (!items.length) return `${label}: none`;
  return `${label}: ${items.map((item) => `- ${item}`).join(' ')}`;
}
