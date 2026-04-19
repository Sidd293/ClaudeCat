# 🐱 ClaudeCat POC

> A sleeping cat orchestrates Claude Code workers inside Docker containers to build your projects.

This is a **v0 proof-of-concept** — a CLI that proves the core mechanism: an orchestrator spawning specialist "cats" (Claude Code instances) in a sandboxed container, coordinating them via structured handoffs written to disk.

No UI yet. That comes once the loop is fun.

## What it does

You type:
```bash
claudecat "build me a todo app with express and sqlite"
```

And it:

1. Creates a project directory on your machine.
2. Starts a Docker container with Node, Python, Claude Code, and your project dir mounted at `/workspace`.
3. Runs **Architect Cat** 📐 — writes a `spec.md` and a structured handoff.
4. Runs **Coder Cat** ⌨️ — reads the spec, implements it, installs deps.
5. Prints run instructions for the generated project.

The orchestrator **never reads worker thinking**. It only reads `.claudecat/handoffs/<task>.json` — structured summaries. This keeps token costs bounded and makes the workflow inspectable.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Host (your machine)                                         │
│                                                              │
│    orchestrator.js                                           │
│          │                                                   │
│          │ spawns                                            │
│          ▼                                                   │
│    ┌─────────────────────────────────────────┐               │
│    │ Docker container: claudecat-<projid>    │               │
│    │   /workspace  ←─ bind-mount to host ────┼── ~/claudecat │
│    │   │                                     │   /projects/  │
│    │   ├── spec.md            (architect)    │     <id>/     │
│    │   ├── src/...            (coder)        │               │
│    │   └── .claudecat/                       │               │
│    │       ├── handoffs/architect.json       │               │
│    │       ├── handoffs/coder.json           │               │
│    │       └── events/*.log                  │               │
│    │                                         │               │
│    │   Workers run here via `docker exec`:   │               │
│    │   claude -p "..." --append-system-prompt│               │
│    └─────────────────────────────────────────┘               │
└──────────────────────────────────────────────────────────────┘
```

### Handoff contract

Every worker writes `.claudecat/handoffs/<task_id>.json`:

```json
{
  "task_id": "architect",
  "status": "completed",
  "summary": "Designed a minimal Express+SQLite todo API",
  "files_created": ["spec.md"],
  "stack": ["node", "express", "sqlite"],
  "run_command": "npm install && npm start",
  "port": 3000,
  "assumptions_made": ["JSON body parsing; no auth for v0"],
  "open_questions": [],
  "handoff_to_next": "Coder implements per spec.md"
}
```

The orchestrator validates shape, verifies claimed files exist and are non-empty, and passes only relevant info to the next worker.

## Prerequisites

- **Node.js 20+**
- **Docker** (Desktop or Engine), daemon running
- **Anthropic API key** — [console.anthropic.com](https://console.anthropic.com/)
- ~1GB disk for the workspace image

## Setup

```bash
# 1. Install deps
npm install

# 2. Configure
cp .env.example .env
# then edit .env and set ANTHROPIC_API_KEY

# 3. Build the workspace image (one-time; takes 2-3 min)
npm run build-image
```

## Usage

```bash
node src/orchestrator.js "build me a simple express server that returns hello world"
```

Output goes into `./projects/<random-id>/`. The cats do their thing; when they're done you'll get run instructions.

## What's intentionally *not* in v0

These are all real, and will get built next. Not in the POC because shipping:

- **Retry logic.** If a worker fails, we stop. No retries, no user-prompted recovery.
- **LLM-driven planning.** The task sequence is hardcoded (architect → coder).
- **Parallel workers.** Serial only. No DAG scheduling.
- **Real skill marketplace.** Two built-in cats, loaded from `workers/*.md`.
- **Preview URL routing.** No Traefik yet — you run the app manually after.
- **Budget caps.** `CLAUDECAT_BUDGET_USD` is wired but not enforced.
- **UI.** No Electron, no pixel cat, no office view. Terminal only.

## Known gotchas

- **Claude Code version drift.** Prompt behavior can change between versions. The Dockerfile installs `@latest`; pin once you find a version that works reliably.
- **Docker socket not mounted.** Projects that need their own `docker compose up` (e.g., Postgres) won't work yet. Sibling-container support is next.
- **`--dangerously-skip-permissions`** is on inside the container. This is OK because the container is sandboxed with CPU/memory limits, but never do this on the host.
- **File permissions.** The container runs as UID 1000. On Linux hosts where your user isn't UID 1000, you may see permission issues on bind-mounted files. Easy fix: run the orchestrator with `--user $(id -u)` support (TODO).

## License

MIT
