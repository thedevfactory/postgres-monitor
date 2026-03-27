// ── State ────────────────────────────────────────────────────────────
let refreshTimer = null;
let activeTab = 'dashboard';
let selectedDb = null; // currently selected database for DB-specific views

// ── Helpers ──────────────────────────────────────────────────────────
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function esc(str) {
  if (str == null) return '';
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}

function fmtDuration(interval) {
  if (!interval) return '-';
  if (typeof interval === 'object') {
    const d = interval.days || 0;
    const h = interval.hours || 0;
    const min = interval.minutes || 0;
    const sec = Math.floor(interval.seconds || 0);
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0 || d > 0) parts.push(`${h}h`);
    if (min > 0) parts.push(`${min}m`);
    parts.push(`${sec}s`);
    return parts.join(' ');
  }
  const s = String(interval);
  const m = s.match(/(\d+):(\d+):(\d+)/);
  if (m) {
    const h = parseInt(m[1]), min = parseInt(m[2]), sec = parseInt(m[3]);
    if (h > 0) return `${h}h ${min}m ${sec}s`;
    if (min > 0) return `${min}m ${sec}s`;
    return `${sec}s`;
  }
  return s.replace(/\.\d+$/, '');
}

function fmtNumber(n) {
  if (n == null) return '-';
  return Number(n).toLocaleString();
}

function fmtDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleString();
}

function stateClass(state) {
  if (!state) return '';
  if (state === 'active') return 'state-active';
  if (state === 'idle') return 'state-idle';
  if (state.includes('idle in transaction')) return 'state-idle-tx';
  return '';
}

function toast(msg, type = 'error') {
  const c = $('#toast-container');
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

async function api(path) {
  try {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    toast(`API error: ${e.message}`);
    throw e;
  }
}

// DB-specific API call: appends ?db= for the selected database
function dbApi(path) {
  if (!selectedDb) return api(path);
  const sep = path.includes('?') ? '&' : '?';
  return api(`${path}${sep}db=${encodeURIComponent(selectedDb)}`);
}

// Update the context labels that show which DB is being viewed
function updateDbContextLabels() {
  $$('.db-context-label').forEach(el => {
    el.textContent = selectedDb ? `(${selectedDb})` : '';
  });
}

// ── Database Selector ───────────────────────────────────────────────
async function loadDatabaseList() {
  try {
    const rows = await api('/api/database-names');
    const sel = $('#db-selector');
    sel.innerHTML = rows.map(r =>
      `<option value="${esc(r.datname)}">${esc(r.datname)}</option>`
    ).join('');
    // Default to first database (usually 'postgres')
    if (!selectedDb && rows.length > 0) {
      selectedDb = rows[0].datname;
    }
    // Select the current value
    if (selectedDb) sel.value = selectedDb;
    updateDbContextLabels();
  } catch {}
}

$('#db-selector').addEventListener('change', () => {
  selectedDb = $('#db-selector').value;
  updateDbContextLabels();
  refreshAll();
});

// ── Sparkline SVG helper ─────────────────────────────────────────────
function sparklineSVG(points, width = 220, height = 44, color = '#5b9bd5') {
  if (!points || points.length < 2) return '<span class="placeholder">collecting...</span>';
  const values = points.map(p => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const coords = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 8) - 4;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = values[values.length - 1];
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <polyline points="${coords.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${width}" cy="${coords[coords.length-1].split(',')[1]}" r="2.5" fill="${color}"/>
  </svg>
  <span class="sparkline-value">${typeof last === 'number' && last % 1 !== 0 ? last.toFixed(1) : last}</span>`;
}

function computeTPS(series) {
  if (!series || series.length < 2) return null;
  const result = [];
  for (let i = 1; i < series.length; i++) {
    const dt = (series[i].ts - series[i-1].ts) / 1000;
    if (dt > 0) result.push({ ts: series[i].ts, value: Math.round((series[i].value - series[i-1].value) / dt) });
  }
  return result;
}

// ── Tab switching ────────────────────────────────────────────────────
$$('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.tab').forEach(b => b.classList.remove('active'));
    $$('.tab-content').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    activeTab = btn.dataset.tab;
    $(`#tab-${activeTab}`).classList.add('active');
    refreshAll();
  });
});

// ── Query cell expand ────────────────────────────────────────────────
document.addEventListener('click', e => {
  if (e.target.classList.contains('query-cell')) e.target.classList.toggle('expanded');
});

// ── Cancel / Terminate buttons ───────────────────────────────────────
document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const pid = btn.dataset.pid;
  const label = action === 'cancel' ? 'Cancel' : 'Terminate';
  if (!confirm(`${label} backend PID ${pid}?`)) return;
  try {
    await fetch(`/api/${action}/${pid}`, { method: 'POST' });
    toast(`${label} sent to PID ${pid}`, 'success');
    setTimeout(refreshAll, 500);
  } catch (e) {
    toast(`Failed to ${action} PID ${pid}`);
  }
});

// ── Health Action Modal ───────────────────────────────────────────────
let actionModalAction = null;

function openActionModal() {
  $('#action-modal').hidden = false;
}

function closeActionModal() {
  $('#action-modal').hidden = true;
  actionModalAction = null;
}

function renderModalPreview(preview) {
  const body = $('#action-modal-body');
  const runBtn = $('#action-modal-run');
  const cancelBtn = $('#action-modal-cancel');
  $('#action-modal-title').textContent = preview.title;

  if (preview.empty) {
    body.innerHTML = `<div class="modal-description">${esc(preview.description)}</div>`;
    runBtn.hidden = true;
    cancelBtn.textContent = 'Close';
    return;
  }

  const targetsHtml = preview.targets.length > 0 ? `
    <div class="modal-section-label">Affected targets (${preview.targets.length})</div>
    <div class="modal-targets">
      ${preview.targets.map(t => `<div class="modal-target-row">
        <span class="modal-target-name">${esc(t.name)}</span>
        <span class="modal-target-detail">${esc(t.detail)}</span>
      </div>`).join('')}
    </div>` : '';

  const sqlHtml = preview.queries.length > 0 ? `
    <div class="modal-section-label">SQL to execute</div>
    <div class="modal-sql">${esc(preview.queries.join('\n'))}</div>` : '';

  body.innerHTML = `
    <div class="modal-description">${esc(preview.description)}</div>
    ${targetsHtml}
    ${sqlHtml}`;

  runBtn.hidden = false;
  runBtn.disabled = false;
  runBtn.textContent = 'Execute';
  cancelBtn.textContent = 'Cancel';
}

async function executeAction(action) {
  const body = $('#action-modal-body');
  const runBtn = $('#action-modal-run');
  const cancelBtn = $('#action-modal-cancel');

  runBtn.disabled = true;
  runBtn.textContent = 'Running...';

  // Add progress section below existing content
  const progressEl = document.createElement('div');
  progressEl.innerHTML = `
    <div class="modal-section-label" style="margin-top:14px">Execution Progress</div>
    <div class="modal-progress" id="action-progress"></div>`;
  body.appendChild(progressEl);
  body.scrollTop = body.scrollHeight;

  const log = $('#action-progress');

  try {
    const resp = await fetch(`/api/health-action/${action}`, { method: 'POST' });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE lines
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line in buffer
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const evt = JSON.parse(line.slice(6));

        if (evt.step === -1) {
          // Final summary
          if (evt.status === 'complete') {
            const msg = evt.failed > 0
              ? `Completed: ${evt.completed} succeeded, ${evt.failed} failed out of ${evt.total}`
              : `Completed: All ${evt.total} step${evt.total !== 1 ? 's' : ''} succeeded`;
            log.insertAdjacentHTML('beforeend',
              `<div class="modal-summary ${evt.failed > 0 ? 'error' : 'success'}">${esc(msg)}</div>`);
          } else {
            log.insertAdjacentHTML('beforeend',
              `<div class="modal-summary error">${esc(evt.message || 'Unknown error')}</div>`);
          }
        } else if (evt.status === 'running') {
          log.insertAdjacentHTML('beforeend',
            `<div class="modal-step" id="action-step-${evt.step}">
              <span class="modal-step-icon running">&#8635;</span>
              <span class="modal-step-text">${esc(evt.label)}</span>
              <span class="modal-step-duration"></span>
            </div>`);
        } else if (evt.status === 'done' || evt.status === 'error') {
          const stepEl = $(`#action-step-${evt.step}`);
          if (stepEl) {
            const icon = stepEl.querySelector('.modal-step-icon');
            icon.className = `modal-step-icon ${evt.status === 'done' ? 'done' : 'error'}`;
            icon.innerHTML = evt.status === 'done' ? '&#10003;' : '&#10007;';
            const dur = stepEl.querySelector('.modal-step-duration');
            dur.textContent = evt.duration != null ? `${(evt.duration / 1000).toFixed(2)}s` : '';
            if (evt.error) {
              stepEl.insertAdjacentHTML('beforeend',
                `<span class="modal-step-duration" style="color:var(--crit);margin-left:8px">${esc(evt.error)}</span>`);
            }
          }
        }
        body.scrollTop = body.scrollHeight;
      }
    }
  } catch (err) {
    log.insertAdjacentHTML('beforeend',
      `<div class="modal-summary error">Connection error: ${esc(err.message)}</div>`);
  }

  runBtn.hidden = true;
  cancelBtn.textContent = 'Close';
  setTimeout(refreshAll, 1000);
}

