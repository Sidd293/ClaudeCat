// Docker container lifecycle for a single project.
//
// Key design choices:
// - One container per project. Long-running (`sleep infinity`), we
//   `docker exec` workers into it rather than re-creating per task.
//   Saves 20-30s of cold-start per worker.
// - Bind-mount the host project dir to /workspace so the user can
//   watch files appear in their IDE in real time.
// - All containers get a `claudecat.session=<id>` label so we can sweep
//   orphans on next startup if we crash.
// - Network mode 'bridge' (default). Cats need internet for npm/pip.
//   Tightening this up is a v1 concern.
import path from 'node:path';
import Docker from 'dockerode';
import { log } from './logger.js';
import { getAuthEnvVar } from './settings.js';

const docker = new Docker();

export class ProjectContainer {
  constructor({ projectId, projectDir, image, sessionId }) {
    this.projectId = projectId;
    this.projectDir = projectDir;
    this.image = image;
    this.sessionId = sessionId;
    this.container = null;
  }

  async ensureImage() {
    try {
      await docker.getImage(this.image).inspect();
      log.dim('docker', `Image ${this.image} present`);
    } catch (e) {
      if (e.statusCode === 404) {
        throw new Error(
          `Image ${this.image} not found. Build it first:\n` +
          `  docker build -t ${this.image} -f docker/workspace.Dockerfile .`
        );
      }
      throw e;
    }
  }

  async start() {
    await this.ensureImage();

    log.step('docker', `Starting project container for ${this.projectId}`);

    // Get auth credentials from settings (Keychain, manual API key, or Ollama)
    const { envName, envValue, extraEnv } = getAuthEnvVar();
    const envVars = [`${envName}=${envValue}`];
    if (extraEnv) {
      for (const [k, v] of Object.entries(extraEnv)) envVars.push(`${k}=${v}`);
    }

    this.container = await docker.createContainer({
      Image: this.image,
      name: `claudecat-${this.projectId}`,
      Cmd: ['sleep', 'infinity'],
      Env: envVars,
      Labels: {
        'claudecat.project': this.projectId,
        'claudecat.session': this.sessionId,
      },
      HostConfig: {
        Binds: [`${this.projectDir}:/workspace`],
        AutoRemove: false,
        Memory: 2 * 1024 * 1024 * 1024,   // 2GB cap
        NanoCpus:   2 * 1_000_000_000,    // 2 CPU cap
      },
      WorkingDir: '/workspace',
    });

    await this.container.start();
    log.ok('docker', `Container ${this.container.id.slice(0, 12)} running`);
  }

  /**
   * Run a shell command inside the container. Streams output; returns exit code.
   * Not used for workers directly — see worker.js for that.
   */
  async exec(cmd, { timeoutMs = 60_000, onOutput } = {}) {
    if (!this.container) throw new Error('Container not started');

    const exec = await this.container.exec({
      Cmd: ['bash', '-lc', cmd],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: '/workspace',
      User: 'cat',
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        reject(new Error(`exec timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      // Docker multiplexes stdout/stderr on a single stream.
      docker.modem.demuxStream(
        stream,
        { write: (chunk) => { stdout += chunk; onOutput?.(chunk.toString(), 'stdout'); } },
        { write: (chunk) => { stderr += chunk; onOutput?.(chunk.toString(), 'stderr'); } },
      );

      stream.on('end', async () => {
        clearTimeout(timer);
        try {
          const info = await exec.inspect();
          resolve({ exitCode: info.ExitCode, stdout, stderr });
        } catch (e) { reject(e); }
      });
      stream.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }

  /** Expose a port from the container to the host. Used for preview URLs. */
  async getMappedPort(containerPort) {
    // For the POC, we'll use `docker run -p` style mapping later.
    // For now, we just return the container IP and let users run locally.
    const info = await this.container.inspect();
    const ports = info.NetworkSettings.Ports;
    const key = `${containerPort}/tcp`;
    return ports[key]?.[0]?.HostPort ?? null;
  }

  async stop() {
    if (!this.container) return;
    try {
      log.dim('docker', `Stopping container ${this.container.id.slice(0, 12)}`);
      await this.container.stop({ t: 2 });
    } catch (e) {
      if (e.statusCode !== 304 && e.statusCode !== 404) {
        log.warn('docker', `Stop failed: ${e.message}`);
      }
    }
  }

  async remove() {
    if (!this.container) return;
    try {
      await this.container.remove({ force: true });
      log.ok('docker', `Container removed`);
    } catch (e) {
      if (e.statusCode !== 404) log.warn('docker', `Remove failed: ${e.message}`);
    }
  }
}

/**
 * Sweep orphaned containers from previous runs. Call at startup.
 */
export async function sweepOrphans(currentSessionId) {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: ['claudecat.session'] },
  });

  const orphans = containers.filter(
    (c) => c.Labels['claudecat.session'] !== currentSessionId
  );

  if (orphans.length === 0) return;

  log.warn('docker', `Found ${orphans.length} orphan container(s) from prior runs, cleaning up`);
  for (const info of orphans) {
    try {
      const c = docker.getContainer(info.Id);
      await c.remove({ force: true });
    } catch (e) {
      log.warn('docker', `Couldn't remove orphan ${info.Id.slice(0, 12)}: ${e.message}`);
    }
  }
}
