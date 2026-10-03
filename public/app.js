'use strict';

/* Tripper City Top 40 — public page logic. No dependencies. */

const $ = (sel) => document.querySelector(sel);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmt = new Intl.NumberFormat('en-GB');
const fmtDay = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short', timeZone: 'Europe/London' });
const fmtDayShort = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short', timeZone: 'Europe/London' });

const fmtDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });
const fmtTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short', timeZone: 'Europe/London' });

function announce(msg) { $('#live').textContent = msg; }

async function getJson(url) {
  const res = await fetch(url.replace(/^\//, ''), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function movementHtml(e) {
  if (e.lastHourRank === null || e.lastHourRank === undefined) return '<span class="badge new">NEW</span>';
  if (e.reentry) return '<span class="badge reentry">RE-ENTRY</span>';
  const d = e.lastHourRank - e.rank;
  if (d > 0) return `<span class="mv up" title="up ${d}">&#9650; ${d}</span>`;
  if (d < 0) return `<span class="mv down" title="down ${-d}">&#9660; ${-d}</span>`;
  return '<span class="mv same" title="no change">&#8212;</span>';
}

function chartHtml(snap) {
  const items = snap.entries.map((e) => `
    <li data-rank="${e.rank}">
      <span class="pos" aria-label="position ${e.rank}">${e.rank}</span>
      <span class="track">
        <button type="button" class="songlink" data-release="${esc(e.releaseId)}">
          <span class="title">${esc(e.title)}${movementHtml(e)}</span>
          <span class="artist">${esc(e.artist)}</span>
        </button>
      </span>
      <span class="stats">
        <span class="sales">${fmt.format(e.hourlySales)} sold this hour</span>
        <span class="sub">${e.cumulativeSales != null ? fmt.format(e.cumulativeSales) + ' total · ' : ''}peak ${e.peak} · ${e.hoursOnChart} hour${e.hoursOnChart === 1 ? '' : 's'} on chart</span>
      </span>
    </li>`).join('');
  return `<p class="hint" style="margin-top:0">Chart for <strong>${fmtDay.format(new Date(snap.hour))}</strong></p>
    <ol class="chartlist">${items}</ol>`;
}

// ---- reveal animation (40 -> 1), skippable, once per chart hour per browser ----
let revealTimer = null;
function revealEntries(listEl, day) {
  clearInterval(revealTimer);
  const items = [...listEl.querySelectorAll('li')];
  if (reducedMotion || !items.length) {
    items.forEach((li) => li.classList.add('shown'));
    return;
  }
  const seenKey = `top40.seen.${day}`;
  if (localStorage.getItem(seenKey)) {
    items.forEach((li) => li.classList.add('shown'));
    return;
  }
  localStorage.setItem(seenKey, '1');
  $('#reveal-controls').hidden = false;
  let i = items.length - 1; // rank 40 first
  revealTimer = setInterval(() => {
    if (i < 0) {
      clearInterval(revealTimer);
      $('#reveal-controls').hidden = true;
      return;
    }
    items[i].classList.add('shown');
    i -= 1;
  }, 60);
  $('#skip-reveal').onclick = () => {
    clearInterval(revealTimer);
    items.forEach((li) => li.classList.add('shown'));
    $('#reveal-controls').hidden = true;
  };
}

// ---- countdown ----
let boundaryMs = null;
let boundaryReloading = false;
function tickCountdown() {
  const el = $('#countdown');
  if (boundaryMs === null) { el.textContent = '—'; return; }
  const ms = Math.max(0, boundaryMs - Date.now());
  if (ms === 0 && !boundaryReloading) {
    // Boundary crossed: refresh state + chart once so an open tab reveals the
    // new chart. loadCurrent() also resets boundaryMs from /api/state.
    boundaryReloading = true;
    loadCurrent().finally(() => { boundaryReloading = false; });
  }
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = String(Math.floor((s % 86400) / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  el.textContent = d > 0 ? `${d}d ${h}:${m}:${sec}` : `${h}:${m}:${sec}`;
}

async function loadCurrent() {
  try {
    const [state, chartRes] = await Promise.all([getJson('/api/state'), getJson('/api/chart/current')]);
    boundaryMs = new Date(state.nextBoundary).getTime();
    tickCountdown();
    const snap = chartRes.chart;
    if (!snap || !snap.entries.length) {
      $('#chartlist').innerHTML = '';
      announce('No chart has been published yet.');
      return;
    }
    $('#chartdate').textContent = fmtDayShort.format(new Date(snap.hour));
    const list = $('#chartlist');
    list.innerHTML = chartHtml(snap);
    $('#chart-offline').hidden = true;
    revealEntries(list, snap.hour);
    announce(`Chart for ${fmtDayShort.format(new Date(snap.hour))} loaded, ${snap.entries.length} entries.`);
  } catch {
    $('#chartlist').innerHTML = '';
    $('#chart-offline').hidden = false;
    announce('Chart failed to load.');
  }
}

async function loadHistory() {
  try {
    const { snapshots } = await getJson('/api/chart/history');
    const list = $('#daylist');
    if (!snapshots.length) {
      list.innerHTML = '<li class="hint">No past charts yet.</li>';
      $('#history-chart').innerHTML = '';
      return;
    }
    let previousDate = null;
    list.innerHTML = snapshots.map((s) => {
      const date = fmtDate.format(new Date(s.hour));
      const heading = date !== previousDate ? `<li class="history-date">${esc(date)}</li>` : '';
      previousDate = date;
      return `${heading}<li><button type="button" class="btn small" data-day="${esc(s.hour)}" aria-label="${esc(fmtDayShort.format(new Date(s.hour)))}">${fmtTime.format(new Date(s.hour))}</button></li>`;
    }).join('');
    $('#history-offline').hidden = true;
    list.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        const snap = snapshots.find((s) => s.hour === b.dataset.day);
        const host = $('#history-chart');
        host.innerHTML = chartHtml(snap);
        host.querySelectorAll('.chartlist > li').forEach((li) => li.classList.add('shown'));
        bindSongLinks(host);
        announce(`Showing chart for ${fmtDayShort.format(new Date(snap.hour))}.`);
      });
    });
  } catch {
    $('#history-offline').hidden = false;
  }
}