// Click: open preview modal
document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-health-action]');
  if (!btn) return;
  actionModalAction = btn.dataset.healthAction;

  // Show loading state in modal
  $('#action-modal-title').textContent = 'Loading...';
  $('#action-modal-body').innerHTML = '<div class="modal-description">Fetching preview...</div>';
  $('#action-modal-run').hidden = true;
  $('#action-modal-cancel').textContent = 'Cancel';
  openActionModal();

  try {
    const resp = await fetch(`/api/health-action/${actionModalAction}/preview`);
    const preview = await resp.json();
    if (!resp.ok) throw new Error(preview.error || 'Failed to load preview');
    renderModalPreview(preview);
  } catch (err) {
    $('#action-modal-title').textContent = 'Error';
    $('#action-modal-body').innerHTML = `<div class="modal-summary error">${esc(err.message)}</div>`;
    $('#action-modal-run').hidden = true;
    $('#action-modal-cancel').textContent = 'Close';
  }
});

// Click: execute button in modal
$('#action-modal-run').addEventListener('click', () => {
  if (actionModalAction) executeAction(actionModalAction);
});

// Click: close modal
document.addEventListener('click', e => {
  if (e.target.closest('[data-modal-close]')) closeActionModal();
  if (e.target === $('#action-modal')) closeActionModal();
});

// ── Index Advisor Modal ───────────────────────────────────────────────
document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-rec-advisor]');
  if (!btn) return;
  const [schema, table] = btn.dataset.recAdvisor.split('.');
  openIndexAdvisor(schema, table);
});

