import express from 'express';
import { getSettings, setSettings } from './db.mjs';
import { pushTrainEval, bootstrapTrainEval } from './train-eval-sync.mjs';

// The four settings namespaces the account page can read and write.
const NAMESPACES = ['profile', 'train-eval', 'results-sheet', 'session-viewer'];

// Drops secret fields so they never land in the gateway DB (and thus never
// get returned by GET /api/settings). The train-eval API is the system of
// record for these secrets.
function sanitizeTrainEval(body) {
  const out = { ...body };
  if (out.wandb && typeof out.wandb === 'object') {
    const { api_key, ...rest } = out.wandb;
    out.wandb = rest;
  }
  if (out.notifications && typeof out.notifications === 'object') {
    const { slack_webhook_url, ...rest } = out.notifications;
    out.notifications = rest;
  }
  return out;
}

function requireUser(req, res) {
  if (!req.ssotUser) {
    res.status(401).json({ error: 'unauthenticated' });
    return null;
  }
  return req.ssotUser;
}

export function registerSettingsRoutes(app) {
  const jsonBody = express.json({ limit: '256kb' });

  // Full settings snapshot across every namespace.
  app.get('/api/settings', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const out = {};
    for (const ns of NAMESPACES) out[ns] = getSettings(user.id, ns);
    // Default username to the email local part when unset.
    if (!out.profile.username && user.email) {
      out.profile.username = user.email.split('@')[0];
    }
    res.json(out);
  });

  // Proxy of the train-eval API's current effective values so the settings
  // page can prefill when the user has nothing stored yet.
  app.get('/api/settings/train-eval/bootstrap', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const data = await bootstrapTrainEval();
      res.json(data);
    } catch (err) {
      console.error('[ssot-gateway] train-eval bootstrap failed', err);
      res.status(502).json({ error: 'bootstrap_failed' });
    }
  });

  // Upsert the keys in the body into one namespace; returns the merged
  // namespace object.
  app.put('/api/settings/:namespace', jsonBody, async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const ns = req.params.namespace;
    if (!NAMESPACES.includes(ns)) {
      return res.status(400).json({ error: 'unknown_namespace' });
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'invalid_body' });
    }

    // Secrets (wandb API key, Slack webhook URL) are pushed to the train-eval
    // API but never persisted in the gateway DB, since GET /api/settings
    // returns stored values to the browser.
    const toStore = ns === 'train-eval' ? sanitizeTrainEval(body) : body;
    const updated = setSettings(user.id, ns, toStore);

    // Best-effort push to the train-eval API for train-eval settings and for
    // profile.username changes. Never blocks or fails the save. The push uses
    // the raw body so it still carries any freshly-entered secrets.
    let synced;
    if (ns === 'train-eval' || (ns === 'profile' && 'username' in body)) {
      const profile = ns === 'profile' ? body : getSettings(user.id, 'profile');
      const trainEval = ns === 'train-eval' ? body : getSettings(user.id, 'train-eval');
      synced = await pushTrainEval({ user, profile, trainEval, changed: ns }).catch(
        (err) => {
          console.error('[ssot-gateway] train-eval push failed', err);
          return false;
        }
      );
    }

    const payload = { ...updated };
    if (synced !== undefined) payload.synced = synced;
    res.json(payload);
  });
}
