import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const dataDir = mkdtempSync(path.join(tmpdir(), 'ssot-auth-'));
process.env.SSOT_DATA_DIR = dataDir;
process.env.SSOT_ALLOWED_EMAIL_DOMAINS = 'rlwrld.ai';
process.env.SSOT_ALLOWED_USER_IDS = 'admin';

const { db } = await import('./db.mjs');
const { default: express } = await import('express');
const { registerAuthRoutes } = await import('./auth.mjs');

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function withServer(callback) {
  const app = express();
  registerAuthRoutes(app);
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

test('the login page accepts a configured local account ID', async () => {
  await withServer(async (origin) => {
    const page = await fetch(`${origin}/auth/login`);
    const html = await page.text();
    assert.match(html, /Email or account ID/);
    assert.match(html, /name="identifier"/);

    const response = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ identifier: 'admin', next: '/settings' }),
      redirect: 'manual',
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/settings');
    assert.match(response.headers.get('set-cookie') || '', /ssot_session=/);

    const user = db.prepare('SELECT email, name FROM users WHERE email = ?').get('admin');
    assert.equal(user.email, 'admin');
    assert.equal(user.name, 'admin');
  });
});

test('an unconfigured local account ID is rejected', async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ identifier: 'someone-else' }),
      redirect: 'manual',
    });
    assert.equal(response.status, 400);
  });
});

test('the former email form field remains compatible', async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'person@rlwrld.ai' }),
      redirect: 'manual',
    });
    assert.equal(response.status, 302);
  });
});