async function openIndexAdvisor(schema, table) {
  $('#action-modal-title').textContent = `Index Advisor: ${schema}.${table}`;
  $('#action-modal-body').innerHTML = '<div class="modal-description">Loading table analysis...</div>';
  $('#action-modal-run').hidden = true;
  $('#action-modal-cancel').textContent = 'Close';
  openActionModal();

  try {
    const dbParam = selectedDb ? `?db=${encodeURIComponent(selectedDb)}` : '';
    const resp = await fetch(`/api/index-advisor/${encodeURIComponent(schema)}/${encodeURIComponent(table)}${dbParam}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to load');
    renderIndexAdvisor(data);
  } catch (err) {
    $('#action-modal-body').innerHTML = `<div class="modal-summary error">${esc(err.message)}</div>`;
  }
}

function renderIndexAdvisor(data) {
  const body = $('#action-modal-body');
  let html = '';

  // Table stats
  if (data.stats) {
    const s = data.stats;
    html += `<div class="modal-section-label">Table Overview</div>
      <div class="advisor-stats">
        <div class="advisor-stat"><span class="advisor-stat-val">${esc(s.total_size)}</span><span class="advisor-stat-lbl">Total Size</span></div>
        <div class="advisor-stat"><span class="advisor-stat-val">${fmtNumber(s.n_live_tup)}</span><span class="advisor-stat-lbl">Live Rows</span></div>
        <div class="advisor-stat"><span class="advisor-stat-val">${fmtNumber(s.n_dead_tup)}</span><span class="advisor-stat-lbl">Dead Rows</span></div>
        <div class="advisor-stat"><span class="advisor-stat-val">${fmtNumber(s.seq_scan)}</span><span class="advisor-stat-lbl">Seq Scans</span></div>
        <div class="advisor-stat"><span class="advisor-stat-val">${fmtNumber(s.idx_scan)}</span><span class="advisor-stat-lbl">Idx Scans</span></div>
      </div>`;
  }

  // Columns
  html += `<div class="modal-section-label" style="margin-top:14px">Columns (${data.columns.length})</div>
    <div class="advisor-table-wrap"><table class="advisor-table">
      <thead><tr><th>Column</th><th>Type</th><th>Not Null</th><th>PK</th></tr></thead>
      <tbody>${data.columns.map(c => `<tr>
        <td class="mono">${esc(c.column_name)}</td>
        <td>${esc(c.data_type)}</td>
        <td>${c.not_null ? 'Y' : ''}</td>
        <td>${c.is_primary ? 'PK' : ''}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;

  // Existing indexes
  html += `<div class="modal-section-label" style="margin-top:14px">Existing Indexes (${data.indexes.length})</div>`;
  if (data.indexes.length === 0) {
    html += '<div class="advisor-empty">No indexes on this table</div>';
  } else {
    html += `<div class="advisor-table-wrap"><table class="advisor-table">
      <thead><tr><th>Index</th><th>Size</th><th>Unique</th><th>Definition</th></tr></thead>
      <tbody>${data.indexes.map(idx => `<tr>
        <td class="mono">${esc(idx.index_name)}</td>
        <td>${esc(idx.size)}</td>
        <td>${idx.is_unique ? 'Y' : ''}</td>
        <td class="mono" style="font-size:.7rem;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(idx.definition)}">${esc(idx.definition)}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }

  // Top queries
  if (data.topQueries.length > 0) {
    html += `<div class="modal-section-label" style="margin-top:14px">Top Queries Hitting This Table</div>`;
    html += data.topQueries.map(q => `<div class="advisor-query-card">
      <div class="advisor-query-meta">
        <span>${fmtNumber(q.calls)} calls</span>
        <span>avg ${q.avg_ms}ms</span>
        <span>~${fmtNumber(q.avg_rows)} rows/call</span>
      </div>
      <div class="modal-sql" style="max-height:60px;margin-bottom:8px">${esc(q.query)}</div>
    </div>`).join('');
  }

  // Suggested indexes
  html += `<div class="modal-section-label" style="margin-top:14px">Suggested Indexes (${data.suggestions.length})</div>`;
  if (data.suggestions.length === 0) {
    html += '<div class="advisor-empty">No additional indexes suggested. Column naming patterns do not indicate obvious candidates. Review the top queries above and add indexes on columns used in WHERE and JOIN clauses.</div>';
  } else {
    html += data.suggestions.map(s => `<div class="advisor-suggestion">
      <div class="advisor-suggestion-header">
        <span class="mono" style="font-weight:600">${esc(s.column)}</span>
        <span class="advisor-suggestion-type">${esc(s.type)}</span>
        <span class="advisor-suggestion-reason">${esc(s.reason)}</span>
      </div>
      <div class="advisor-suggestion-sql">${esc(s.sql)}</div>
      <button class="btn btn-sm advisor-copy-btn" data-copy-sql="${esc(s.sql)}">Copy SQL</button>
    </div>`).join('');
  }

  // Generate combined SQL
  if (data.suggestions.length > 0) {
    const allSql = data.suggestions.map(s => s.sql).join('\n');
    html += `<div class="modal-section-label" style="margin-top:14px">All Suggested Indexes (Copy All)</div>
      <div class="modal-sql">${esc(allSql)}</div>
      <button class="btn btn-sm advisor-copy-btn" data-copy-sql="${esc(allSql)}" style="margin-top:6px">Copy All SQL</button>`;
  }

  body.innerHTML = html;
}

// Copy SQL to clipboard
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-copy-sql]');
  if (!btn) return;
  const sql = btn.dataset.copySql;
  navigator.clipboard.writeText(sql).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  }).catch(() => {
    toast('Failed to copy to clipboard');
  });
});

// ═══════════════════════════════════════════════════════════════════
// RENDERERS — Server-wide (use api())
// ═══════════════════════════════════════════════════════════════════

async function renderServerInfo() {
  try {
    const d = await api('/api/server-info');
    $('#server-info-body').innerHTML = `<div class="info-grid">
      <div class="info-item"><div class="info-label">Version</div><div class="info-value">${esc(d.server_version)}</div></div>
      <div class="info-item"><div class="info-label">Uptime</div><div class="info-value">${fmtDuration(d.uptime)}</div></div>
      <div class="info-item"><div class="info-label">Connections</div><div class="info-value">${esc(d.current_connections)} / ${esc(d.max_connections)}</div></div>
      <div class="info-item"><div class="info-label">Current DB Size</div><div class="info-value">${esc(d.current_db_size)}</div></div>
      <div class="info-item"><div class="info-label">Shared Buffers</div><div class="info-value">${esc(d.shared_buffers)}</div></div>
      <div class="info-item"><div class="info-label">Effective Cache</div><div class="info-value">${esc(d.effective_cache_size)}</div></div>
      <div class="info-item"><div class="info-label">Work Mem</div><div class="info-value">${esc(d.work_mem)}</div></div>
      <div class="info-item"><div class="info-label">Maint. Work Mem</div><div class="info-value">${esc(d.maintenance_work_mem)}</div></div>
    </div>`;
  } catch {}
}

async function renderHealth() {
  try {
    const d = await api('/api/health');
    const badge = $('#health-badge');
    badge.textContent = d.status.toUpperCase();
    badge.className = `badge badge-${d.status}`;
    $('#health-checks-body').innerHTML = `<div class="health-list">
      ${d.checks.map(c => {
        const actionsHtml = (c.actions && c.actions.length > 0)
          ? `<div class="health-actions">${c.actions.map(a =>
              `<button class="btn btn-sm health-action-btn" data-health-action="${esc(a.id)}">${esc(a.label)}</button>`
            ).join('')}</div>` : '';
        return `<div class="health-item ${c.status}">
          <div class="health-row">
            <span class="health-name">${esc(c.name)}</span>
            <span class="health-value">${esc(c.value)}</span>
          </div>
          ${c.hint ? `<div class="health-hint"><span class="health-hint-icon">&#9432;</span> ${esc(c.hint)}${actionsHtml}</div>` : ''}
        </div>`;
      }).join('')}
    </div>`;
  } catch {}
}

async function renderLongQueries() {
  try {
    const rows = await api('/api/long-queries');
    if (rows.length === 0) { $('#long-queries-body').innerHTML = '<p class="empty-msg">No long-running queries</p>'; return; }
    $('#long-queries-body').innerHTML = `<table>
      <thead><tr><th>PID</th><th>User</th><th>Database</th><th>Duration</th><th>Wait</th><th>Query</th><th>Actions</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td class="mono">${esc(r.pid)}</td><td>${esc(r.username)}</td><td>${esc(r.database)}</td>
        <td class="mono">${fmtDuration(r.duration)}</td><td>${esc(r.wait_event || '-')}</td>
        <td class="query-cell">${esc(r.query)}</td>
        <td><button class="btn btn-sm btn-warn" data-action="cancel" data-pid="${r.pid}">Cancel</button></td>
      </tr>`).join('')}</tbody></table>`;
  } catch {}
}

async function renderBlocking() {
  try {
    const rows = await api('/api/blocking');
    if (rows.length === 0) { $('#blocking-body').innerHTML = '<p class="empty-msg">No blocking chains detected</p>'; return; }
    $('#blocking-body').innerHTML = `<table>
      <thead><tr><th>Blocked PID</th><th>Blocked User</th><th>Blocked Query</th><th>Waiting</th><th>Blocking PID</th><th>Blocking User</th><th>Blocking Query</th><th>Actions</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td class="mono">${esc(r.blocked_pid)}</td><td>${esc(r.blocked_user)}</td>
        <td class="query-cell">${esc(r.blocked_query)}</td><td class="mono">${fmtDuration(r.blocked_duration)}</td>
        <td class="mono">${esc(r.blocking_pid)}</td><td>${esc(r.blocking_user)}</td>
        <td class="query-cell">${esc(r.blocking_query)}</td>
        <td><button class="btn btn-sm btn-danger" data-action="terminate" data-pid="${r.blocking_pid}">Kill</button></td>
      </tr>`).join('')}</tbody></table>`;
  } catch {}
}

async function renderDatabases() {
  try {
    const rows = await api('/api/databases');
    $('#databases-body').innerHTML = `<table>
      <thead><tr>
        <th>Database</th><th class="num">Size</th><th class="num">Connections</th>
        <th class="num">Commits</th><th class="num">Rollbacks</th><th class="num">Rollback %</th>
        <th class="num">Cache Hit %</th><th class="num">Deadlocks</th><th class="num">Temp Files</th>
        <th class="num">Temp Bytes</th><th>Stats Reset</th>
      </tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td><strong>${esc(r.name)}</strong></td>
        <td class="num mono">${esc(r.size)}</td><td class="num mono">${fmtNumber(r.connections)}</td>
        <td class="num mono">${fmtNumber(r.commits)}</td><td class="num mono">${fmtNumber(r.rollbacks)}</td>
        <td class="num mono ${parseFloat(r.rollback_pct) > 5 ? 'state-waiting' : ''}">${r.rollback_pct}%</td>
        <td class="num mono ${parseFloat(r.cache_hit_ratio) < 95 ? 'state-idle-tx' : ''}">${r.cache_hit_ratio}%</td>
        <td class="num mono ${parseInt(r.deadlocks) > 0 ? 'state-waiting' : ''}">${fmtNumber(r.deadlocks)}</td>
        <td class="num mono">${fmtNumber(r.temp_files)}</td>
        <td class="num mono">${esc(r.temp_bytes)}</td>
        <td class="mono" style="font-size:.72rem">${fmtDate(r.stats_reset)}</td>
      </tr>`).join('')}</tbody></table>`;
  } catch {}
}

async function renderQueries() {
  try {
    const rows = await api('/api/active-queries');
    const showIdle = $('#show-idle').checked;
    const filtered = showIdle ? rows : rows.filter(r => r.state !== 'idle');
    if (filtered.length === 0) { $('#queries-body').innerHTML = '<p class="empty-msg">No active queries</p>'; return; }
    $('#queries-body').innerHTML = `<table>
      <thead><tr><th>PID</th><th>User</th><th>Database</th><th>State</th><th>Duration</th><th>Wait</th><th>Client</th><th>App</th><th>Query</th><th>Actions</th></tr></thead>
      <tbody>${filtered.map(r => `<tr>
        <td class="mono">${esc(r.pid)}</td><td>${esc(r.username)}</td><td>${esc(r.database)}</td>
        <td class="${stateClass(r.state)}">${esc(r.state)}</td>
        <td class="mono">${fmtDuration(r.query_duration)}</td>
        <td>${esc(r.wait_event ? `${r.wait_event_type}: ${r.wait_event}` : '-')}</td>
        <td class="mono" style="font-size:.72rem">${esc(r.client_addr || 'local')}</td>
        <td style="font-size:.78rem">${esc(r.application_name || '-')}</td>
        <td class="query-cell">${esc(r.query)}</td>
        <td>${r.state === 'active' ? `<button class="btn btn-sm btn-warn" data-action="cancel" data-pid="${r.pid}">Cancel</button>` : ''}</td>
      </tr>`).join('')}</tbody></table>`;
  } catch {}
}

async function renderLocks() {
  try {
    const rows = await api('/api/locks');
    if (rows.length === 0) { $('#locks-body').innerHTML = '<p class="empty-msg">No locks</p>'; return; }
    $('#locks-body').innerHTML = `<table>
      <thead><tr><th>PID</th><th>User</th><th>Database</th><th>Lock Type</th><th>Mode</th><th>Granted</th><th>Relation</th><th>State</th><th>Duration</th><th>Query</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td class="mono">${esc(r.pid)}</td><td>${esc(r.username)}</td><td>${esc(r.database)}</td>
        <td>${esc(r.locktype)}</td><td class="mono" style="font-size:.72rem">${esc(r.mode)}</td>
        <td class="${r.granted ? 'state-active' : 'state-waiting'}">${r.granted ? 'Yes' : 'WAITING'}</td>
        <td class="mono">${esc(r.relation || '-')}</td>
        <td class="${stateClass(r.state)}">${esc(r.state)}</td>
        <td class="mono">${fmtDuration(r.duration)}</td>
        <td class="query-cell">${esc(r.query)}</td>
      </tr>`).join('')}</tbody></table>`;
  } catch {}
}

async function renderConnections() {
  try {
    const data = await api('/api/connections');
    const maxCount = Math.max(...data.summary.map(s => parseInt(s.count)), 1);
    $('#conn-summary-body').innerHTML = `<div class="bar-chart">
      ${data.summary.map(s => `<div class="bar-row">
        <span class="bar-label">${esc(s.state || 'null')}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${(parseInt(s.count)/maxCount*100).toFixed(1)}%"></div></div>
        <span class="bar-count">${s.count}</span>
      </div>`).join('')}
    </div>`;
    if (data.details.length === 0) { $('#conn-details-body').innerHTML = '<p class="empty-msg">No connections</p>'; return; }
    $('#conn-details-body').innerHTML = `<table>
      <thead><tr><th>Database</th><th>User</th><th>Client</th><th>State</th><th class="num">Count</th></tr></thead>
      <tbody>${data.details.map(r => `<tr>
        <td>${esc(r.database)}</td><td>${esc(r.username)}</td>
        <td class="mono">${esc(r.client_addr || 'local')}</td>
        <td class="${stateClass(r.state)}">${esc(r.state)}</td>
        <td class="num mono">${r.count}</td>
      </tr>`).join('')}</tbody></table>`;
  } catch {}
}

async function renderReplication() {
  try {
    const rows = await api('/api/replication');
    if (rows.length === 0) { $('#replication-body').innerHTML = '<p class="empty-msg">No replication slots active (standalone server or no replicas connected)</p>'; return; }
    $('#replication-body').innerHTML = `<table>
      <thead><tr><th>Client</th><th>User</th><th>App</th><th>State</th>
        <th>Sent LSN</th><th>Write LSN</th><th>Flush LSN</th><th>Replay LSN</th>
        <th>Sync</th><th>Last Reply</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td class="mono">${esc(r.client_addr)}</td><td>${esc(r.usename)}</td>
        <td>${esc(r.application_name)}</td>
        <td class="${r.state === 'streaming' ? 'state-active' : ''}">${esc(r.state)}</td>
        <td class="mono">${esc(r.sent_lsn)}</td><td class="mono">${esc(r.write_lsn)}</td>
        <td class="mono">${esc(r.flush_lsn)}</td><td class="mono">${esc(r.replay_lsn)}</td>
        <td>${esc(r.sync_state)}</td>
        <td class="mono" style="font-size:.72rem">${fmtDate(r.reply_time)}</td>
      </tr>`).join('')}</tbody></table>`;
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════
// RENDERERS — DB-specific (use dbApi())
// ═══════════════════════════════════════════════════════════════════

async function renderTables() {
  try {
    const rows = await dbApi('/api/table-stats');
    if (rows.length === 0) { $('#tables-body').innerHTML = '<p class="empty-msg">No user tables in this database</p>'; return; }
    $('#tables-body').innerHTML = `<table>
      <thead><tr>
        <th>Schema</th><th>Table</th><th class="num">Size</th>
        <th class="num">Live Rows</th><th class="num">Dead Rows</th><th class="num">Dead %</th>
        <th>Last Vacuum</th><th>Last Autovacuum</th>
        <th class="num">Seq Scans</th><th class="num">Idx Scans</th>
      </tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${esc(r.schema)}</td><td><strong>${esc(r.table)}</strong></td>
        <td class="num mono">${esc(r.total_size)}</td>
        <td class="num mono">${fmtNumber(r.live_rows)}</td>
        <td class="num mono">${fmtNumber(r.dead_rows)}</td>
        <td class="num mono ${parseFloat(r.dead_row_pct) > 20 ? 'state-waiting' : ''}">${r.dead_row_pct}%</td>
        <td class="mono" style="font-size:.72rem">${fmtDate(r.last_vacuum)}</td>
        <td class="mono" style="font-size:.72rem">${fmtDate(r.last_autovacuum)}</td>
        <td class="num mono">${fmtNumber(r.seq_scan)}</td>
        <td class="num mono">${fmtNumber(r.idx_scan)}</td>
      </tr>`).join('')}</tbody></table>`;
  } catch {}
}

async function renderIndexes() {
  try {
    const rows = await dbApi('/api/index-stats');
    if (rows.length === 0) { $('#indexes-body').innerHTML = '<p class="empty-msg">No user indexes in this database</p>'; return; }
    $('#indexes-body').innerHTML = `<table>
      <thead><tr>
        <th>Schema</th><th>Table</th><th>Index</th><th class="num">Size</th>
        <th class="num">Scans</th><th class="num">Tuples Read</th><th class="num">Tuples Fetched</th><th>Status</th>
      </tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${esc(r.schema)}</td><td>${esc(r.table)}</td>
        <td class="mono">${esc(r.index)}</td>
        <td class="num mono">${esc(r.index_size)}</td>
        <td class="num mono ${parseInt(r.scans) === 0 ? 'state-waiting' : ''}">${fmtNumber(r.scans)}</td>
        <td class="num mono">${fmtNumber(r.tuples_read)}</td>
        <td class="num mono">${fmtNumber(r.tuples_fetched)}</td>
        <td>${r.unused ? '<span class="badge badge-warning">UNUSED</span>' : ''}</td>
      </tr>`).join('')}</tbody></table>`;
  } catch {}
}

async function renderSlowQueries() {
  try {
    const data = await dbApi('/api/slow-queries');
    if (!data.available) {
      const msg = data.reason && data.reason.includes('shared_preload_libraries')
        ? 'pg_stat_statements must be added to <code>shared_preload_libraries</code> in postgresql.conf and requires a server restart.'
        : 'pg_stat_statements extension is not installed. Run <code>CREATE EXTENSION pg_stat_statements;</code> to enable.';
      $('#slow-body').innerHTML = `<p class="empty-msg">${msg}</p>`;
      return;
    }
    if (data.rows.length === 0) { $('#slow-body').innerHTML = '<p class="empty-msg">No query stats collected yet</p>'; return; }
    $('#slow-body').innerHTML = `<table>
      <thead><tr><th>Query</th><th class="num">Calls</th><th class="num">Total (ms)</th>
        <th class="num">Avg (ms)</th><th class="num">Max (ms)</th>
        <th class="num">Rows</th><th class="num">Cache Hit %</th></tr></thead>
      <tbody>${data.rows.map(r => `<tr>
        <td class="query-cell">${esc(r.query)}</td>
        <td class="num mono">${fmtNumber(r.calls)}</td>
        <td class="num mono">${fmtNumber(r.total_time_ms)}</td>
        <td class="num mono">${fmtNumber(r.avg_time_ms)}</td>
        <td class="num mono">${fmtNumber(r.max_time_ms)}</td>
        <td class="num mono">${fmtNumber(r.rows)}</td>
        <td class="num mono">${r.cache_hit_ratio}%</td>
      </tr>`).join('')}</tbody></table>`;
  } catch {}
}

// ── Sparklines ───────────────────────────────────────────────────────
async function renderSparklines() {
  try {
    const data = await api('/api/metric-history');
    const tps = computeTPS(data.total_xacts);
    const items = [
      { label: 'Connections', series: data.connections, color: '#5b9bd5' },
      { label: 'Active Queries', series: data.active_queries, color: '#22c55e' },
      { label: 'TPS', series: tps, color: '#a78bfa' },
      { label: 'Cache Hit %', series: data.cache_hit_ratio, color: '#f59e0b' },
      { label: 'Waiting Locks', series: data.waiting_locks, color: '#ef4444' },
    ];
    $('#sparklines-body').innerHTML = `<div class="sparkline-grid">
      ${items.map(it => `<div class="sparkline-card">
        <div class="sparkline-label">${it.label}</div>
        <div class="sparkline-row">${sparklineSVG(it.series, 220, 44, it.color)}</div>
      </div>`).join('')}
    </div>`;
  } catch {}
}

// ── XID Wraparound ───────────────────────────────────────────────────
async function renderXidWraparound() {
  try {
    const data = await dbApi('/api/txid-wraparound');
    if (data.databases.length === 0) { $('#xid-wrap-body').innerHTML = '<p class="empty-msg">No databases</p>'; return; }
    const dbRows = data.databases.map(r => {
      const pct = parseFloat(r.pct_towards_wraparound);
      const cls = pct > 75 ? 'progress-crit' : pct > 50 ? 'progress-warn' : 'progress-ok';
      return `<div class="progress-row">
        <span class="progress-label">${esc(r.database)}</span>
        <div class="progress-track"><div class="progress-fill ${cls}" style="width:${Math.min(pct, 100)}%"></div></div>
        <span class="progress-pct">${pct}%</span>
        <span class="progress-detail mono">${fmtNumber(r.xid_age)} / ${fmtNumber(r.freeze_max_age)}</span>
      </div>`;
    }).join('');
    const tblRows = data.tables.length > 0 ? `<details class="details-section"><summary>Top tables by XID age</summary><table>
      <thead><tr><th>Schema</th><th>Table</th><th class="num">XID Age</th><th class="num">Size</th><th>Last Autovacuum</th></tr></thead>
      <tbody>${data.tables.map(r => `<tr>
        <td>${esc(r.schema)}</td><td><strong>${esc(r.table)}</strong></td>
        <td class="num mono">${fmtNumber(r.xid_age)}</td>
        <td class="num mono">${esc(r.size)}</td>
        <td class="mono" style="font-size:.72rem">${fmtDate(r.last_autovacuum)}</td>
      </tr>`).join('')}</tbody></table></details>` : '';
    $('#xid-wrap-body').innerHTML = `<div class="progress-list">${dbRows}</div>${tblRows}`;
  } catch {}
}

// ── Recommendations ──────────────────────────────────────────────────
async function renderRecommendations() {
  try {
    const recs = await dbApi('/api/recommendations');
    if (recs.length === 0) { $('#recommendations-body').innerHTML = '<p class="empty-msg">No recommendations - everything looks good!</p>'; return; }
    $('#recommendations-body').innerHTML = `<div class="health-list">
      ${recs.map(r => {
        const actionBtn = r.action === 'index-advisor'
          ? `<button class="btn btn-sm rec-investigate-btn" data-rec-advisor="${esc(r.schema)}.${esc(r.table)}">Investigate</button>`
          : '';
        return `<div class="health-row ${r.severity === 'info' ? 'ok' : r.severity}">
          <div style="flex:1">
            <span class="rec-category">${esc(r.category)}</span>
            <span class="health-name">${esc(r.message)}</span>
            <div class="rec-detail">${esc(r.detail)}</div>
          </div>
          ${actionBtn}
        </div>`;
      }).join('')}
    </div>`;
  } catch {}
}

// ── Table Bloat ──────────────────────────────────────────────────────
async function renderBloat() {
  try {
    const rows = await dbApi('/api/table-bloat');
    if (rows.length === 0) { $('#bloat-body').innerHTML = '<p class="empty-msg">No bloat detected or no user tables</p>'; return; }
    $('#bloat-body').innerHTML = `<table>
      <thead><tr><th>Schema</th><th>Table</th><th class="num">Real Size</th><th class="num">Bloat Size</th><th class="num">Bloat %</th></tr></thead>
      <tbody>${rows.map(r => {
        const pct = parseFloat(r.bloat_pct);
        return `<tr>
        <td>${esc(r.schema)}</td><td><strong>${esc(r.table)}</strong></td>
        <td class="num mono">${esc(r.real_size)}</td>
        <td class="num mono">${esc(r.bloat_size)}</td>
        <td class="num mono ${pct > 60 ? 'state-waiting' : pct > 40 ? 'state-idle-tx' : ''}">${pct}%</td>
      </tr>`;
      }).join('')}</tbody></table>`;
  } catch {}
}

// ── Sequences ────────────────────────────────────────────────────────
async function renderSequences() {
  try {
    const rows = await dbApi('/api/sequences');
    if (rows.length === 0) { $('#sequences-body').innerHTML = '<p class="empty-msg">No user sequences in this database</p>'; return; }
    $('#sequences-body').innerHTML = `<table>
      <thead><tr><th>Schema</th><th>Sequence</th><th>Type</th><th class="num">Last Value</th><th class="num">Max Value</th><th class="num">Used %</th></tr></thead>
      <tbody>${rows.map(r => {
        const pct = parseFloat(r.pct_used);
        return `<tr>
        <td>${esc(r.schema)}</td><td class="mono">${esc(r.sequence)}</td><td>${esc(r.data_type)}</td>
        <td class="num mono">${fmtNumber(r.last_value)}</td>
        <td class="num mono">${fmtNumber(r.max_value)}</td>
        <td class="num mono ${pct > 90 ? 'state-waiting' : pct > 75 ? 'state-idle-tx' : ''}">${pct}%</td>
      </tr>`;
      }).join('')}</tbody></table>`;
  } catch {}
}

// ── Table I/O ────────────────────────────────────────────────────────
async function renderTableIO() {
  try {
    const rows = await dbApi('/api/table-io');
    if (rows.length === 0) { $('#table-io-body').innerHTML = '<p class="empty-msg">No I/O stats available</p>'; return; }
    $('#table-io-body').innerHTML = `<table>
      <thead><tr><th>Schema</th><th>Table</th><th class="num">Heap Read</th><th class="num">Heap Hit</th><th class="num">Heap Hit %</th>
        <th class="num">Idx Read</th><th class="num">Idx Hit</th><th class="num">Toast Read</th><th class="num">Toast Hit</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${esc(r.schema)}</td><td><strong>${esc(r.table)}</strong></td>
        <td class="num mono">${fmtNumber(r.heap_blks_read)}</td>
        <td class="num mono">${fmtNumber(r.heap_blks_hit)}</td>
        <td class="num mono ${parseFloat(r.heap_hit_pct) < 90 ? 'state-idle-tx' : ''}">${r.heap_hit_pct}%</td>
        <td class="num mono">${fmtNumber(r.idx_blks_read)}</td>
        <td class="num mono">${fmtNumber(r.idx_blks_hit)}</td>
        <td class="num mono">${fmtNumber(r.toast_blks_read)}</td>
        <td class="num mono">${fmtNumber(r.toast_blks_hit)}</td>
      </tr>`).join('')}</tbody></table>`;
  } catch {}
}

