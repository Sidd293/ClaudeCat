# ClaudeCat

> A local multi-agent app builder with a pixel-art office, Docker workspaces, and structured worker handoffs.

ClaudeCat runs a small team of specialist "cats" to build or update projects on your machine. It gives you a browser UI for starting builds, streams live progress over SSE, launches each generated app in Docker, and routes finished projects to local URLs like `http://todo-app.localhost`.

## What it does

- Starts a local "office" server and pixel-art UI.
- Creates one Docker workspace container per project.
- Runs a roadmap-driven worker chain: `pm` -> `manager` -> `coder` -> `devops`.
- Passes results through `.claudecat/handoffs/*.json` instead of raw model output.
- Launches finished projects with `docker compose`.
- Supports iterative rebuilds on existing projects.
- Stores settings in `~/.claudecat/settings.json`.

There is also a CLI entrypoint for one-shot runs, but the web office is now the main experience.

## How it works

1. You enter a goal in the office UI.
2. ClaudeCat creates `projects/<project-id>/` on the host.
3. A long-lived Docker workspace container mounts that directory at `/workspace`.
4. Product Manager Kitty writes `.claudecat/roadmap.json`, breaking the work into small prioritized slices.
5. For each slice, the planner assigns prompts for:
   - `manager`: update or write `spec.md` for that slice
   - `coder`: implement that slice and update `README.md`
   - `devops`: audit deployment files and startup path for the cumulative project
6. Each worker writes a handoff JSON file into `.claudecat/handoffs/`.
7. After all slices pass, ClaudeCat runs `docker compose up --build -d`.
8. A lightweight host-side proxy maps `<slug>.localhost` to the app's exposed port.

The orchestrator reads handoffs, not chain-of-thought or tool transcripts. That keeps the workflow inspectable and bounded.

## Main pieces

- [src/server.js](src/server.js): Express server, SSE events, build/rebuild APIs, project listing, settings APIs
- [src/planner.js](src/planner.js): roadmap-driven task planning for new builds and updates
- [src/roadmap.js](src/roadmap.js): roadmap loading and validation
- [src/worker.js](src/worker.js): runs Claude Code inside the workspace container, retries on auth/rate-limit failures, validates handoffs
- [src/container.js](src/container.js): Docker image checks, container lifecycle, `docker exec` helper, orphan cleanup
- [src/proxy.js](src/proxy.js): host-side reverse proxy and slug registry
- [src/settings.js](src/settings.js): persisted auth and model configuration
- [cat-office.html](cat-office.html): browser UI

## Requirements

- Node.js 18+
- Docker with the daemon running
- Claude Code installed on the host if you want to use keychain-based auth
- One of:
  - Claude Code login available in macOS Keychain
  - a manually entered Anthropic API key
  - a local Ollama endpoint

## Setup

```bash
npm install
npm run build-image
npm start
```

Then open `http://localhost:3333`.

Environment variables:

- `CLAUDECAT_SERVER_PORT`: office server port, default `3333`
- `CLAUDECAT_IMAGE`: workspace image tag, default `claudecat/workspace:latest`
- `CLAUDECAT_WORKER_TIMEOUT`: per-worker timeout in seconds, default `600`

## Auth and settings

ClaudeCat stores settings in `~/.claudecat/settings.json`.

Supported auth modes:

- `keychain`: default; extracts Claude Code OAuth credentials from macOS Keychain
- `manual`: uses a saved Anthropic API key
- `ollama`: points workers at a local Ollama-compatible base URL

Default model roles:

- `pm`: `claude-haiku-4-5-20251001`
- `manager`: `claude-haiku-4-5-20251001`
- `coder`: `claude-opus-4-6`
- `devops`: `claude-haiku-4-5-20251001`

## Using the office

From the browser UI you can:

- start a new build from a natural-language prompt
- generate follow-up BA questions for clarification
- watch live task progress through SSE
- inspect previously generated projects
- read a project's generated `README.md`
- trigger an update/rebuild for an existing project

Finished projects are launched from their project directory with `docker compose`, and ClaudeCat registers a slug for local routing.

## CLI usage

The original CLI flow still exists:

```bash
node src/orchestrator.js "build me a simple express server that returns hello world"
```

or after installation:

```bash
claudecat "build me a todo app with express and sqlite"
```

This path runs the same core orchestration logic without the office UI.

## Generated project layout

Each project is created under `projects/<project-id>/`.

Common artifacts:

- `spec.md`
- app source files
- `.claudecat/roadmap.json`
- `docker-compose.yml` and related deployment files
- `.claudecat/prompts/*.md`
- `.claudecat/events/*.log`
- `.claudecat/handoffs/*.json`

Example PM roadmap shape:

```json
{
  "goal": "Build a small CRM",
  "strategy": "Ship the product as vertical slices in priority order",
  "slices": [
    {
      "id": "foundation",
      "priority": 1,
      "title": "Basic contact list and create flow",
      "description": "Users can add and view contacts",
      "user_value": "The app is usable from the first slice",
      "depends_on": [],
      "acceptance_criteria": ["Contacts can be created and listed"],
      "manager_notes": "Keep the first slice minimal but complete",
      "coder_notes": "Preserve room for later contact detail features",
      "devops_notes": "Keep compose ready after this slice"
    }
  ]
}
```

Example handoff shape:

```json
{
  "task_id": "coder-01-foundation",
  "status": "completed",
  "summary": "Implemented the foundation slice and updated the README",
  "files_created": ["src/index.js", "README.md"],
  "files_modified": ["package.json"]
}
```

## Workspace image

The workspace Docker image is defined in [docker/workspace.Dockerfile](docker/workspace.Dockerfile). It currently includes:

- Node 20
- Python 3 tooling
- `git`, `curl`, `jq`, `ripgrep`, `sudo`
- global `@anthropic-ai/claude-code`

Workers run inside that container as the `cat` user with `/workspace` bind-mounted from the host project directory.

## Notes and limitations

- Planning is roadmap-driven but still sequential, not DAG-based or parallel.
- Workers run sequentially; there is no parallel execution yet.
- The reverse proxy prefers port `80` for `<slug>.localhost`. If that port is unavailable, friendly local domains may not work.
- The default keychain auth flow is macOS-specific because it reads from the `security` CLI.
- `--dangerously-skip-permissions` is used inside the sandboxed worker container.
- Some generated apps may still need manual polish; this repo is orchestrating the workflow, not guaranteeing perfect app quality.

## Scripts

- `npm start`: start the office server
- `npm run cli -- "<goal>"`: run the CLI orchestrator
- `npm run build-image`: build the workspace image

## License

MIT
