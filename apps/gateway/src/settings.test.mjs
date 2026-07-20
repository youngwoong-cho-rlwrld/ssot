import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const dataDir = mkdtempSync(path.join(tmpdir(), 'ssot-settings-'));
process.env.SSOT_DATA_DIR = dataDir;

const { db, dbPath, getSettings, upsertUser } = await import('./db.mjs');
const { default: express } = await import('express');
const { DEFAULT_CLUSTER_ENVS, registerSettingsRoutes } = await import('./settings.mjs');

const owner = upsertUser({ email: 'youngwoong.cho@rlwrld.ai' });
const other = upsertUser({ email: 'other@example.com' });

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function withServer(user, callback, options) {
  const app = express();
  app.use((req, _res, next) => {
    req.ssotUser = user;
    next();
  });
  registerSettingsRoutes(app, options);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test('SQLite values start empty while built-in cluster keys are available', async () => {
  assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  assert.equal(statSync(dbPath).mode & 0o777, 0o600);

  for (const user of [owner, other]) {
    await withServer(user, async (origin) => {
      const response = await fetch(`${origin}/api/settings`);
      assert.equal(response.status, 200);
      const settings = await response.json();
      assert.deepEqual(settings.profile, {});
      assert.deepEqual(settings['results-sheet'], {});
      assert.deepEqual(settings['session-viewer'], {});
      assert.deepEqual(
        settings['train-eval'].clusters.map((cluster) => cluster.name),
        Object.keys(DEFAULT_CLUSTER_ENVS),
      );
      for (const cluster of settings['train-eval'].clusters) {
        assert.equal(cluster.built_in, true);
        assert.equal(cluster.configured, false);
        assert.deepEqual(cluster.locked_keys, Object.keys(DEFAULT_CLUSTER_ENVS[cluster.name]));
        assert.deepEqual(cluster.env, DEFAULT_CLUSTER_ENVS[cluster.name]);
      }
      assert.deepEqual(getSettings(user.id, 'train-eval'), {});
    });
  }
});

test('a rejected W&B key is not persisted', async () => {
  await withServer(
    other,
    async (origin) => {
      const response = await fetch(`${origin}/api/settings/train-eval`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wandb: { project: 'project', api_key: 'bad-key' } }),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(getSettings(other.id, 'train-eval'), {});
    },
    {
      validateWandbKey: async () => ({
        logged_in: false,
        error: 'invalid API key',
      }),
    },
  );
});

test('train-eval settings are stored once in SQLite and secrets are redacted', async () => {
  await withServer(owner, async (origin) => {
    const saved = await fetch(`${origin}/api/settings/train-eval`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clusters: [
          {
            name: 'kakao',
            env: {
              SSH_ALIAS: 'kakao-login-1',
              DATA_DIR: '/data/person',
              SPECIAL: "person's path $HOME",
            },
          },
        ],
        wandb: { project: 'project', api_key: 'wandb-secret' },
        notifications: {
          enabled: true,
          notify_failed: true,
          slack_webhook_url: 'https://hooks.example/secret',
        },
      }),
    });
    assert.equal(saved.status, 200);
    const publicValue = await saved.json();
    assert.equal(publicValue.wandb.api_key, undefined);
    assert.equal(publicValue.wandb.configured, true);
    assert.equal(publicValue.notifications.slack_webhook_url, undefined);
    assert.equal(publicValue.notifications.configured, true);
    assert.equal(
      publicValue.clusters[0].env.SPECIAL,
      "person's path $HOME",
    );

    const stored = getSettings(owner.id, 'train-eval');
    assert.equal(stored.wandb.api_key, 'wandb-secret');
    assert.equal(
      stored.notifications.slack_webhook_url,
      'https://hooks.example/secret',
    );
    assert.match(stored.clusters[0].env_text, /SSH_ALIAS=kakao-login-1/);
  });

  await withServer(other, async (origin) => {
    const response = await fetch(`${origin}/api/settings`);
    const trainEval = (await response.json())['train-eval'];
    assert.equal(trainEval.clusters.length, 3);
    assert.ok(trainEval.clusters.every((cluster) => !cluster.configured));
    assert.deepEqual(getSettings(other.id, 'train-eval'), {});
  });
});

test('built-in cluster keys are restored server-side and custom keys remain supported', async () => {
  await withServer(other, async (origin) => {
    const response = await fetch(`${origin}/api/settings/train-eval`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clusters: [{ name: 'kakao', env: { SSH_ALIAS: 'host', CUSTOM_VALUE: 'yes' } }],
      }),
    });
    assert.equal(response.status, 200);
    const trainEval = await response.json();
    const kakao = trainEval.clusters.find((cluster) => cluster.name === 'kakao');
    assert.equal(kakao.env.CLUSTER, 'kakao');
    assert.equal(kakao.env.PARTITION, '');
    assert.equal(kakao.env.SSH_ALIAS, 'host');
    assert.equal(kakao.env.CUSTOM_VALUE, 'yes');
    assert.ok(kakao.locked_keys.includes('PARTITION'));
    assert.ok(!kakao.locked_keys.includes('CUSTOM_VALUE'));

    const stored = getSettings(other.id, 'train-eval').clusters[0].env_text;
    assert.match(stored, /^CLUSTER=kakao$/m);
    assert.match(stored, /^PARTITION=$/m);
    assert.match(stored, /^CUSTOM_VALUE=yes$/m);
  });
});

test('blank secret inputs preserve the existing SQLite secret', async () => {
  await withServer(owner, async (origin) => {
    const response = await fetch(`${origin}/api/settings/train-eval`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clusters: [],
        wandb: { project: 'next', api_key: '' },
        notifications: { enabled: false, slack_webhook_url: '' },
      }),
    });
    assert.equal(response.status, 200);
  });
  const stored = getSettings(owner.id, 'train-eval');
  assert.equal(stored.wandb.api_key, 'wandb-secret');
  assert.equal(
    stored.notifications.slack_webhook_url,
    'https://hooks.example/secret',
  );
  assert.deepEqual(stored.clusters, []);
});

test('explicit secret revocation removes both credentials', async () => {
  await withServer(owner, async (origin) => {
    const response = await fetch(`${origin}/api/settings/train-eval`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clusters: [],
        wandb: { project: '', clear_api_key: true },
        notifications: { enabled: false, clear_slack_webhook_url: true },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.wandb.configured, false);
    assert.equal(body.notifications.configured, false);
  });
  const stored = getSettings(owner.id, 'train-eval');
  assert.equal(stored.wandb.api_key, undefined);
  assert.equal(stored.notifications.slack_webhook_url, undefined);
});

test('profile and path settings reject invalid types and usernames', async () => {
  await withServer(owner, async (origin) => {
    for (const [namespace, body] of [
      ['profile', { username: 'bad train name' }],
      ['profile', { username: 'prefix_train_user' }],
      ['results-sheet', { configs_root: 42 }],
      ['session-viewer', { claude_root: [], codex_root: '' }],
    ]) {
      const response = await fetch(`${origin}/api/settings/${namespace}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    }
  });
});

test('the removed bootstrap endpoint does not exist', async () => {
  await withServer(owner, async (origin) => {
    const response = await fetch(`${origin}/api/settings/train-eval/bootstrap`);
    assert.equal(response.status, 404);
  });
});