// ── Invalid Indexes ──────────────────────────────────────────────────
async function renderInvalidIndexes() {
  try {
    const rows = await dbApi('/api/invalid-indexes');
    if (rows.length === 0) { $('#invalid-idx-banner').innerHTML = ''; return; }
    $('#invalid-idx-banner').innerHTML = `<div class="card banner-critical">
      <h2>Invalid Indexes Found!</h2>
      <div class="card-body"><table>
        <thead><tr><th>Schema</th><th>Table</th><th>Index</th><th>Size</th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td>${esc(r.schema)}</td><td>${esc(r.table)}</td>
          <td class="mono">${esc(r.index)}</td><td class="mono">${esc(r.size)}</td>
        </tr>`).join('')}</tbody>
      </table><p class="rec-detail">Run REINDEX or drop and recreate these indexes.</p></div>
    </div>`;
  } catch {}
}

// ── Duplicate Indexes ────────────────────────────────────────────────
async function renderDuplicateIndexes() {
  try {
    const rows = await dbApi('/api/duplicate-indexes');
    if (rows.length === 0) { $('#dup-indexes-body').innerHTML = '<p class="empty-msg">No duplicate indexes found</p>'; return; }
    $('#dup-indexes-body').innerHTML = `<table>
      <thead><tr><th>Schema</th><th>Table</th><th>Indexes</th><th>Sizes</th><th class="num">Wasted Space</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${esc(r.schema)}</td><td><strong>${esc(r.table)}</strong></td>
        <td class="mono" style="font-size:.72rem">${esc((r.index_names || []).join(', '))}</td>
        <td class="mono" style="font-size:.72rem">${esc((r.index_sizes || []).join(', '))}</td>
        <td class="num mono state-idle-tx">${esc(r.wasted_size)}</td>
      </tr>`).join('')}</tbody></table>`;
  } catch {}
}

