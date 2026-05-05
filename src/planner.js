// Planner: turns a user goal into a roadmap-driven task sequence.
//
// The Product Manager creates a prioritized roadmap of small, complete
// slices. Each slice is then executed in order by manager -> coder -> devops.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getModels, getFeatures } from './settings.js';

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
  const FEATURES = getFeatures();
  const managerSystem = await readSystemPrompt('architect');
  const designerSystem = FEATURES.designer ? await readSystemPrompt('designer') : null;
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

    if (FEATURES.designer && designerSystem) {
      tasks.push({
        id: `designer-${suffix}`,
        role: 'designer',
        slice,
        sliceIndex: index,
        sliceCount: sortedSlices.length,
        model: MODELS.designer,
        system: designerSystem,
        task: buildDesignerTask({ userGoal, roadmap, slice, index, isUpdate, features: FEATURES }),
      });
    }

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

function buildDesignerTask({ userGoal, roadmap, slice, index, isUpdate, features }) {
  const lines = [
    isUpdate
      ? `This is an UPDATE to an existing project in /workspace.`
      : `This project is being built incrementally in prioritized slices.`,
    ``,
    `Overall user goal: ${userGoal}`,
    `Roadmap strategy: ${roadmap.strategy || 'Build the product as a sequence of small complete slices.'}`,
    `Current slice: ${formatSliceLabel(index, slice)}`,
    ``,
    `Read /workspace/spec.md and /workspace/.claudecat/roadmap.json before designing.`,
    `Read /workspace/README.md if it exists to understand the current project state.`,
    `Design the UI/UX for the CURRENT SLICE ONLY. Do not design beyond what this slice delivers.`,
    ``,
    formatSliceDetails(slice),
  ];

  if (features.designerStyle) {
    lines.push(``, `Design style hint from user: ${features.designerStyle}`);
  }

  if (features.designerImages) {
    lines.push(
      ``,
      `Image generation is ENABLED. You have HF_TOKEN available as an environment variable.`,
      `Use the HuggingFace Inference API to generate images relevant to this slice.`,
      `Save generated images to /workspace/public/assets/ directory.`,
      `Use @huggingface/inference InferenceClient with provider "fal-ai".`,
      `Model rotation on 429/error: Tongyi-MAI/Z-Image-Turbo → black-forest-labs/FLUX.1-schnell → Qwen/Qwen-Image → stabilityai/stable-diffusion-xl-base-1.0`,
      `For background removal: use rembg Python library (pip install rembg). Save both raw and bg-removed versions.`,
      `Only generate images that add real visual value to the UI. Don't generate for the sake of it.`,
    );
  } else {
    lines.push(``, `Image generation is DISABLED. Design using CSS/SVG/gradients only. No external images.`);
  }

  lines.push(
    ``,
    `Write /workspace/.claudecat/design/${slice.id}.json with your complete design spec.`,
    `Write your handoff. The coder will read your design spec before implementing.`,
  );

  return lines.join('\n');
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
    `If /workspace/.claudecat/design/${slice.id}.json exists, read it and apply the design system — colors, fonts, spacing, animations, and any generated image paths — exactly as specified.`,
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
