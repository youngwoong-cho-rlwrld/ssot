/* SSOT settings page client. Plain fetch-based, no framework. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const api = (path, opts) =>
    fetch(path, Object.assign({ credentials: 'same-origin' }, opts));
  const settingsState = { dirty: false, revision: 0, saveInFlight: false };

  function setSaveStatus(text, kind) {
    const el = $('settings-save-status');
    el.textContent = text || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
    if (text && kind === 'ok') {
      setTimeout(() => {
        if (el.textContent === text) el.textContent = '';
      }, 3000);
    }
  }

  async function putSettings(body) {
    const res = await api('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      settingsState.dirty = false;
      window.location.href = '/auth/login?next=/settings';
      throw new Error('unauthenticated');
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload.detail || payload.error || 'save failed (' + res.status + ')');
    }
    return payload;
  }

  // --- train-eval cluster rows -------------------------------------------
  function clusterBlock(cluster) {
    const wrap = document.createElement('div');
    wrap.className = 'cluster';
    wrap.dataset.builtIn = cluster.built_in ? 'true' : 'false';

    const head = document.createElement('div');
    head.className = 'cluster-head';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'ssot-input';
    nameInput.placeholder = 'cluster name';
    nameInput.value = cluster.name || '';
    nameInput.dataset.role = 'cluster-name';
    nameInput.readOnly = !!cluster.built_in;
    const delBtn = document.createElement('button');
    delBtn.className = 'ssot-btn del';
    delBtn.type = 'button';
    delBtn.textContent = '×';
    delBtn.title = 'Remove cluster';
    delBtn.onclick = () => {
      wrap.remove();
      markSettingsDirty();
    };
    delBtn.style.visibility = cluster.built_in ? 'hidden' : '';
    delBtn.tabIndex = cluster.built_in ? -1 : 0;
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
    const lockedKeys = new Set(cluster.locked_keys || []);
    const defaultValues = cluster.default_values || {};
    const keys = Object.keys(env);
    if (keys.length === 0) keys.push('');
    for (const k of keys) {
      rows.appendChild(
        kvRow(k, k ? env[k] : '', {
          locked: lockedKeys.has(k),
          defaultValue: defaultValues[k],
        }),
      );
    }

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'ssot-btn add-btn';
    add.textContent = '+ Add variable';
    add.onclick = () => {
      rows.appendChild(kvRow('', ''));
      markSettingsDirty();
    };
    wrap.appendChild(add);

    return wrap;
  }

  function kvRow(key, value, { locked = false, defaultValue = '' } = {}) {
    const row = document.createElement('div');
    row.className = 'row';
    const k = document.createElement('input');
    k.type = 'text';
    k.placeholder = 'KEY';
    k.className = 'ssot-input';
    k.value = key || '';
    k.dataset.role = 'kv-key';
    k.dataset.locked = locked ? 'true' : 'false';
    k.readOnly = locked;
    const v = document.createElement('input');
    v.type = 'text';
    v.placeholder = 'value';
    v.className = 'ssot-input';
    v.value = value != null ? value : '';
    v.dataset.role = 'kv-value';
    v.dataset.defaultValue = defaultValue != null ? String(defaultValue) : '';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ssot-btn del';
    del.textContent = '×';
    del.onclick = () => {
      row.remove();
      markSettingsDirty();
    };
    del.style.visibility = locked ? 'hidden' : '';
    del.tabIndex = locked ? -1 : 0;
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
      let hasConfiguredValue = block.dataset.builtIn !== 'true';
      for (const row of block.querySelectorAll('[data-role="kv-rows"] .row')) {
        const keyInput = row.querySelector('[data-role="kv-key"]');
        const valueInput = row.querySelector('[data-role="kv-value"]');
        const k = keyInput.value.trim();
        const v = valueInput.value;
        if (k) env[k] = v;
        if (keyInput.dataset.locked === 'true') {
          if (v !== valueInput.dataset.defaultValue) hasConfiguredValue = true;
        } else if (k) {
          hasConfiguredValue = true;
        }
      }
      if (hasConfiguredValue && (name || Object.keys(env).length)) {
        out.push({ name, env });
      }
    }
    return out;
  }

  // --- load --------------------------------------------------------------
  function fillTrainEval(te) {
    te = te || {};
    renderClusters(te.clusters);
    const w = te.wandb || {};
    // The W&B entity is not part of stored settings; refreshWandbStatus fills it
    // from the live status endpoint.
    $('te-wandb-project').value = w.project || '';
    const ws = $('te-wandb-status');
    if (ws) ws.textContent = w.configured ? 'configured' : 'not configured';
    // API key intentionally never echoed back; left blank.
    const n = te.notifications || {};
    $('te-notify-enabled').checked = !!n.enabled;
    // The webhook secret is never returned; leave blank (placeholder explains).
    $('te-slack-webhook').value = '';
    $('te-notify-submitted').checked = !!n.notify_submitted;
    $('te-notify-running').checked = !!n.notify_running;
    $('te-notify-suspended').checked = !!n.notify_suspended;
    $('te-notify-completed').checked = !!n.notify_completed;
    $('te-notify-failed').checked = !!n.notify_failed;
    $('te-notify-cancelled').checked = !!n.notify_cancelled;
  }

  async function refreshWandbStatus() {
    const ws = $('te-wandb-status');
    try {
      const response = await api('/api/settings/wandb-status');
      if (!response.ok) throw new Error('status unavailable');
      const status = await response.json();
      $('te-wandb-entity').value = status.entity || '';
      if (ws) {
        ws.textContent = status.logged_in
          ? 'connected'
          : status.error
            ? 'connection failed'
            : 'not configured';
      }
    } catch {
      $('te-wandb-entity').value = '';
      if (ws) ws.textContent = 'status unavailable';
    }
  }

  // --- general: host model subscriptions (read-only) ---------------------
  function setSubStatus(id, status) {
    const el = $(id);
    if (!el) return;
    if (status === 'logged_in') {
      el.textContent = 'signed in';
      el.className = 'status ok';
    } else if (status === 'logged_out') {
      el.textContent = 'not signed in';
      el.className = 'status warn';
    } else {
      el.textContent = 'status unavailable';
      el.className = 'status';
    }
  }

  let genHostname = 'the backend host';
  const RELOGIN = {
    claude: { label: 'Claude', cmd: 'claude' },
    openai: { label: 'OpenAI / Codex', cmd: 'codex login' },
  };

  async function loadGeneral() {
    try {
      const res = await api('/api/portal/subscriptions');
      if (!res.ok) throw new Error('unavailable');
      const s = await res.json();
      if (s.hostname) genHostname = s.hostname;
      const c = s.claude || {};
      $('gen-claude').value = c.email || (c.status === 'logged_in' ? 'signed in' : '');
      setSubStatus('gen-claude-status', c.status);
      const o = s.openai || {};
      const openai = [o.email, o.plan].filter(Boolean).join(' · ');
      $('gen-openai').value = openai || (o.status === 'logged_in' ? 'signed in' : '');
      setSubStatus('gen-openai-status', o.status);
    } catch {
      setSubStatus('gen-claude-status', 'unknown');
      setSubStatus('gen-openai-status', 'unknown');
    }
  }

  // Host re-login instructions in a modal (no browser OAuth for these CLIs). Uses
  // the shared @ssot/theme/modal.css grammar (.modal-overlay/.modal), built by hand
  // since this page is vanilla JS.
  function openReloginModal(family) {
    const info = RELOGIN[family] || RELOGIN.claude;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML =
      '<div class="modal modal--confirm">' +
      '<div class="modal__head"><h2 class="modal__title"></h2></div>' +
      '<div class="modal__body"><p>Sign-in for these CLIs happens on the host, not in ' +
      'this browser. Run this on <span class="mono" data-host></span>, then reload this page.</p>' +
      '<div class="cmd"><code data-cmd></code>' +
      '<button type="button" class="ssot-btn" data-copy>Copy</button></div></div>' +
      '<div class="modal__foot"><button type="button" class="ssot-btn" data-close>Close</button></div>' +
      '</div>';
    overlay.querySelector('.modal__title').textContent = 'Update ' + info.label + ' sign-in';
    overlay.querySelector('[data-host]').textContent = genHostname;
    overlay.querySelector('[data-cmd]').textContent = info.cmd;

    const onKey = (event) => {
      if (event.key === 'Escape') close();
    };
    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) close();
    });
    overlay.querySelector('[data-close]').addEventListener('click', close);
    const copyBtn = overlay.querySelector('[data-copy]');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(info.cmd);
        copyBtn.textContent = 'Copied';
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
        }, 1200);
      } catch {
        /* clipboard blocked; ignore */
      }
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
  }

  for (const btn of document.querySelectorAll('.gen-update')) {
    btn.addEventListener('click', () => openReloginModal(btn.dataset.family));
  }

  function fillSettings(s) {
    s = s || {};
    $('acct-username').value = (s.profile && s.profile.username) || '';

    const rs = s['results-sheet'] || {};
    $('rs-configs-root').value = rs.configs_root || '';

    const sv = s['session-viewer'] || {};
    $('sv-claude-root').value = sv.claude_root || '';
    $('sv-codex-root').value = sv.codex_root || '';
    $('sv-openclaw-root').value = sv.openclaw_root || '';

    fillTrainEval(s['train-eval'] || {});
    $('te-wandb-key').value = '';
    $('te-wandb-clear').checked = false;
    $('te-slack-clear').checked = false;
  }

  async function load() {
    const main = $('settings-main');
    const loadState = $('settings-load-state');
    try {
      const res = await api('/api/settings');
      if (res.status === 401) {
        window.location.href = '/auth/login?next=/settings';
        return;
      }
      if (!res.ok) throw new Error('request failed (' + res.status + ')');
      const s = await res.json();

      fillSettings(s);
      void refreshWandbStatus();
      void loadGeneral();

      // Account identity comes from /api/auth/me since it is not profile settings.
      try {
        const me = await api('/api/auth/me');
        if (me.ok) {
          const { user } = await me.json();
          $('acct-email').value = user.id || user.email || '';
        }
      } catch { /* ignore */ }

      main.classList.remove('settings-loading', 'settings-load-failed');
      loadState.hidden = true;
    } catch (error) {
      main.classList.remove('settings-loading');
      main.classList.add('settings-load-failed');
      loadState.hidden = false;
      loadState.className = 'load-state err';
      loadState.textContent = 'Settings could not be loaded. Refresh to try again.';
      console.error('[settings] load failed', error);
    }
  }

  // --- save handlers -----------------------------------------------------
  const savers = {
    profile: () => ({ username: $('acct-username').value.trim() }),
    'results-sheet': () => ({ configs_root: $('rs-configs-root').value.trim() }),
    'session-viewer': () => ({
      claude_root: $('sv-claude-root').value.trim(),
      codex_root: $('sv-codex-root').value.trim(),
      openclaw_root: $('sv-openclaw-root').value.trim(),
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
          notify_suspended: $('te-notify-suspended').checked,
          notify_completed: $('te-notify-completed').checked,
          notify_failed: $('te-notify-failed').checked,
          notify_cancelled: $('te-notify-cancelled').checked,
        },
      };
      const key = $('te-wandb-key').value;
      if (key) body.wandb.api_key = key;
      if ($('te-wandb-clear').checked) body.wandb.clear_api_key = true;
      const hook = $('te-slack-webhook').value.trim();
      if (hook) body.notifications.slack_webhook_url = hook;
      if ($('te-slack-clear').checked) {
        body.notifications.clear_slack_webhook_url = true;
      }
      return body;
    },
  };

  async function saveSettings() {
    if (settingsState.saveInFlight) return;
    const button = $('settings-save');
    const submittedRevision = settingsState.revision;
    settingsState.saveInFlight = true;
    button.disabled = true;
    button.textContent = 'Saving...';
    setSaveStatus('Saving...', '');
    try {
      const body = Object.fromEntries(
        Object.entries(savers).map(([namespace, collect]) => [namespace, collect()]),
      );
      const result = await putSettings(body);
      setSaveStatus('Saved', 'ok');
      if (settingsState.revision === submittedRevision) {
        settingsState.dirty = false;
        fillSettings(result);
        void refreshWandbStatus();
      } else {
        setSaveStatus('Saved. More changes pending.', 'ok');
      }
    } catch (err) {
      setSaveStatus(err.message || 'Save failed', 'err');
      button.textContent = 'Retry save';
      return;
    } finally {
      settingsState.saveInFlight = false;
      button.disabled = false;
    }
    button.textContent = settingsState.dirty ? 'Save changes' : 'Save';
  }

  $('settings-save').addEventListener('click', saveSettings);

  function markSettingsDirty() {
    settingsState.dirty = true;
    settingsState.revision += 1;
    if (!settingsState.saveInFlight) $('settings-save').textContent = 'Save changes';
  }

  for (const sectionId of [
    'sec-account',
    'sec-train-eval',
    'sec-results-sheet',
    'sec-session-viewer',
  ]) {
    $(sectionId).addEventListener('input', markSettingsDirty);
  }

  window.addEventListener('beforeunload', (event) => {
    if (!settingsState.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  $('te-add-cluster').addEventListener('click', () => {
    $('te-clusters').appendChild(clusterBlock({ name: '', env: {} }));
    markSettingsDirty();
  });

  $('sign-out').addEventListener('click', async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch { /* ignore */ }
    settingsState.dirty = false;
    window.location.href = '/';
  });

  load();
})();