// ── Function Stats ───────────────────────────────────────────────────
async function renderFunctionStats() {
  try {
    const rows = await dbApi('/api/function-stats');
    if (rows.length === 0) {
      $('#function-stats-body').innerHTML = '<p class="empty-msg">No function stats (enable <code>track_functions = \'pl\'</code> or <code>\'all\'</code> in postgresql.conf)</p>';
      return;
    }
    $('#function-stats-body').innerHTML = `<table>
      <thead><tr><th>Schema</th><th>Function</th><th class="num">Calls</th><th class="num">Total (ms)</th><th class="num">Self (ms)</th><th class="num">Avg (ms)</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${esc(r.schema)}</td><td class="mono">${esc(r.function)}</td>
        <td class="num mono">${fmtNumber(r.calls)}</td>
        <td class="num mono">${fmtNumber(r.total_time_ms)}</td>
        <td class="num mono">${fmtNumber(r.self_time_ms)}</td>
        <td class="num mono">${fmtNumber(r.avg_time_ms)}</td>
      </tr>`).join('')}</tbody></table>`;
  } catch {}
}

// ── WAL Archiver ─────────────────────────────────────────────────────
async function renderArchiver() {
  try {
    const d = await api('/api/wal-archiver');
    const failClass = parseInt(d.failed_count || 0) > 0 ? 'state-waiting' : '';
    $('#archiver-body').innerHTML = `<div class="info-grid">
      <div class="info-item"><div class="info-label">Archived Count</div><div class="info-value">${fmtNumber(d.archived_count)}</div></div>
      <div class="info-item"><div class="info-label">Last Archived WAL</div><div class="info-value mono" style="font-size:.78rem">${esc(d.last_archived_wal || '-')}</div></div>
      <div class="info-item"><div class="info-label">Last Archived At</div><div class="info-value">${fmtDate(d.last_archived_time)}</div></div>
      <div class="info-item"><div class="info-label">Failed Count</div><div class="info-value ${failClass}">${fmtNumber(d.failed_count)}</div></div>
      <div class="info-item"><div class="info-label">Last Failed WAL</div><div class="info-value mono" style="font-size:.78rem">${esc(d.last_failed_wal || '-')}</div></div>
      <div class="info-item"><div class="info-label">Last Failed At</div><div class="info-value">${fmtDate(d.last_failed_time)}</div></div>
    </div>`;
  } catch {}
}

// ── Replication Slots ────────────────────────────────────────────────
async function renderReplicationSlots() {
  try {
    const rows = await api('/api/replication-slots');
    if (rows.length === 0) { $('#repl-slots-body').innerHTML = '<p class="empty-msg">No replication slots configured</p>'; return; }
    $('#repl-slots-body').innerHTML = `<table>
      <thead><tr><th>Slot</th><th>Type</th><th>Plugin</th><th>Active</th><th>WAL Status</th><th class="num">XMin Age</th><th>Restart LSN</th><th>Confirmed Flush</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td class="mono">${esc(r.slot_name)}</td><td>${esc(r.slot_type)}</td>
        <td>${esc(r.plugin || '-')}</td>
        <td class="${r.active ? 'state-active' : 'state-waiting'}">${r.active ? 'Yes' : 'INACTIVE'}</td>
        <td>${esc(r.wal_status || '-')}</td>
        <td class="num mono ${parseInt(r.xmin_age) > 1000000 ? 'state-idle-tx' : ''}">${fmtNumber(r.xmin_age)}</td>
        <td class="mono">${esc(r.restart_lsn || '-')}</td>
        <td class="mono">${esc(r.confirmed_flush_lsn || '-')}</td>
      </tr>`).join('')}</tbody></table>`;
  } catch {}
}

