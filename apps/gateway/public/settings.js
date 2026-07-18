/* SSOT settings page client. Plain fetch-based, no framework. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const api = (path, opts) =>
    fetch(path, Object.assign({ credentials: 'same-origin' }, opts));

  function setStatus(ns, text, kind) {
    const el = document.querySelector(`[data-status="${ns}"]`);
    if (!el) return;
    el.textContent = text || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
    if (text && kind === 'ok') {
      setTimeout(() => {
        if (el.textContent === text) el.textContent = '';
      }, 3000);
    }
  }

  async function putNamespace(ns, body) {
    const res = await api('/api/settings/' + ns, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      window.location.href = '/auth/login?next=/settings';
      throw new Error('unauthenticated');
    }
    if (!res.ok) throw new Error('save failed (' + res.status + ')');
    return res.json();
  }

  // --- train-eval cluster rows -------------------------------------------
  function clusterBlock(cluster) {
    const wrap = document.createElement('div');
    wrap.className = 'cluster';

    const head = document.createElement('div');
    head.className = 'cluster-head';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'ssot-input';
    nameInput.placeholder = 'cluster name';
    nameInput.value = cluster.name || '';
    nameInput.dataset.role = 'cluster-name';
    const delBtn = document.createElement('button');
    delBtn.className = 'ssot-btn del';
    delBtn.textContent = '×';
    delBtn.title = 'Remove cluster';
    delBtn.onclick = () => wrap.remove();
    head.append(nameInput, delBtn);
    wrap.appendChild(head);

    const kvHead = document.createElement('div');
    kvHead.className = 'kv-head';
    kvHead.textContent = 'Environment variables';
    wrap.appendChild(kvHead);

    const rows = document.createElement('div');
    rows.dataset.role = 'kv-rows';
    wrap.appendChild(rows);

    const env = cluster.env || {};
    const keys = Object.keys(env);
    if (keys.length === 0) keys.push('');
    for (const k of keys) rows.appendChild(kvRow(k, k ? env[k] : ''));

    const add = document.createElement('button');
    add.className = 'ssot-btn add-btn';
    add.textContent = '+ Add variable';
    add.onclick = () => rows.appendChild(kvRow('', ''));
    wrap.appendChild(add);

    return wrap;
  }

  function kvRow(key, value) {
    const row = document.createElement('div');
    row.className = 'row';
    const k = document.createElement('input');
    k.type = 'text';
    k.placeholder = 'KEY';
    k.className = 'ssot-input';
    k.value = key || '';
    k.dataset.role = 'kv-key';
    const v = document.createElement('input');
    v.type = 'text';
    v.placeholder = 'value';
    v.className = 'ssot-input';
    v.value = value != null ? value : '';
    v.dataset.role = 'kv-value';
    const del = document.createElement('button');
    del.className = 'ssot-btn del';
    del.textContent = '×';
    del.onclick = () => row.remove();
    row.append(k, v, del);
    return row;
  }

  function renderClusters(clusters) {
    const container = $('te-clusters');
    container.replaceChildren();
    const list = Array.isArray(clusters) && clusters.length ? clusters : [{ name: '', env: {} }];
    for (const c of list) container.appendChild(clusterBlock(c));
  }

  function collectClusters() {
    const out = [];
    for (const block of $('te-clusters').querySelectorAll('.cluster')) {
      const name = block.querySelector('[data-role="cluster-name"]').value.trim();
      const env = {};
      for (const row of block.querySelectorAll('[data-role="kv-rows"] .row')) {
        const k = row.querySelector('[data-role="kv-key"]').value.trim();
        const v = row.querySelector('[data-role="kv-value"]').value;
        if (k) env[k] = v;
      }
      if (name || Object.keys(env).length) out.push({ name, env });
    }
    return out;
  }

  // --- load --------------------------------------------------------------
  function fillTrainEval(te) {
    te = te || {};
    renderClusters(te.clusters);
    const w = te.wandb || {};
    $('te-wandb-entity').value = w.entity || '';
    $('te-wandb-project').value = w.project || '';
    const ws = $('te-wandb-status');
    if (ws) ws.textContent = w.logged_in ? 'signed in' : (w.entity || w.project ? '' : 'not signed in');
    // API key intentionally never echoed back; left blank.
    const n = te.notifications || {};
    $('te-notify-enabled').checked = !!n.enabled;
    // The webhook secret is never returned; leave blank (placeholder explains).
    $('te-slack-webhook').value = '';
    $('te-notify-submitted').checked = n.notify_submitted !== false;
    $('te-notify-running').checked = !!n.notify_running;
    $('te-notify-completed').checked = n.notify_completed !== false;
    $('te-notify-failed').checked = n.notify_failed !== false;
    $('te-notify-cancelled').checked = n.notify_cancelled !== false;
  }

  async function load() {
    const res = await api('/api/settings');
    if (res.status === 401) {
      window.location.href = '/auth/login?next=/settings';
      return;
    }
    const s = await res.json();

    $('acct-email').value = (s.profile && s.profile.email) || '';
    $('acct-username').value = (s.profile && s.profile.username) || '';

    const rs = s['results-sheet'] || {};
    $('rs-configs-root').value = rs.configs_root || '';

    const sv = s['session-viewer'] || {};
    $('sv-claude-root').value = sv.claude_root || '';
    $('sv-codex-root').value = sv.codex_root || '';

    let te = s['train-eval'] || {};
    const hasStored = te && (te.clusters || te.wandb || te.notifications);
    if (!hasStored) {
      // Prefill from the train-eval API's current effective values.
      try {
        const b = await api('/api/settings/train-eval/bootstrap');
        if (b.ok) te = await b.json();
      } catch { /* leave empty */ }
    }
    fillTrainEval(te);

    // Account email comes from /api/auth/me since it is not in profile settings.
    try {
      const me = await api('/api/auth/me');
      if (me.ok) {
        const { user } = await me.json();
        $('acct-email').value = user.email || '';
        if (!$('acct-username').value) $('acct-username').value = user.username || '';
      }
    } catch { /* ignore */ }
  }

  // --- save handlers -----------------------------------------------------
  const savers = {
    profile: () => ({ username: $('acct-username').value.trim() }),
    'results-sheet': () => ({ configs_root: $('rs-configs-root').value.trim() }),
    'session-viewer': () => ({
      claude_root: $('sv-claude-root').value.trim(),
      codex_root: $('sv-codex-root').value.trim(),
    }),
    'train-eval': () => {
      const body = {
        clusters: collectClusters(),
        wandb: {
          project: $('te-wandb-project').value.trim(),
        },
        notifications: {
          enabled: $('te-notify-enabled').checked,
          notify_submitted: $('te-notify-submitted').checked,
          notify_running: $('te-notify-running').checked,
          notify_completed: $('te-notify-completed').checked,
          notify_failed: $('te-notify-failed').checked,
          notify_cancelled: $('te-notify-cancelled').checked,
        },
      };
      const key = $('te-wandb-key').value;
      if (key) body.wandb.api_key = key;
      const hook = $('te-slack-webhook').value.trim();
      if (hook) body.notifications.slack_webhook_url = hook;
      return body;
    },
  };

  document.querySelectorAll('[data-save]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ns = btn.dataset.save;
      setStatus(ns, 'Saving...', '');
      try {
        const result = await putNamespace(ns, savers[ns]());
        let msg = 'Saved';
        if (result && result.synced === false) msg = 'Saved (train-eval sync failed)';
        else if (result && result.synced === true) msg = 'Saved and synced';
        setStatus(ns, msg, 'ok');
        if (ns === 'train-eval') $('te-wandb-key').value = '';
      } catch (err) {
        setStatus(ns, err.message || 'Save failed', 'err');
      }
    });
  });

  $('te-add-cluster').addEventListener('click', () => {
    $('te-clusters').appendChild(clusterBlock({ name: '', env: {} }));
  });

  $('sign-out').addEventListener('click', async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch { /* ignore */ }
    window.location.href = '/';
  });

  load();
})();
