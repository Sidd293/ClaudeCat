# ClaudeCat workspace image — where worker cats do their jobs.
# Pre-loaded with common tooling so cold-start is fast.
FROM node:20-bookworm

# Rename the existing UID-1000 'node' user to 'cat' and give it sudo.
RUN usermod -l cat -d /home/cat -m node \
    && groupmod -n cat node \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv \
        git curl jq ripgrep sudo ca-certificates \
    && echo "cat ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code globally.
# Pinning is important — prompt behavior changes between versions.
RUN npm install -g @anthropic-ai/claude-code@latest

# The shared workspace. Orchestrator bind-mounts the host project dir here.
RUN mkdir -p /workspace /workspace/.claudecat/handoffs /workspace/.claudecat/events \
    && chown -R cat:cat /workspace

USER cat
WORKDIR /workspace

# Default: idle. Orchestrator runs `docker exec` to launch workers.
CMD ["sleep", "infinity"]