// ── Database Conflicts ───────────────────────────────────────────────
async function renderDbConflicts() {
  try {
    const rows = await api('/api/db-conflicts');
    const hasConflicts = rows.some(r =>
      parseInt(r.confl_tablespace) + parseInt(r.confl_lock) + parseInt(r.confl_snapshot) +
      parseInt(r.confl_bufferpin) + parseInt(r.confl_deadlock) > 0);
    if (!hasConflicts) { $('#db-conflicts-body').innerHTML = '<p class="empty-msg">No conflicts recorded</p>'; return; }
    $('#db-conflicts-body').innerHTML = `<table>
      <thead><tr><th>Database</th><th class="num">Tablespace</th><th class="num">Lock</th><th class="num">Snapshot</th><th class="num">Bufferpin</th><th class="num">Deadlock</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td><strong>${esc(r.database)}</strong></td>
        <td class="num mono">${fmtNumber(r.confl_tablespace)}</td>
        <td class="num mono">${fmtNumber(r.confl_lock)}</td>
        <td class="num mono">${fmtNumber(r.confl_snapshot)}</td>
        <td class="num mono">${fmtNumber(r.confl_bufferpin)}</td>
        <td class="num mono">${fmtNumber(r.confl_deadlock)}</td>
      </tr>`).join('')}</tbody></table>`;
  } catch {}
}

// ── WAL & Checkpoint Stats ───────────────────────────────────────────
async function renderWalCheckpoint() {
  try {
    const data = await api('/api/wal-checkpoint');
    const cp = data.checkpointer;
    const bg = data.bgwriter;
    const totalCp = parseInt(cp.checkpoints_timed || 0) + parseInt(cp.checkpoints_req || 0);
    const reqPct = totalCp > 0 ? ((parseInt(cp.checkpoints_req) / totalCp) * 100).toFixed(1) : '0';
    const reqClass = parseFloat(reqPct) > 50 ? 'state-waiting' : parseFloat(reqPct) > 20 ? 'state-idle-tx' : '';
    $('#wal-checkpoint-body').innerHTML = `<div class="info-grid">
      <div class="info-item"><div class="info-label">Checkpoints Timed</div><div class="info-value">${fmtNumber(cp.checkpoints_timed)}</div></div>
      <div class="info-item"><div class="info-label">Checkpoints Requested</div><div class="info-value ${reqClass}">${fmtNumber(cp.checkpoints_req)} (${reqPct}%)</div></div>
      <div class="info-item"><div class="info-label">CP Write Time</div><div class="info-value">${fmtNumber(Math.round(parseFloat(cp.checkpoint_write_time || 0) / 1000))}s</div></div>
      <div class="info-item"><div class="info-label">CP Sync Time</div><div class="info-value">${fmtNumber(Math.round(parseFloat(cp.checkpoint_sync_time || 0) / 1000))}s</div></div>
      <div class="info-item"><div class="info-label">Buffers Checkpoint</div><div class="info-value">${fmtNumber(cp.buffers_checkpoint)}</div></div>
      <div class="info-item"><div class="info-label">Buffers Clean (BG)</div><div class="info-value">${fmtNumber(bg.buffers_clean)}</div></div>
      <div class="info-item"><div class="info-label">Buffers Backend</div><div class="info-value ${parseInt(bg.buffers_backend) > 0 ? 'state-idle-tx' : ''}">${fmtNumber(bg.buffers_backend || '-')}</div></div>
      <div class="info-item"><div class="info-label">Max Written Clean</div><div class="info-value ${parseInt(bg.maxwritten_clean) > 0 ? 'state-idle-tx' : ''}">${fmtNumber(bg.maxwritten_clean)}</div></div>
      <div class="info-item"><div class="info-label">Buffers Alloc</div><div class="info-value">${fmtNumber(bg.buffers_alloc)}</div></div>
      <div class="info-item"><div class="info-label">Stats Reset</div><div class="info-value" style="font-size:.78rem">${fmtDate(cp.stats_reset)}</div></div>
    </div>`;
  } catch {}
}

// ── Buffer Cache ─────────────────────────────────────────────────────
async function renderBufferCache() {
  try {
    const data = await dbApi('/api/buffer-cache');
    if (!data.available) {
      $('#buffer-cache-body').innerHTML = '<p class="empty-msg">pg_buffercache extension is not installed. Run <code>CREATE EXTENSION pg_buffercache;</code> to enable.</p>';
      return;
    }
    if (data.rows.length === 0) { $('#buffer-cache-body').innerHTML = '<p class="empty-msg">Buffer cache is empty</p>'; return; }
    const maxPct = Math.max(...data.rows.map(r => parseFloat(r.pct_of_cache || 0)), 1);
    $('#buffer-cache-body').innerHTML = `<table>
      <thead><tr><th>Relation</th><th>Type</th><th class="num">Buffered</th><th class="num">Buffers</th><th class="num">% of Cache</th><th style="width:120px">Visual</th><th class="num">% Popular</th></tr></thead>
      <tbody>${data.rows.map(r => `<tr>
        <td class="mono">${esc(r.relation)}</td><td>${esc(r.type)}</td>
        <td class="num mono">${esc(r.buffered_size)}</td>
        <td class="num mono">${fmtNumber(r.buffers)}</td>
        <td class="num mono">${r.pct_of_cache}%</td>
        <td><div class="bar-track"><div class="bar-fill" style="width:${(parseFloat(r.pct_of_cache)/maxPct*100).toFixed(1)}%"></div></div></td>
        <td class="num mono">${r.pct_popular}%</td>
      </tr>`).join('')}</tbody></table>`;
  } catch {}
}

// ── Configuration Tracking ───────────────────────────────────────────
async function renderConfig() {
  try {
    const data = await api('/api/config-tracking');
    const changeNote = data.changed ? '<div class="banner-warning" style="padding:8px 12px;margin-bottom:12px;border-radius:6px">Configuration has changed since last check!</div>' : '';
    if (data.settings.length === 0) { $('#config-body').innerHTML = '<p class="empty-msg">All settings are at default values</p>'; return; }
    $('#config-body').innerHTML = `${changeNote}<table>
      <thead><tr><th>Setting</th><th>Value</th><th>Unit</th><th>Source</th><th>Boot Value</th><th>Reset Value</th></tr></thead>
      <tbody>${data.settings.map(r => `<tr>
        <td class="mono">${esc(r.name)}</td>
        <td class="mono"><strong>${esc(r.setting)}</strong></td>
        <td>${esc(r.unit || '-')}</td>
        <td>${esc(r.source)}</td>
        <td class="mono" style="font-size:.72rem">${esc(r.boot_val)}</td>
        <td class="mono" style="font-size:.72rem">${esc(r.reset_val)}</td>
      </tr>`).join('')}</tbody></table>`;
  } catch {}
}

// ── Topology Diagram ──────────────────────────────────────────────────
let topoData = null;       // cached topology API response
let topoSelectedDb = null;  // name of selected database, or null for overview

async function renderTopology() {
  try {
    // If drilling down, fetch tables for that specific DB
    const dbParam = topoSelectedDb ? `?db=${encodeURIComponent(topoSelectedDb)}` : '';
    topoData = await api(`/api/topology${dbParam}`);
    renderTopologyView();
  } catch {}
}

function renderTopologyView() {
  if (!topoData) return;
  if (topoSelectedDb) {
    renderTopologyDrilldown();
  } else {
    renderTopologyOverview();
  }
}

function buildDbCard(db) {
  const issuesHtml = db.issues.length > 0 ? `<div class="topo-db-issues">
    ${db.issues.map(i => {
      const cls = i.includes('critical') || db.status === 'critical' ? 'critical' : 'warning';
      return `<div class="topo-db-issue ${cls}">${esc(i)}</div>`;
    }).join('')}
  </div>` : '';

  return `<div class="topo-db-node health-${db.status}" data-topo-db="${esc(db.name)}">
      <div class="topo-db-header">
        <span class="topo-health-dot ${db.status}"></span>
        <span class="topo-db-name">${esc(db.name)}</span>
        <button class="topo-db-queries-btn" data-topo-queries="${esc(db.name)}" title="View live queries">
          <svg viewBox="0 0 24 24"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/></svg>
          Queries
        </button>
      </div>
      <div class="topo-db-stats">
        <span class="topo-db-stat-label">Size</span><span class="topo-db-stat-value">${esc(db.size)}</span>
        <span class="topo-db-stat-label">Connections</span><span class="topo-db-stat-value">${fmtNumber(db.connections)}</span>
        <span class="topo-db-stat-label">Cache Hit</span><span class="topo-db-stat-value">${db.cache_hit_ratio}%</span>
        <span class="topo-db-stat-label">Rollback</span><span class="topo-db-stat-value">${db.rollback_pct}%</span>
      </div>
      <div class="topo-db-activity" data-activity-db="${esc(db.name)}">
        <div class="topo-db-activity-bar-wrap"><div class="topo-db-activity-bar"></div></div>
        <span class="topo-db-activity-label">--</span>
      </div>
      ${issuesHtml}
      <span class="topo-db-hint">Click card for tables</span>
    </div>`;
}

function buildStatusGroup(status, label, icon, dbs) {
  if (dbs.length === 0) return '';
  const collapsed = topoCollapsed[status] ? ' collapsed' : '';
  return `<div class="topo-status-group ${status}${collapsed}">
    <div class="topo-group-header" data-topo-toggle="${status}">
      <span class="topo-group-chevron">&#9660;</span>
      <span class="topo-group-dot ${status}"></span>
      <span class="topo-group-label">${icon} ${label}</span>
      <span class="topo-group-count">${dbs.length}</span>
    </div>
    <div class="topo-group-body">
      <div class="topo-db-grid">${dbs.map(buildDbCard).join('')}</div>
    </div>
  </div>`;
}

let topoCollapsed = { critical: false, warning: false, ok: false };

function renderTopologyOverview() {
  const data = topoData;
  const srv = data.server;

  const connPct = ((parseInt(srv.total_connections) / parseInt(srv.max_connections)) * 100).toFixed(1);
  const connStatus = parseFloat(connPct) > 90 ? 'critical' : parseFloat(connPct) > 70 ? 'warning' : 'ok';

  const critical = data.databases.filter(db => db.status === 'critical');
  const warning  = data.databases.filter(db => db.status === 'warning');
  const ok       = data.databases.filter(db => db.status === 'ok');
  const dbCount  = data.databases.length;

  const groupsHtml =
    buildStatusGroup('critical', 'Critical', '', critical) +
    buildStatusGroup('warning',  'Warning',  '', warning) +
    buildStatusGroup('ok',       'Healthy',  '', ok);

  $('#topology-body').innerHTML = `
    <div class="topo-legend">
      <div class="topo-legend-item"><span class="topo-legend-dot ok"></span> Healthy</div>
      <div class="topo-legend-item"><span class="topo-legend-dot warning"></span> Warning</div>
      <div class="topo-legend-item"><span class="topo-legend-dot critical"></span> Error / Critical</div>
    </div>
    <div class="topology-container">
      <div class="topo-server">
        <div class="topo-server-icon">
          <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 6H4V4h16v4zm0 4H4c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-4c0-1.1-.9-2-2-2zm0 6H4v-4h16v4zM6 7h2V5H6v2zm0 8h2v-2H6v2z"/></svg>
        </div>
        <span class="topo-server-name">PostgreSQL ${esc(srv.version)}</span>
        <span class="topo-server-meta">
          ${esc(srv.host || 'localhost')}:${esc(srv.port || '5432')}<br>
          Uptime: ${fmtDuration(srv.uptime)} &middot;
          Connections: <span class="${connStatus === 'ok' ? '' : 'state-' + (connStatus === 'warning' ? 'idle-tx' : 'waiting')}">${srv.total_connections}/${srv.max_connections} (${connPct}%)</span>
        </span>
      </div>
      <div class="topo-connector-main"></div>
      <div class="topo-db-count">${dbCount} Database${dbCount !== 1 ? 's' : ''}</div>
      <div class="topo-groups">${groupsHtml}</div>
    </div>`;
}

function renderTopologyDrilldown() {
  const data = topoData;
  const srv = data.server;
  const dbName = topoSelectedDb;
  const db = data.databases.find(d => d.name === dbName);
  if (!db) { topoSelectedDb = null; renderTopologyOverview(); return; }

  // Tables are always available now via dynamic pool
  const tables = data.tables;

  // Build the mini db node at top
  const miniDb = `
    <div style="display:flex;flex-direction:column;align-items:center">
      <div class="topo-server" style="min-width:200px;padding:12px 24px;border-color:${db.status === 'ok' ? 'var(--ok)' : db.status === 'warning' ? 'var(--warn)' : 'var(--crit)'}">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="topo-health-dot ${db.status}"></span>
          <span class="topo-server-name" style="font-size:.95rem">${esc(db.name)}</span>
        </div>
        <span class="topo-server-meta">
          ${esc(db.size)} &middot; ${fmtNumber(db.connections)} conn &middot; ${db.cache_hit_ratio}% cache hit
        </span>
      </div>
    </div>`;

  let tableContent;
  if (tables.length === 0) {
    tableContent = '<p class="empty-msg">No user tables in this database</p>';
  } else {
    const tableNodes = tables.map(t => {
      const issuesHtml = t.issues.length > 0
        ? `<div class="topo-tbl-issues">${t.issues.map(i => {
            const cls = t.status === 'critical' ? 'critical' : 'warning';
            return `<div class="topo-tbl-issue ${cls}">${esc(i)}</div>`;
          }).join('')}</div>` : '';

      return `<div class="topo-tbl-node health-${t.status}">
        <div class="topo-tbl-header">
          <span class="topo-tbl-dot ${t.status}"></span>
          <span class="topo-tbl-name">${esc(t.table)}</span>
          <span class="topo-tbl-schema">${esc(t.schema)}</span>
        </div>
        <div class="topo-tbl-stats">
          <span class="topo-tbl-stat-label">Size</span><span class="topo-tbl-stat-value">${esc(t.total_size)}</span>
          <span class="topo-tbl-stat-label">Live rows</span><span class="topo-tbl-stat-value">${fmtNumber(t.live_rows)}</span>
          <span class="topo-tbl-stat-label">Dead rows</span><span class="topo-tbl-stat-value">${fmtNumber(t.dead_rows)}</span>
          <span class="topo-tbl-stat-label">Dead %</span><span class="topo-tbl-stat-value ${parseFloat(t.dead_row_pct) > 20 ? 'state-waiting' : ''}">${t.dead_row_pct}%</span>
          <span class="topo-tbl-stat-label">Seq scans</span><span class="topo-tbl-stat-value">${fmtNumber(t.seq_scan)}</span>
          <span class="topo-tbl-stat-label">Idx scans</span><span class="topo-tbl-stat-value">${fmtNumber(t.idx_scan)}</span>
        </div>
        ${issuesHtml}
      </div>`;
    }).join('');

    tableContent = `
      <div class="topo-drill-connector">
        <div class="topo-drill-connector-line"></div>
        <span class="topo-drill-connector-label">${tables.length} table${tables.length !== 1 ? 's' : ''}</span>
        <div class="topo-drill-connector-line"></div>
      </div>
      <div class="topo-table-grid">${tableNodes}</div>`;
  }

  $('#topology-body').innerHTML = `
    <div class="topo-legend">
      <div class="topo-legend-item"><span class="topo-legend-dot ok"></span> Healthy</div>
      <div class="topo-legend-item"><span class="topo-legend-dot warning"></span> Warning</div>
      <div class="topo-legend-item"><span class="topo-legend-dot critical"></span> Error / Critical</div>
    </div>
    <div class="topo-drilldown">
      <div class="topo-drill-header">
        <button class="topo-drill-back" data-topo-back>
          <svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          Back to overview
        </button>
        <div class="topo-drill-title">
          <span class="topo-health-dot ${db.status}"></span>
          <span class="topo-drill-dbname">${esc(db.name)}</span>
          <span class="topo-drill-subtitle">${esc(db.size)} &middot; ${db.cache_hit_ratio}% cache hit &middot; ${fmtNumber(db.connections)} connections</span>
        </div>
      </div>
      ${miniDb}
      ${tableContent}
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════
// Refresh orchestration
// ═══════════════════════════════════════════════════════════════════
async function refreshAll() {
  const ts = new Date().toLocaleTimeString();
  $('#last-refresh').textContent = `Updated ${ts}`;

  renderHealth();

  switch (activeTab) {
    case 'dashboard':
      renderServerInfo();
      renderSparklines();
      renderXidWraparound();
      renderRecommendations();
      renderLongQueries();
      renderBlocking();
      break;
    case 'databases':
      renderDatabases();
      break;
    case 'queries':
      renderQueries();
      break;
    case 'locks':
      renderLocks();
      break;
    case 'connections':
      renderConnections();
      break;
    case 'tables':
      renderTables();
      renderBloat();
      renderSequences();
      renderTableIO();
      break;
    case 'indexes':
      renderInvalidIndexes();
      renderIndexes();
      renderDuplicateIndexes();
      break;
    case 'slow':
      renderSlowQueries();
      renderFunctionStats();
      break;
    case 'replication':
      renderArchiver();
      renderReplication();
      renderReplicationSlots();
      renderDbConflicts();
      break;
    case 'internals':
      renderWalCheckpoint();
      renderBufferCache();
      renderConfig();
      break;
    case 'topology':
      renderTopology();
      startActivityPolling();
      break;
  }
}

function setupAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const secs = parseInt($('#refresh-interval').value);
  if (secs > 0) refreshTimer = setInterval(refreshAll, secs * 1000);
}

$('#refresh-interval').addEventListener('change', setupAutoRefresh);
$('#btn-refresh').addEventListener('click', refreshAll);
$('#show-idle').addEventListener('change', renderQueries);

// Topology: click handlers for db nodes, back button, group toggle, and queries button
document.addEventListener('click', async e => {
  // Queries button — must be checked before data-topo-db since it's inside the card
  const queriesBtn = e.target.closest('[data-topo-queries]');
  if (queriesBtn) {
    e.stopPropagation();
    openQueryPanel(queriesBtn.dataset.topoQueries);
    return;
  }
  const toggle = e.target.closest('[data-topo-toggle]');
  if (toggle) {
    const status = toggle.dataset.topoToggle;
    topoCollapsed[status] = !topoCollapsed[status];
    const group = toggle.closest('.topo-status-group');
    if (group) group.classList.toggle('collapsed', topoCollapsed[status]);
    return;
  }
  const dbNode = e.target.closest('[data-topo-db]');
  if (dbNode) {
    topoSelectedDb = dbNode.dataset.topoDb;
    await renderTopology();
    return;
  }
  const backBtn = e.target.closest('[data-topo-back]');
  if (backBtn) {
    topoSelectedDb = null;
    await renderTopology();
    return;
  }
});

