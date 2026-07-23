import express from 'express';
import { getSettings, transformSettingsBatch } from './db.mjs';
import { sendUnauthenticated } from './auth.mjs';

// The four settings namespaces the account page can read and write.
const NAMESPACES = ['profile', 'train-eval', 'results-sheet', 'session-viewer'];
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CLUSTER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BARE_ENV_VALUE = /^[A-Za-z0-9._/:@=+,-]+$/;
const USERNAME = /^[A-Za-z0-9._-]+$/;
const RESERVED_USERNAME_TOKENS = new Set(['train', 'eval', 'resume']);

// Built-in cluster setting contracts. These are UI/schema defaults only;
// account values still come exclusively from SQLite. The keys mirror the
// existing train-eval cluster templates and runtime configuration fields.
export const DEFAULT_CLUSTER_ENVS = Object.freeze({
  kakao: Object.freeze({
    CLUSTER: 'kakao',
    SSH_ALIAS: '',
    PARTITION: '',
    REPO_ROOT: '',
    GROOT_DIR: '',
    GROOT_N16_DIR: '',
    GROOT_N17_DIR: '',
    PHYSIXEL_DIR: '',
    GAM_DIR: '',
    ISAAC_DIR: '',
    DATA_DIR: '',
    LOG_DIR: '',
    SBATCH_EXCLUDE: '',
    SLURM_EXCLUDE_NODES: '',
    LD_LIBRARY_PATH: '',
    DEXJOCO_DIR: '',
    MICROMAMBA_BIN: '',
    MAMBA_ROOT_PREFIX: '',
    DEXJOCO_EVAL_ENV: '',
    DEXJOCO_OPENPI_ENV: '',
    UNIFIED_EXPERIMENTS_DIR: '',
  }),
  skt: Object.freeze({
    CLUSTER: 'skt',
    SSH_ALIAS: '',
    PARTITION: '',
    REPO_ROOT: '',
    GROOT_DIR: '',
    GROOT_N16_DIR: '',
    GROOT_N17_DIR: '',
    PHYSIXEL_DIR: '',
    GAM_DIR: '',
    ISAAC_DIR: '',
    DATA_DIR: '',
    LOG_DIR: '',
    SBATCH_EXCLUDE: '',
    SLURM_EXCLUDE_NODES: '',
    LD_LIBRARY_PATH: '',
    DEXJOCO_DIR: '',
    MICROMAMBA_BIN: '',
    MAMBA_ROOT_PREFIX: '',
    DEXJOCO_EVAL_ENV: '',
    DEXJOCO_OPENPI_ENV: '',
    UNIFIED_EXPERIMENTS_DIR: '',
  }),
  mlxp: Object.freeze({
    USER: '',
    MLXP_NAMESPACE: 'p-rlwrld',
    MLXP_GPUS_PER_NODE: '8',
    MLXP_DDN_MOUNT: '/data',
    MLXP_HOME: '',
    DATA_DIR: '',
    UNIFIED_EXPERIMENTS_DIR: '',
    HF_HOME: '',
    WORKSPACE_DIR: '',
    ISAAC_DIR: '',
    DEXJOCO_DIR: '',
    MICROMAMBA_BIN: '',
    MAMBA_ROOT_PREFIX: '',
    DEXJOCO_EVAL_ENV: '',
    DEXJOCO_OPENPI_ENV: '',
    MLXP_DATA_POD: '',
    MLXP_DDN_PVC: 'ddn-rlwrld-shared',
    MLXP_IMAGE: '',
    MLXP_IMAGE_PULL_SECRET: 'mlxp-registry',
    MLXP_ZONE: 'private-h200-rlwrld-0',
    MLXP_WANDB_SECRET: '',
  }),
});

function requireUser(req, res) {
  if (!req.ssotUser) {
    sendUnauthenticated(res);
    return null;
  }
  return req.ssotUser;
}

function envQuote(value) {
  const text = String(value ?? '');
  if (text === '' || BARE_ENV_VALUE.test(text)) return text;
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

function serializeEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return '';
  const lines = [];
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY.test(key)) throw new Error(`invalid environment key: ${key}`);
    lines.push(`${key}=${envQuote(value)}`);
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

