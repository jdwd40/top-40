'use strict';

/* Top 40 admin page. Session cookie is HttpOnly; nothing sensitive in code. */

const $ = (s) => document.querySelector(s);
const fmt = new Intl.NumberFormat('en-GB');
const fmtDay = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });

function announce(msg) { $('#live').textContent = msg; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.endsWith('/login')) { showLogin(); throw new Error('session expired'); }
  return { status: res.status, data };
}

function showLogin() { $('#login-view').hidden = false; $('#admin-view').hidden = true; }
function showAdmin() { $('#login-view').hidden = true; $('#admin-view').hidden = false; }

// ---- login / logout ----
$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const status = $('#login-status');
  status.className = 'status';
  const { status: code, data } = await api('POST', '/api/admin/login', {
    username: ev.target.username.value, password: ev.target.password.value,
  });
  if (code === 200) {
    status.className = 'status ok';
    status.textContent = 'Signed in.';
    showAdmin();
    loadReleases(); loadSubmissions(); loadCorrections();
    announce('Signed in.');
  } else {
    status.className = 'status err';
    status.textContent = data.error || `Sign-in failed (HTTP ${code}).`;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/admin/logout', {});
  showLogin();
  announce('Signed out.');
});

// ---- tabs ----
document.querySelectorAll('[data-av]').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('[data-av]').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    for (const v of ['releases', 'submissions', 'preview', 'corrections']) {
      $(`#av-${v}`).hidden = v !== t.dataset.av;
    }
  });
});

// ---- releases ----
async function loadReleases() {
  const { status, data } = await api('GET', '/api/admin/releases');
  if (status !== 200) { $('#releases-list').innerHTML = '<p class="status err">Failed to load releases.</p>'; return; }
  $('#releases-list').innerHTML = data.releases.map((r) => `
    <details class="rel-row">
      <summary><span class="mono">${esc(r.releaseId)}</span> ${esc(r.title)} — ${esc(r.artist)}
        <span class="rel-meta">· ${r.kind}${r.retired ? ' · retired' : ''} · ${fmt.format(r.lifetimeSales)} total · peak ${r.peak ?? '—'}</span></summary>
      <details class="editarea">
        <summary>Edit metadata / mojo</summary>
        <form class="edit-form" data-id="${esc(r.releaseId)}" novalidate>
          <label>Title <input type="text" name="title" value="${esc(r.title)}" maxlength="80" required></label>
          <label>Artist <input type="text" name="artist" value="${esc(r.artist)}" maxlength="80" required></label>
          <fieldset style="border:1px solid var(--line);border-radius:var(--radius);margin:0.8rem 0;padding:0.6rem">
            <legend class="hint">Mojo (0–1; shapes future weekly sales only)</legend>
            <div class="mojo-grid">${['potential', 'debut', 'climb', 'plateau', 'decline', 'variation'].map((k) => `
              <label>${k}<input type="number" name="${k}" min="0" max="1" step="0.01" value="${r.mojo[k]}"></label>`).join('')}
            </div>
          </fieldset>
          <label>Reason (recorded in the correction log) <input type="text" name="reason" maxlength="300" required></label>
          <div style="margin-top:0.6rem"><button class="btn small" type="submit">Save changes</button></div>
          <div class="status" role="status" aria-live="polite"></div>
        </form>
      </details>
      <details class="editarea">
        <summary>Delete release</summary>
        <form class="delete-form" data-id="${esc(r.releaseId)}" novalidate>
          <label>Reason <input type="text" name="reason" maxlength="300" required></label>
          <div style="margin-top:0.6rem"><button class="btn danger small" type="submit">Delete permanently</button></div>
          <div class="status" role="status" aria-live="polite"></div>
        </form>
      </details>
    </details>`).join('');

  $('#releases-list').querySelectorAll('.edit-form').forEach((f) => {
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const box = f.querySelector('.status');
      box.className = 'status';
      const mojo = {};
      for (const k of ['potential', 'debut', 'climb', 'plateau', 'decline', 'variation']) {
        const v = Number(f[k].value);
        if (!Number.isFinite(v) || v < 0 || v > 1) { box.className = 'status err'; box.textContent = `Mojo ${k} must be between 0 and 1.`; return; }
        mojo[k] = v;
      }
      const { status, data } = await api('PATCH', `/api/admin/release/${encodeURIComponent(f.dataset.id)}`, {
        title: f.title.value.trim(), artist: f.artist.value.trim(), mojo, reason: f.reason.value,
      });
      box.className = status === 200 ? 'status ok' : 'status err';
      box.textContent = status === 200 ? 'Saved. Correction logged.' : (data.error || `HTTP ${status}`);
      if (status === 200) loadCorrections();
    });
  });
  $('#releases-list').querySelectorAll('.delete-form').forEach((f) => {
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const box = f.querySelector('.status');
      box.className = 'status';
      const { status, data } = await api('POST', `/api/admin/release/${encodeURIComponent(f.dataset.id)}/delete`, { reason: f.reason.value });
      box.className = status === 200 ? 'status ok' : 'status err';
      box.textContent = status === 200 ? 'Release deleted. Correction logged.' : (data.error || `HTTP ${status}`);
      if (status === 200) { loadReleases(); loadCorrections(); }
    });
  });
}