async function loadAllTime() {
  try {
    const { allTime } = await getJson('/api/chart/all-time');
    if (!allTime.length) {
      $('#alltime-body').innerHTML = '<p class="hint">Nothing here yet.</p>';
      return;
    }
    $('#alltime-body').innerHTML = `<table class="data"><thead><tr><th scope="col">#</th><th scope="col">Title</th><th scope="col">Artist</th><th scope="col">Total sales</th><th scope="col">Peak</th><th scope="col">Hours on chart</th></tr></thead><tbody>${
      allTime.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.title)}</td><td>${esc(r.artist)}</td><td>${fmt.format(r.lifetimeSales)}</td><td>${r.peak ?? '—'}</td><td>${r.hoursOnChart}</td></tr>`).join('')
    }</tbody></table>`;
    $('#alltime-offline').hidden = true;
  } catch {
    $('#alltime-offline').hidden = false;
  }
}

async function loadGenres() {
  try {
    const { genres } = await getJson('/api/chart/genres');
    const cards = Object.entries(genres).map(([genre, rows]) => `<section class="panel"><h3>${esc(genre)}</h3>${rows.length ? `<table class="data"><thead><tr><th scope="col">#</th><th scope="col">Song</th><th scope="col">Band</th><th scope="col">Peak</th></tr></thead><tbody>${rows.slice(0, 10).map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.title)}<br><span class="hint">${fmt.format(r.hourlySales)} this hour</span></td><td>${esc(r.bandName || r.artist)}</td><td>${r.peak ?? '—'}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">No chart entries yet.</p>'}</section>`).join('');
    $('#genres-body').innerHTML = cards;
    $('#genres-offline').hidden = true;
    announce('Genre Top 10s loaded.');
  } catch {
    $('#genres-offline').hidden = false;
  }
}

async function loadBands() {
  try {
    const { bands } = await getJson('/api/chart/bands');
    $('#bands-body').innerHTML = bands.length ? `<table class="data"><thead><tr><th scope="col">#</th><th scope="col">Band</th><th scope="col">Earnings</th><th scope="col">Sales</th><th scope="col">Releases</th><th scope="col">Best peak</th><th scope="col">Hours on chart</th></tr></thead><tbody>${bands.map((b, i) => `<tr><td>${i + 1}</td><td>${esc(b.bandName)}${b.superBand ? ' <span class="badge">SUPER BAND</span>' : ''}<br><span class="hint">${esc(b.genres.join(', '))}</span></td><td>£${Number(b.earnings).toFixed(2)}</td><td>${fmt.format(b.lifetimeSales)}</td><td>${b.releaseCount}</td><td>${b.bestPeak ?? '—'}</td><td>${b.totalHours}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">No band earnings yet.</p>';
    $('#bands-offline').hidden = true;
    announce('Band leaderboard loaded.');
  } catch {
    $('#bands-offline').hidden = false;
  }
}

