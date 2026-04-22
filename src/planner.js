// Planner: turns a user goal into a task sequence.
//
// POC decision: HARDCODED 2-step plan. architect → coder.
// Not an LLM-driven DAG yet. Why: we're proving the mechanism
// (worker -> handoff -> orchestrator reads handoff -> next worker).
// LLM planning is a well-understood extension we can bolt on once
// the mechanism works.
//
// The task prompts are where project-specific context gets injected.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getModels } from './settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKERS_DIR = path.resolve(__dirname, '..', 'workers');

async function readSystemPrompt(name) {
  return fs.readFile(path.join(WORKERS_DIR, `${name}.md`), 'utf8');
}

export async function planTasks(userGoal) {
  const MODELS = getModels();
  const managerSystem = await readSystemPrompt('architect');
  const coderSystem   = await readSystemPrompt('coder');
  const devopsSystem  = await readSystemPrompt('devops');

  return [
    {
      id: 'manager',
      model: MODELS.manager,
      system: managerSystem,
      task: [
        `The user wants: ${userGoal}`,
        ``,
        `Produce spec.md and your handoff. Keep the design minimal — single container, no external services.`,
      ].join('\n'),
    },
    {
      id: 'coder',
      model: MODELS.coder,
      system: coderSystem,
      task: [
        `Read /workspace/spec.md (just written by Manager Cat) and implement everything listed.`,
        ``,
        `Run the install step to catch errors. Then write your handoff.`,
        ``,
        `IMPORTANT: You MUST write a comprehensive README.md. This is mandatory — see your system prompt for details.`,
      ].join('\n'),
    },
    {
      id: 'devops',
      model: MODELS.devops,
      system: devopsSystem,
      task: [
        `The coder has finished building the project. Audit and harden the infrastructure for deployment.`,
        ``,
        `Check Dockerfile, docker-compose.yml, .dockerignore, and verify the app can start. Write your handoff.`,
      ].join('\n'),
    },
  ];
}

/**
 * Plan tasks for updating an existing project.
 * The project already has code, a README, and possibly a spec — the cats
 * read existing context and apply the user's change request.
 */
export async function planUpdateTasks(updateGoal) {
  const MODELS = getModels();
  const managerSystem = await readSystemPrompt('architect');
  const coderSystem   = await readSystemPrompt('coder');
  const devopsSystem  = await readSystemPrompt('devops');

  return [
    {
      id: 'manager',
      model: MODELS.manager,
      system: managerSystem,
      task: [
        `This is an UPDATE to an existing project. The project already has code in /workspace.`,
        ``,
        `Read /workspace/README.md first to understand the current state of the project.`,
        `Also read /workspace/spec.md if it exists for the original architecture.`,
        ``,
        `The user wants this change: ${updateGoal}`,
        ``,
        `Update spec.md to reflect the changes needed. Be specific about what files need to be modified vs created.`,
        `Keep existing functionality intact — only describe what changes.`,
        `Produce spec.md and your handoff.`,
      ].join('\n'),
    },
    {
      id: 'coder',
      model: MODELS.coder,
      system: coderSystem,
      task: [
        `This is an UPDATE to an existing project. Code already exists in /workspace.`,
        ``,
        `Read /workspace/README.md FIRST to understand the current project.`,
        `Then read /workspace/spec.md (just updated by Manager Cat) for what needs to change.`,
        ``,
        `Implement the changes described in spec.md. Preserve existing functionality.`,
        `Modify existing files rather than rewriting from scratch where possible.`,
        ``,
        `Run the install step to catch errors. Then write your handoff.`,
        ``,
        `IMPORTANT: Update README.md to reflect all changes. This is mandatory.`,
      ].join('\n'),
    },
    {
      id: 'devops',
      model: MODELS.devops,
      system: devopsSystem,
      task: [
        `The coder has finished updating the project. Audit and harden the infrastructure for deployment.`,
        ``,
        `Check Dockerfile, docker-compose.yml, .dockerignore, and verify the app can start. Write your handoff.`,
      ].join('\n'),
    },
  ];
}
