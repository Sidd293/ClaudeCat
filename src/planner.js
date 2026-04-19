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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKERS_DIR = path.resolve(__dirname, '..', 'workers');

async function readSystemPrompt(name) {
  return fs.readFile(path.join(WORKERS_DIR, `${name}.md`), 'utf8');
}

export async function planTasks(userGoal) {
  const managerSystem = await readSystemPrompt('architect');
  const coderSystem   = await readSystemPrompt('coder');
  const devopsSystem  = await readSystemPrompt('devops');

  return [
    {
      id: 'manager',
      system: managerSystem,
      task: [
        `The user wants: ${userGoal}`,
        ``,
        `Produce spec.md and your handoff. Keep the design minimal — single container, no external services.`,
      ].join('\n'),
    },
    {
      id: 'coder',
      system: coderSystem,
      task: [
        `Read /workspace/spec.md (just written by Manager Cat) and implement everything listed.`,
        ``,
        `Run the install step to catch errors. Then write your handoff.`,
      ].join('\n'),
    },
    {
      id: 'devops',
      system: devopsSystem,
      task: [
        `The coder has finished building the project. Audit and harden the infrastructure for deployment.`,
        ``,
        `Check Dockerfile, docker-compose.yml, .dockerignore, and verify the app can start. Write your handoff.`,
      ].join('\n'),
    },
  ];
}