async function showSong(releaseId) {
  try {
    const d = await getJson(`/api/release/${encodeURIComponent(releaseId)}/history`);
    switchView(null);
    $('#view-song').hidden = false;
    $('#song-heading').textContent = `${d.title} — ${d.artist}`;
    const genreHtml = `<p class="hint">Genre: ${esc(d.genre)}</p>`;
    if (!d.history.length) {
      $('#song-body').innerHTML = `${genreHtml}<p class="hint">This release has not appeared on a published chart.</p>`;
      return;
    }
    $('#song-body').innerHTML = `${genreHtml}<table class="data"><thead><tr><th scope="col">Chart time (London)</th><th scope="col">Rank</th><th scope="col">Hourly sales</th><th scope="col">Cumulative</th><th scope="col">Hours on chart</th></tr></thead><tbody>${
      d.history.map((h) => `<tr><td>${fmtDayShort.format(new Date(h.hour))}</td><td>${h.rank}</td><td>${fmt.format(h.hourlySales)}</td><td>${h.cumulativeSales != null ? fmt.format(h.cumulativeSales) : '—'}</td><td>${h.hoursOnChart}</td></tr>`).join('')
    }</tbody></table>`;
    announce(`Chart history for ${d.title} by ${d.artist}.`);
  } catch {
    announce('Song history failed to load.');
  }
}

function bindSongLinks(root) {
  root.querySelectorAll('.songlink').forEach((b) => {
    b.addEventListener('click', () => showSong(b.dataset.release));
  });
}

// submit form
function initSubmit() {
  const form = $('#submit-form');
  const status = $('#submit-status');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    status.className = 'status';
    const title = form.title.value.trim();
    const artist = form.artist.value.trim();
    const genre = form.genre.value;
    if (!title || !artist || !genre) {
      status.className = 'status err';
      status.textContent = 'Title, artist, and genre are required.';
      return;
    }
    if (title.length > 80 || artist.length > 80) {
      status.className = 'status err';
      status.textContent = 'Title and artist must each be 80 characters or fewer.';
      return;
    }
    try {
      const res = await fetch('api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, artist, genre }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        status.className = 'status err';
        status.textContent = data.error || `Submission failed (HTTP ${res.status}).`;
        return;
      }
      status.className = 'status ok';
      status.textContent = `Submitted! "${title}" by ${artist} will debut on the chart for ${fmtDayShort.format(new Date(data.submission.expectedChartHour))}.`;
      form.reset();
      announce('Song submitted successfully.');
    } catch {
      status.className = 'status err';
      status.textContent = 'Could not reach the server. Check your connection and try again.';
    }
  });
}

// tabs
function switchView(name) {
  document.querySelectorAll('[role="tab"]').forEach((t) => {
    t.setAttribute('aria-selected', String(t.dataset.view === name));
  });
  for (const v of ['current', 'history', 'alltime', 'genres', 'bands', 'submit']) {
    $(`#view-${v}`).hidden = v !== name;
  }
  $('#view-song').hidden = true;
  if (name === 'history') loadHistory();
  if (name === 'alltime') loadAllTime();
  if (name === 'genres') loadGenres();
  if (name === 'bands') loadBands();
}

document.querySelectorAll('[role="tab"]').forEach((t) => {
  t.addEventListener('click', () => switchView(t.dataset.view));
});
$('#song-back').addEventListener('click', () => switchView('current'));
$('#retry-chart').addEventListener('click', loadCurrent);
$('#retry-history').addEventListener('click', loadHistory);
$('#retry-alltime').addEventListener('click', loadAllTime);
$('#retry-genres').addEventListener('click', loadGenres);
$('#retry-bands').addEventListener('click', loadBands);

document.getElementById('chartlist').addEventListener('click', (ev) => {
  const b = ev.target.closest('.songlink');
  if (b) showSong(b.dataset.release);
});

initSubmit();
loadCurrent();
setInterval(tickCountdown, 1000);