function unquote(raw) {
  const text = raw.trim();
  if (
    text.length >= 2 &&
    text[0] === text[text.length - 1] &&
    (text[0] === "'" || text[0] === '"')
  ) {
    return text.slice(1, -1).replace(/'\\''/g, "'");
  }
  return text;
}

function parseEnvText(text) {
  const env = {};
  for (const rawLine of String(text || '').split('\n')) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    if (!ENV_KEY.test(key)) continue;
    env[key] = unquote(line.slice(index + 1));
  }
  return env;
}

function normalizeClusters(clusters) {
  if (!Array.isArray(clusters)) throw new Error('clusters must be an array');
  const seen = new Set();
  return clusters.map((cluster) => {
    if (!cluster || typeof cluster !== 'object' || Array.isArray(cluster)) {
      throw new Error('invalid cluster');
    }
    const name = String(cluster.name || '').trim();
    if (!CLUSTER_NAME.test(name)) throw new Error(`invalid cluster name: ${name || '(empty)'}`);
    if (seen.has(name)) throw new Error(`duplicate cluster name: ${name}`);
    seen.add(name);
    const suppliedEnv =
      typeof cluster.env_text === 'string'
        ? parseEnvText(cluster.env_text)
        : cluster.env || {};
    const env = DEFAULT_CLUSTER_ENVS[name]
      ? { ...DEFAULT_CLUSTER_ENVS[name], ...suppliedEnv }
      : suppliedEnv;
    return { name, env_text: serializeEnv(env) };
  });
}

function stringValue(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value.trim();
}

function booleanValue(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function normalizeTrainEval(body, current) {
  const out = {};

  if ('clusters' in body) out.clusters = normalizeClusters(body.clusters);

  if ('wandb' in body) {
    const input = body.wandb;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('wandb must be an object');
    }
    const previous = current.wandb && typeof current.wandb === 'object' ? current.wandb : {};
    const wandb = {};
    const project = stringValue(input.project, 'wandb.project');
    if (project !== undefined) wandb.project = project;
    const apiKey = stringValue(input.api_key, 'wandb.api_key');
    const clearApiKey = booleanValue(input.clear_api_key, 'wandb.clear_api_key');
    if (clearApiKey) {
      // Explicit revocation: omit the key from the replacement value.
    } else if (apiKey) wandb.api_key = apiKey;
    else if (previous.api_key) wandb.api_key = previous.api_key;
    out.wandb = wandb;
  }

  if ('notifications' in body) {
    const input = body.notifications;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('notifications must be an object');
    }
    const previous =
      current.notifications && typeof current.notifications === 'object'
        ? current.notifications
        : {};
    const notifications = {};
    for (const key of [
      'enabled',
      'notify_submitted',
      'notify_running',
      'notify_suspended',
      'notify_completed',
      'notify_failed',
      'notify_cancelled',
    ]) {
      const value = booleanValue(input[key], `notifications.${key}`);
      if (value !== undefined) notifications[key] = value;
    }
    const webhook = stringValue(input.slack_webhook_url, 'notifications.slack_webhook_url');
    const clearWebhook = booleanValue(
      input.clear_slack_webhook_url,
      'notifications.clear_slack_webhook_url',
    );
    if (clearWebhook) {
      // Explicit revocation: omit the URL from the replacement value.
    } else if (webhook) notifications.slack_webhook_url = webhook;
    else if (previous.slack_webhook_url) {
      notifications.slack_webhook_url = previous.slack_webhook_url;
    }
    out.notifications = notifications;
  }

  return out;
}

function normalizeProfile(body) {
  const username = stringValue(body.username, 'profile.username') ?? '';
  if (username && !USERNAME.test(username)) {
    throw new Error(
      'username may only contain letters, numbers, dot, underscore, or hyphen',
    );
  }
  if (username.split('_').some((token) => RESERVED_USERNAME_TOKENS.has(token))) {
    throw new Error("username must not contain 'train', 'eval', or 'resume'");
  }
  return { username };
}

function normalizePathNamespace(namespace, body) {
  if (namespace === 'results-sheet') {
    return { configs_root: stringValue(body.configs_root, 'configs_root') ?? '' };
  }
  return {
    claude_root: stringValue(body.claude_root, 'claude_root') ?? '',
    codex_root: stringValue(body.codex_root, 'codex_root') ?? '',
    openclaw_root: stringValue(body.openclaw_root, 'openclaw_root') ?? '',
  };
}