// ---- submissions ----
async function loadSubmissions() {
  const { status, data } = await api('GET', '/api/admin/submissions');
  if (status !== 200) { $('#submissions-list').innerHTML = '<p class="status err">Failed to load submissions.</p>'; return; }
  if (!data.submissions.length) { $('#submissions-list').innerHTML = '<p class="hint">No submissions yet.</p>'; return; }
  $('#submissions-list').innerHTML = `<table class="data"><thead><tr><th scope="col">#</th><th scope="col">Title</th><th scope="col">Artist</th><th scope="col">Status</th><th scope="col">Submitted</th><th scope="col"></th></tr></thead><tbody>${
    data.submissions.map((s) => `<tr><td>${s.id}</td><td>${esc(s.title)}</td><td>${esc(s.artist)}</td><td>${esc(s.status)}</td><td>${new Date(s.submittedAt).toLocaleString('en-GB')}</td><td>${
      s.status === 'pending' ? `<button class="btn danger small" data-del-sub="${s.id}" type="button">Delete</button>` : ''
    }</td></tr>`).join('')
  }</tbody></table><div class="status" id="sub-status" role="status" aria-live="polite"></div>`;
  $('#submissions-list').querySelectorAll('[data-del-sub]').forEach((b) => {
    b.addEventListener('click', async () => {
      const reason = window.prompt('Reason for deleting this submission (recorded in the log):');
      if (!reason || reason.trim().length < 3) return;
      const { status, data } = await api('DELETE', `/api/admin/submission/${b.dataset.delSub}`, { reason });
      const box = $('#sub-status');
      box.className = status === 200 ? 'status ok' : 'status err';
      box.textContent = status === 200 ? 'Submission deleted.' : (data.error || `HTTP ${status}`);
      loadSubmissions(); loadCorrections();
    });
  });
}

// ---- corrections ----
async function loadCorrections() {
  const { status, data } = await api('GET', '/api/admin/corrections');
  if (status !== 200) { $('#corrections-list').innerHTML = '<p class="status err">Failed to load the log.</p>'; return; }
  if (!data.corrections.length) { $('#corrections-list').innerHTML = '<p class="hint">No corrections recorded.</p>'; return; }
  $('#corrections-list').innerHTML = `<table class="data"><thead><tr><th scope="col">When</th><th scope="col">Admin</th><th scope="col">Type</th><th scope="col">Ref</th><th scope="col">Reason</th></tr></thead><tbody>${
    data.corrections.map((c) => `<tr><td>${new Date(c.at).toLocaleString('en-GB')}</td><td>${esc(c.admin)}</td><td>${esc(c.type)}</td><td class="mono">${esc(c.refId)}</td><td>${esc(c.reason)}</td></tr>`).join('')
  }</tbody></table>`;
}

// ---- preview / generate ----
$('#run-preview').addEventListener('click', async () => {
  const host = $('#preview-body');
  host.innerHTML = '<p class="hint">Building preview…</p>';
  const { status, data } = await api('POST', '/api/admin/preview', {});
  if (status !== 200) { host.innerHTML = `<p class="status err">${esc(data.error || `HTTP ${status}`)}</p>`; return; }
  const s = data.snapshot;
  host.innerHTML = `<p class="hint">Hypothetical chart for <strong>${fmtDay.format(new Date(data.day + 'T12:00:00Z'))}</strong> (preview — nothing published, no sales counted).</p>
    <table class="data"><thead><tr><th scope="col">#</th><th scope="col">Title</th><th scope="col">Artist</th><th scope="col">Weekly sales</th></tr></thead><tbody>${
    s.entries.map((e) => `<tr><td>${e.rank}</td><td>${esc(e.title)}</td><td>${esc(e.artist)}</td><td>${fmt.format(e.weeklySales)}</td></tr>`).join('')
  }</tbody></table>`;
  announce(`Preview for ${data.day} built.`);
});

$('#run-generate').addEventListener('click', async () => {
  const box = $('#generate-status');
  box.className = 'status';
  const { status, data } = await api('POST', '/api/admin/generate', {});
  box.className = status === 200 ? 'status ok' : 'status err';
  box.textContent = status === 200 ? `Generated ${data.generated} new chart day(s).` : (data.error || `HTTP ${status}`);
  if (status === 200) { loadReleases(); loadSubmissions(); }
});

// boot: a silent probe decides which view to show
(async () => {
  const { status } = await api('GET', '/api/admin/state');
  if (status === 200) { showAdmin(); loadReleases(); loadSubmissions(); loadCorrections(); }
  else showLogin();
})();