// ── Topology Activity Polling ─────────────────────────────────────────
let activityTimer = null;

async function updateTopologyActivity() {
  try {
    const data = await api('/api/topology-activity');
    const dbs = data.databases || {};
    document.querySelectorAll('[data-activity-db]').forEach(el => {
      const name = el.dataset.activityDb;
      const info = dbs[name] || { active: 0, recent: 0 };
      const bar = el.querySelector('.topo-db-activity-bar');
      const label = el.querySelector('.topo-db-activity-label');
      const card = el.closest('.topo-db-node');

      // Activity bar — scale: 0 queries = 0%, 10+ = 100%
      const pct = Math.min((info.active + info.recent) / 10 * 100, 100);
      bar.style.width = pct + '%';
      bar.className = 'topo-db-activity-bar' + (info.active > 5 ? ' busy' : '');

      // Label
      const parts = [];
      if (info.active > 0) parts.push(`${info.active} active`);
      parts.push(`${info.recent} recent`);
      label.textContent = parts.join(' / ');

      // Glow animation on card
      card.classList.remove('activity-active', 'activity-busy');
      if (info.active > 5) card.classList.add('activity-busy');
      else if (info.active > 0) card.classList.add('activity-active');
    });
  } catch {}
}

function startActivityPolling() {
  stopActivityPolling();
  updateTopologyActivity();
  activityTimer = setInterval(updateTopologyActivity, 3000);
}

function stopActivityPolling() {
  if (activityTimer) { clearInterval(activityTimer); activityTimer = null; }
}

// ── Query Side Panel ──────────────────────────────────────────────────
let queryPanelDb = null;
let queryPanelTimer = null;
let queryPanelTab = 'running';

function openQueryPanel(dbName) {
  queryPanelDb = dbName;
  queryPanelTab = 'running';
  const panel = $('#query-panel');
  panel.hidden = false;
  // Trigger reflow before adding .open for transition
  panel.offsetHeight;
  panel.classList.add('open');
  $('#query-panel-title').textContent = `Queries: ${dbName}`;
  $('#query-panel-body').innerHTML = '<div class="qp-empty">Loading...</div>';
  // Reset tab state
  $$('.query-panel-tab').forEach(t => t.classList.toggle('active', t.dataset.qptab === 'running'));
  fetchQueryPanel();
  queryPanelTimer = setInterval(fetchQueryPanel, 3000);
}

function closeQueryPanel() {
  const panel = $('#query-panel');
  panel.classList.remove('open');
  setTimeout(() => { panel.hidden = true; }, 260);
  queryPanelDb = null;
  if (queryPanelTimer) { clearInterval(queryPanelTimer); queryPanelTimer = null; }
}

async function fetchQueryPanel() {
  if (!queryPanelDb) return;
  try {
    const data = await api(`/api/db-queries/${encodeURIComponent(queryPanelDb)}`);
    $('#qp-running-count').textContent = data.running.length;
    $('#qp-recent-count').textContent = data.recent.length;
    renderQueryPanel(data);
    $('#qp-last-update').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch {}
}

function renderQueryPanel(data) {
  const items = queryPanelTab === 'running' ? data.running : data.recent;
  if (items.length === 0) {
    $('#query-panel-body').innerHTML = `<div class="qp-empty">No ${queryPanelTab === 'running' ? 'running queries' : 'queries in the last 5 minutes'}</div>`;
    return;
  }

  const html = items.map((q, i) => {
    const isRunning = queryPanelTab === 'running';
    let duration;
    if (isRunning) {
      duration = `<span class="qp-duration active">${parseFloat(q.duration_secs).toFixed(1)}s</span>`;
    } else {
      const ms = q.duration_ms;
      const dur = ms != null ? (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`) : '?';
      duration = `<span class="qp-duration completed">${dur}</span>`;
    }

    const cancelBtn = isRunning
      ? `<div class="qp-actions"><button class="btn btn-sm btn-warn" data-action="cancel" data-pid="${q.pid}">Cancel</button></div>`
      : '';

    return `<div class="qp-card ${isRunning ? 'qp-running' : ''}">
      <div class="qp-meta">
        <span class="qp-meta-item"><span class="qp-pid">PID ${q.pid}</span></span>
        <span class="qp-meta-item">${esc(q.usename)}</span>
        ${duration}
        ${q.wait_event ? `<span class="qp-meta-item" style="color:var(--warn)">wait: ${esc(q.wait_event)}</span>` : ''}
        ${q.application_name ? `<span class="qp-meta-item">${esc(q.application_name)}</span>` : ''}
      </div>
      <div class="qp-sql" data-qp-sql="${i}">${esc(q.query)}</div>
      ${cancelBtn}
    </div>`;
  }).join('');

  $('#query-panel-body').innerHTML = html;
}

// Panel tab switching
document.addEventListener('click', e => {
  const tab = e.target.closest('[data-qptab]');
  if (tab) {
    queryPanelTab = tab.dataset.qptab;
    $$('.query-panel-tab').forEach(t => t.classList.toggle('active', t.dataset.qptab === queryPanelTab));
    fetchQueryPanel();
    return;
  }
  // Close panel
  if (e.target.closest('[data-query-panel-close]')) { closeQueryPanel(); return; }
  // Expand/collapse SQL
  const sql = e.target.closest('.qp-sql');
  if (sql) { sql.classList.toggle('expanded'); return; }
});

// ── Hook into tab switching to manage activity polling & query panel ──
$$('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab !== 'topology') {
      closeQueryPanel();
      stopActivityPolling();
    }
  });
});

// ── Startup ──────────────────────────────────────────────────────────
(async () => {
  await loadDatabaseList();
  refreshAll();
  setupAutoRefresh();
})();