function normalizeNamespace(namespace, body, current) {
  if (namespace === 'train-eval') return normalizeTrainEval(body, current);
  if (namespace === 'profile') return normalizeProfile(body);
  return normalizePathNamespace(namespace, body);
}

function publicTrainEval(settings) {
  const out = {};
  const storedClusters = Array.isArray(settings.clusters) ? settings.clusters : [];
  const storedByName = new Map(
    storedClusters
      .filter((cluster) => cluster && typeof cluster === 'object')
      .map((cluster) => [cluster.name, cluster]),
  );
  out.clusters = Object.entries(DEFAULT_CLUSTER_ENVS).map(([name, defaults]) => {
    const stored = storedByName.get(name);
    const storedEnv = stored
      ? stored.env && typeof stored.env === 'object' && !Array.isArray(stored.env)
        ? stored.env
        : parseEnvText(stored.env_text)
      : {};
    storedByName.delete(name);
    return {
      name,
      env: { ...defaults, ...storedEnv },
      default_values: defaults,
      locked_keys: Object.keys(defaults),
      built_in: true,
      configured: !!stored,
    };
  });
  for (const cluster of storedByName.values()) {
    out.clusters.push({
      name: cluster.name,
      env:
        cluster.env && typeof cluster.env === 'object' && !Array.isArray(cluster.env)
          ? cluster.env
          : parseEnvText(cluster.env_text),
      default_values: {},
      locked_keys: [],
      built_in: false,
      configured: true,
    });
  }
  if (settings.wandb && typeof settings.wandb === 'object') {
    const { api_key: apiKey, ...wandb } = settings.wandb;
    out.wandb = { ...wandb, configured: !!apiKey };
  }
  if (settings.notifications && typeof settings.notifications === 'object') {
    const { slack_webhook_url: webhook, ...notifications } = settings.notifications;
    out.notifications = { ...notifications, configured: !!webhook };
  }
  return out;
}

function publicNamespace(namespace, settings) {
  return namespace === 'train-eval' ? publicTrainEval(settings) : settings;
}

export function registerSettingsRoutes(app, { getWandbStatus, validateWandbKey } = {}) {
  const jsonBody = express.json({ limit: '256kb' });

  app.get('/api/settings', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const out = {};
    for (const namespace of NAMESPACES) {
      out[namespace] = publicNamespace(namespace, getSettings(user.id, namespace));
    }
    res.json(out);
  });

  app.get('/api/settings/wandb-status', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!getWandbStatus) {
      return res.status(503).json({ error: 'wandb_status_unavailable' });
    }
    try {
      res.json(await getWandbStatus(user.email));
    } catch (error) {
      console.error('[ssot-gateway] W&B status failed', error);
      res.status(503).json({ error: 'wandb_status_unavailable' });
    }
  });

  app.put('/api/settings', jsonBody, async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'invalid_body' });
    }
    try {
      for (const namespace of NAMESPACES) {
        const value = body[namespace];
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error(`${namespace} settings are required`);
        }
        normalizeNamespace(namespace, value, {});
      }
    } catch (error) {
      return res.status(400).json({
        error: 'invalid_settings',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    const wandbKey =
      typeof body['train-eval'].wandb?.api_key === 'string'
        ? body['train-eval'].wandb.api_key.trim()
        : '';
    if (wandbKey && validateWandbKey) {
      try {
        const status = await validateWandbKey(wandbKey, user.email);
        if (!status?.logged_in) {
          return res.status(400).json({
            error: 'invalid_wandb_key',
            detail: status?.error || 'Weights & Biases rejected the API key',
          });
        }
      } catch (error) {
        console.error('[ssot-gateway] W&B validation failed', error);
        return res.status(503).json({ error: 'wandb_validation_unavailable' });
      }
    }

    try {
      const transforms = Object.fromEntries(
        NAMESPACES.map((namespace) => [
          namespace,
          (current) => normalizeNamespace(namespace, body[namespace], current),
        ]),
      );
      const updated = transformSettingsBatch(user.id, transforms);
      res.json(
        Object.fromEntries(
          NAMESPACES.map((namespace) => [
            namespace,
            publicNamespace(namespace, updated[namespace]),
          ]),
        ),
      );
    } catch (error) {
      console.error('[ssot-gateway] settings persistence failed', error);
      res.status(503).json({ error: 'settings_unavailable' });
    }
  });
}
