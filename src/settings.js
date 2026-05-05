// Settings module — persists provider, auth, and model config.
//
// Settings are stored in ~/.claudecat/settings.json and loaded once
// at startup. The API layer (server.js) can update them at runtime.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { log } from './logger.js';

const SETTINGS_DIR = path.join(os.homedir(), '.claudecat');
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  auth: {
    method: 'keychain', // 'keychain', 'manual', 'ollama', 'openrouter', 'gemini', or 'huggingface'
    apiKey: null,
    ollamaBaseUrl: 'http://localhost:11434',
    openRouterApiKey: null,
    geminiApiKey: null,
    geminiProxyUrl: 'http://localhost:4000',
    hfToken: null,
    hfProxyUrl: 'http://localhost:4000',
  },
  models: {
    pm:       'claude-haiku-4-5-20251001',
    manager:  'claude-haiku-4-5-20251001',
    designer: 'claude-haiku-4-5-20251001',
    coder:    'claude-opus-4-6',
    devops:   'claude-haiku-4-5-20251001',
  },
  features: {
    designer:       false,
    designerImages: false,
    designerStyle:  '',
  },
};

let _settings = null;

/**
 * Load settings from disk, merging with defaults for any missing keys.
 */
export async function loadSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf8');
    const stored = JSON.parse(raw);
    _settings = deepMerge(structuredClone(DEFAULT_SETTINGS), stored);
  } catch {
    _settings = structuredClone(DEFAULT_SETTINGS);
  }
  return _settings;
}

/**
 * Save settings atomically (write to .tmp then rename).
 */
export async function saveSettings(settings) {
  _settings = deepMerge(structuredClone(DEFAULT_SETTINGS), settings);
  await fs.mkdir(SETTINGS_DIR, { recursive: true });
  const tmp = SETTINGS_PATH + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(_settings, null, 2));
  await fs.rename(tmp, SETTINGS_PATH);
  return _settings;
}

/**
 * Return current in-memory settings (call loadSettings first).
 */
export function getSettings() {
  if (!_settings) return structuredClone(DEFAULT_SETTINGS);
  return _settings;
}

/**
 * Return sanitized settings safe for the browser (API keys masked).
 */
export function getSafeSettings() {
  const s = structuredClone(getSettings());
  s.auth.apiKey = Boolean(s.auth.apiKey);
  s.auth.openRouterApiKey = Boolean(s.auth.openRouterApiKey);
  s.auth.geminiApiKey = Boolean(s.auth.geminiApiKey);
  s.auth.hfToken = Boolean(s.auth.hfToken);
  return s;
}

/**
 * Return { envName, envValue } for injecting into containers.
 */
export function getAuthEnvVar() {
  const s = getSettings();

  if (s.auth.method === 'ollama') {
    const baseUrl = s.auth.ollamaBaseUrl || 'http://localhost:11434';
    // Inside Docker, localhost means the container — remap to host
    const dockerBaseUrl = baseUrl.replace('localhost', 'host.docker.internal').replace('127.0.0.1', 'host.docker.internal');
    log.dim('docker', `Using Ollama at ${baseUrl} (container: ${dockerBaseUrl})`);
    return {
      envName: 'ANTHROPIC_API_KEY',
      envValue: 'ollama',
      extraEnv: { ANTHROPIC_BASE_URL: dockerBaseUrl },
    };
  }

  if (s.auth.method === 'openrouter') {
    const key = s.auth.openRouterApiKey;
    if (!key) throw new Error('OpenRouter API key not configured. Open settings to add it.');
    log.dim('docker', 'Using OpenRouter API key');
    return {
      envName: 'ANTHROPIC_API_KEY',
      envValue: '',
      extraEnv: {
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
        ANTHROPIC_AUTH_TOKEN: key,
      },
    };
  }

  if (s.auth.method === 'gemini') {
    const proxyUrl = s.auth.geminiProxyUrl || 'http://localhost:4000';
    const dockerProxyUrl = proxyUrl
      .replace('localhost', 'host.docker.internal')
      .replace('127.0.0.1', 'host.docker.internal');
    log.dim('docker', `Using Gemini via LiteLLM proxy at ${proxyUrl} (container: ${dockerProxyUrl})`);
    return {
      envName: 'ANTHROPIC_API_KEY',
      envValue: 'gemini',
      extraEnv: { ANTHROPIC_BASE_URL: dockerProxyUrl },
    };
  }

  if (s.auth.method === 'huggingface') {
    const proxyUrl = s.auth.hfProxyUrl || 'http://localhost:4000';
    const dockerProxyUrl = proxyUrl
      .replace('localhost', 'host.docker.internal')
      .replace('127.0.0.1', 'host.docker.internal');
    log.dim('docker', `Using HuggingFace via LiteLLM proxy at ${proxyUrl} (container: ${dockerProxyUrl})`);
    return {
      envName: 'ANTHROPIC_API_KEY',
      envValue: 'huggingface',
      extraEnv: { ANTHROPIC_BASE_URL: dockerProxyUrl },
    };
  }

  if (s.auth.method === 'manual') {
    const key = s.auth.apiKey;
    if (!key) throw new Error('Anthropic API key not configured. Open settings to add it.');
    log.dim('docker', 'Using manual Anthropic API key');
    return { envName: 'ANTHROPIC_API_KEY', envValue: key };
  }

  // Keychain (default)
  const token = extractOAuthToken();
  return { envName: 'ANTHROPIC_API_KEY', envValue: token };
}

/**
 * Return model assignments for the planner.
 */
export function getModels() {
  return getSettings().models;
}

/**
 * Return feature flags.
 */
export function getFeatures() {
  return getSettings().features || {};
}

/**
 * Return extra env vars to inject into containers (e.g. HF_TOKEN for designer images).
 */
export function getFeatureEnvVars() {
  const s = getSettings();
  const env = {};
  if (s.features?.designerImages && s.auth?.hfToken) {
    env.HF_TOKEN = s.auth.hfToken;
  }
  return env;
}

/**
 * Extract Claude Code OAuth access token from macOS Keychain.
 */
function extractOAuthToken() {
  try {
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    const creds = JSON.parse(raw);
    const token = creds?.claudeAiOauth?.accessToken;
    if (!token) throw new Error('No accessToken found in keychain credentials');
    log.dim('docker', 'OAuth token extracted from macOS Keychain');
    return token;
  } catch (e) {
    throw new Error(
      'Could not extract Claude Code credentials from macOS Keychain.\n' +
      'Make sure you are logged in: run `claude` in a terminal first.\n' +
      `Detail: ${e.message}`
    );
  }
}

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (
      source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
      target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
    ) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}
