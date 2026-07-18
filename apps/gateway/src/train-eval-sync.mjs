// Bridges the gateway's stored train-eval settings to the train-eval FastAPI,
// which remains the runtime consumer of its own config files.
//
// Shape mapping (gateway JSON  <->  train-eval API):
//   clusters:      [{name, env:{K:V}}]  <->  GET/PUT /api/cluster-settings[/{name}] {env_text}
//   wandb:         {project, api_key?}  <->  POST /api/wandb/project {project}, /api/wandb/login {key}
//                  (entity is read-only on the API; surfaced via bootstrap only)
//   notifications: {enabled, slack_webhook_url?, notify_*}  <->  GET/POST /api/notifications
//   profile.username                    <->  GET/POST /api/user-settings {username}
import { config } from './config.mjs';

function apiOrigin() {
  const te = config.apps.find((a) => a.id === 'train-eval');
  return (
    te?.api?.origin ||
    process.env.SSOT_TRAIN_EVAL_API_ORIGIN ||
    'http://127.0.0.1:8000'
  ).replace(/\/+$/, '');
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(apiOrigin() + path, {
    ...opts,
    signal: AbortSignal.timeout(8000),
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} -> ${res.status}`);
  return res.status === 204 ? null : res.json();
}

// --- env_text <-> {K:V} --------------------------------------------------
const BARE = /^[A-Za-z0-9._/:@=+,-]+$/;

function quote(value) {
  const v = String(value ?? '');
  if (v === '' || BARE.test(v)) return v;
  // POSIX single-quote escaping: close, escaped quote, reopen.
  return "'" + v.replace(/'/g, "'\\''") + "'";
}

function serializeEnv(env) {
  const lines = Object.entries(env || {})
    .filter(([k]) => k)
    .map(([k, v]) => `${k}=${quote(v)}`);
  return lines.length ? lines.join('\n') + '\n' : '';
}

function unquote(raw) {
  const s = raw.trim();
  if (s.length >= 2 && s[0] === s[s.length - 1] && (s[0] === "'" || s[0] === '"')) {
    return s.slice(1, -1);
  }
  return s;
}

// Mirrors the backend's best-effort env parser (export/KEY=value, comments).
function parseEnvText(text) {
  const out = {};
  for (const rawLine of String(text || '').split('\n')) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const i = line.indexOf('=');
    const key = line.slice(0, i).trim();
    if (!key) continue;
    out[key] = unquote(line.slice(i + 1).trim());
  }
  return out;
}

// --- push on save --------------------------------------------------------
// Returns true when every attempted push succeeded, false if any failed.
export async function pushTrainEval({ profile, trainEval, changed }) {
  const tasks = [];

  if (changed === 'profile') {
    tasks.push(
      apiFetch('/api/user-settings', {
        method: 'POST',
        body: JSON.stringify({ username: profile.username || '' }),
      })
    );
  }

  if (changed === 'train-eval') {
    for (const cluster of trainEval.clusters || []) {
      if (!cluster || !cluster.name) continue;
      tasks.push(
        apiFetch('/api/cluster-settings/' + encodeURIComponent(cluster.name), {
          method: 'PUT',
          body: JSON.stringify({ env_text: serializeEnv(cluster.env) }),
        })
      );
    }

    const w = trainEval.wandb || {};
    if (w.project && w.project.trim()) {
      tasks.push(
        apiFetch('/api/wandb/project', {
          method: 'POST',
          body: JSON.stringify({ project: w.project.trim() }),
        })
      );
    }
    if (w.api_key && w.api_key.trim()) {
      tasks.push(
        apiFetch('/api/wandb/login', {
          method: 'POST',
          body: JSON.stringify({ key: w.api_key.trim() }),
        })
      );
    }

    const n = trainEval.notifications;
    if (n && typeof n === 'object') {
      const body = {
        enabled: !!n.enabled,
        notify_submitted: n.notify_submitted !== false,
        notify_running: !!n.notify_running,
        notify_completed: n.notify_completed !== false,
        notify_failed: n.notify_failed !== false,
        notify_cancelled: n.notify_cancelled !== false,
      };
      // Omit the webhook URL when blank so the API keeps the saved secret.
      if (n.slack_webhook_url && n.slack_webhook_url.trim()) {
        body.slack_webhook_url = n.slack_webhook_url.trim();
      }
      tasks.push(
        apiFetch('/api/notifications', { method: 'POST', body: JSON.stringify(body) })
      );
    }
  }

  if (tasks.length === 0) return true;
  const results = await Promise.allSettled(tasks);
  const failed = results.filter((r) => r.status === 'rejected');
  for (const f of failed) console.error('[ssot-gateway] train-eval push task failed', f.reason);
  return failed.length === 0;
}

// --- bootstrap (prefill) -------------------------------------------------
// Proxies the train-eval API's current effective values in the gateway's
// stored shape so the settings page can prefill when nothing is saved yet.
export async function bootstrapTrainEval() {
  const [clustersR, wandbR, notifR] = await Promise.allSettled([
    apiFetch('/api/cluster-settings'),
    apiFetch('/api/wandb/status'),
    apiFetch('/api/notifications'),
  ]);

  const out = {};

  if (clustersR.status === 'fulfilled' && Array.isArray(clustersR.value)) {
    out.clusters = clustersR.value.map((c) => ({
      name: c.name,
      env: parseEnvText(c.env_text),
    }));
  }

  if (wandbR.status === 'fulfilled' && wandbR.value) {
    out.wandb = {
      entity: wandbR.value.entity || '',
      project: wandbR.value.project || '',
      logged_in: !!wandbR.value.logged_in,
    };
  }

  if (notifR.status === 'fulfilled' && notifR.value) {
    const n = notifR.value;
    out.notifications = {
      enabled: !!n.enabled,
      configured: !!n.configured,
      notify_submitted: n.notify_submitted !== false,
      notify_running: !!n.notify_running,
      notify_completed: n.notify_completed !== false,
      notify_failed: n.notify_failed !== false,
      notify_cancelled: n.notify_cancelled !== false,
    };
  }

  return out;
}
