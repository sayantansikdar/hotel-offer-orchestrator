const params = new URLSearchParams(location.search);
const API = (params.get('api') || window.API_BASE || '').replace(/\/$/, '');

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const hotelKey = (name) => name.trim().toLowerCase().replace(/\s+/g, ' ');

function formatMs(ms) {
  if (ms == null) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

function timeAgo(iso) {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
  return rtf.format(Math.round(seconds / 86400), 'day');
}

/* ---------- API ---------- */

let wakeTimer;
let pending = 0;

async function api(path, { method = 'GET', timeoutMs = 75000 } = {}) {
  // The free tier sleeps when idle; if a request is slow, explain why.
  pending += 1;
  clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => { if (pending > 0) $('#wake').hidden = false; }, 2500);
  try {
    const res = await fetch(API + path, { method, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { res, data };
  } finally {
    pending -= 1;
    if (pending === 0) {
      clearTimeout(wakeTimer);
      $('#wake').hidden = true;
    }
  }
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth; // restart the entrance animation
  el.style.animation = '';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 3600);
}

/* ---------- Health ---------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until the API answers with its own JSON. While a free-tier instance
 * wakes up, the platform can return error pages without CORS headers, which
 * the browser reports as network errors, so keep retrying for a while.
 */
async function waitForApi(maxMs = 150000) {
  const pill = $('#status-pill');
  const deadline = Date.now() + maxMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    try {
      const { data } = await api('/health', { timeoutMs: 30000 });
      if (data && typeof data === 'object' && data.status) return true;
    } catch {
      // not awake yet
    }
    attempt += 1;
    pill.dataset.state = 'loading';
    $('.status-pill__text', pill).textContent = 'Waking server…';
    $('#wake').hidden = false;
    await sleep(Math.min(2000 + attempt * 1000, 6000));
  }
  $('#wake').hidden = true;
  return false;
}

let healthRetry;

async function refreshHealth() {
  const pill = $('#status-pill');
  clearTimeout(healthRetry);
  try {
    const { data } = await api('/health');
    if (!data || typeof data !== 'object' || !data.status) throw new Error('not ready');
    const labels = { ok: 'All systems normal', degraded: 'Degraded', down: 'Unavailable' };
    pill.dataset.state = data.status;
    $('.status-pill__text', pill).textContent = labels[data.status] ?? data.status;

    for (const id of ['A', 'B']) {
      const health = data.suppliers[`Supplier ${id}`];
      const tile = $(`.tile[data-supplier="${id}"]`);
      const status = $('[data-status]', tile);
      status.dataset.state = health.status;
      status.textContent = health.status === 'up' ? `Online · ${health.latencyMs} ms` : `Offline · ${health.error ?? 'no response'}`;
      const toggle = $(`[data-toggle="${id}"]`);
      if (!toggle.disabled) toggle.checked = health.status === 'up';
    }
    for (const dep of ['redis', 'temporal']) {
      const health = data.dependencies[dep];
      const status = $(`.tile[data-dep="${dep}"] [data-status]`);
      status.dataset.state = health.status;
      status.textContent = health.status === 'up' ? `Online · ${health.latencyMs} ms` : 'Offline';
    }
  } catch {
    // Most likely the instance is waking up; check again soon rather than in 30 s.
    pill.dataset.state = 'loading';
    $('.status-pill__text', pill).textContent = 'Reconnecting…';
    healthRetry = setTimeout(refreshHealth, 4000);
  }
}

/* ---------- Search ---------- */

const form = $('#search-form');
const segmented = $('#city-group');

function syncThumb() {
  const radios = $$('input[name="city"]', segmented);
  segmented.style.setProperty('--count', radios.length);
  segmented.style.setProperty('--index', Math.max(0, radios.findIndex((r) => r.checked)));
}

async function supplierPrices(id, city) {
  try {
    const { res, data } = await api(`/supplier${id}/hotels?city=${encodeURIComponent(city)}`);
    if (!res.ok) return null;
    return new Map(data.map((h) => [hotelKey(h.name), h.price]));
  } catch {
    return null;
  }
}

function renderOffers(offers, prices) {
  const list = $('#offers');
  if (offers.length === 0) {
    list.innerHTML = '<li class="empty glass">No hotels match. Try another city or widen the price range.</li>';
    return;
  }
  list.innerHTML = offers
    .map((offer, i) => {
      const key = hotelKey(offer.name);
      const winner = offer.supplier.endsWith('A') ? 'A' : 'B';
      const rows = ['A', 'B']
        .map((id) => ({ id, price: prices[id]?.get(key) }))
        .filter((row) => row.price != null);
      const max = Math.max(...rows.map((r) => r.price), offer.price);
      const other = rows.find((r) => r.id !== winner);
      const saving = other && other.price > offer.price ? other.price - offer.price : 0;
      const compare = rows
        .map(
          (row) => `
            <div class="compare-row ${row.id === winner ? 'compare-row--win' : ''}">
              <span>Supplier ${row.id}</span>
              <span class="bar bar--${row.id}"><span style="width:${((row.price / max) * 100).toFixed(1)}%"></span></span>
              <span>${inr.format(row.price)}</span>
            </div>`,
        )
        .join('');
      const note = saving
        ? `<span class="saving">${inr.format(saving)} below Supplier ${other.id}</span>`
        : rows.length < 2
          ? '<span>Only one supplier lists it</span>'
          : '<span>Same price, higher commission wins</span>';
      return `
        <li class="offer glass" style="--i:${i}">
          <div class="offer__top">
            <h3 class="offer__name">${escapeHtml(offer.name)}</h3>
            <span class="supplier-tag supplier-tag--${winner}">${escapeHtml(offer.supplier)}</span>
          </div>
          <p class="offer__price">${inr.format(offer.price)} <small>/ night</small></p>
          ${compare ? `<div class="offer__compare">${compare}</div>` : ''}
          <div class="offer__foot">${note}<span>${offer.commissionPct}% commission</span></div>
        </li>`;
    })
    .join('');
}

function showMeta({ count, cache, workflowId, ms }) {
  const cacheLabel = { BYPASS: 'Live workflow', HIT: 'Served from Redis', MISS: 'Redis miss · workflow ran' }[cache] ?? cache;
  const meta = $('#result-meta');
  meta.hidden = false;
  meta.innerHTML = `
    <span class="chip">${count} ${count === 1 ? 'hotel' : 'hotels'}</span>
    <span class="chip">${escapeHtml(cacheLabel)}</span>
    <span class="chip">${formatMs(ms)}</span>
    ${workflowId ? `<button type="button" class="chip chip--link" data-open-run="${escapeHtml(workflowId)}">View workflow run ›</button>` : ''}`;
}

function showBanner(kind, html) {
  const banner = $('#partial-banner');
  banner.className = `banner glass banner--${kind}`;
  banner.innerHTML = html;
  banner.hidden = false;
}

async function search(event) {
  event?.preventDefault();
  const city = new FormData(form).get('city');
  const min = form.minPrice.value.trim();
  const max = form.maxPrice.value.trim();
  const error = $('#search-error');
  error.hidden = true;
  if (min && max && Number(min) > Number(max)) {
    error.textContent = 'Min price must not be more than max price.';
    error.hidden = false;
    return;
  }

  const query = new URLSearchParams({ city });
  if (min) query.set('minPrice', min);
  if (max) query.set('maxPrice', max);

  const button = $('.search__submit', form);
  button.setAttribute('aria-busy', 'true');
  $('#partial-banner').hidden = true;
  const started = performance.now();

  try {
    const [{ res, data }, a, b] = await Promise.all([
      api(`/api/hotels?${query}`),
      supplierPrices('A', city),
      supplierPrices('B', city),
    ]);
    const ms = performance.now() - started;

    if (res.status === 400) {
      error.textContent = data.details?.map((d) => d.message).join('. ') ?? 'Invalid search.';
      error.hidden = false;
      return;
    }
    if (res.status === 502) {
      $('#result-meta').hidden = true;
      $('#offers').innerHTML = '';
      const reasons = (data.suppliers ?? []).map((s) => `${escapeHtml(s.supplier)}: ${escapeHtml(s.error ?? 'failed')}`).join(' · ');
      showBanner('error', `<span><strong>Every supplier is down (502).</strong> The workflow retried each one 3 times. ${reasons}</span>`);
      await refreshRuns({ select: 'latest' });
      return;
    }
    if (!res.ok) {
      showBanner('error', `<span><strong>Request failed (${res.status}).</strong> ${escapeHtml(data?.error ?? '')}</span>`);
      return;
    }

    const unavailable = res.headers.get('X-Suppliers-Unavailable');
    if (unavailable) {
      showBanner('warn', `<span><strong>${escapeHtml(unavailable)} is unavailable.</strong> After 3 attempts the workflow carried on with the other supplier, so these results are partial.</span>`);
    }
    const workflowId = res.headers.get('X-Workflow-Id');
    showMeta({ count: data.length, cache: res.headers.get('X-Cache'), workflowId, ms });
    renderOffers(data, { A: a, B: b });
    if (workflowId) await refreshRuns({ select: workflowId });
  } catch {
    // Network error: wait for the API to wake, then retry this search once.
    if (!event?.retried && (await waitForApi())) {
      button.removeAttribute('aria-busy');
      return search({ retried: true, preventDefault() {} });
    }
    showBanner('error', '<span><strong>Could not reach the API.</strong> Please try again in a moment.</span>');
  } finally {
    button.removeAttribute('aria-busy');
  }
}

/* ---------- Supplier switches ---------- */

async function toggleSupplier(event) {
  const input = event.target;
  const id = input.dataset.toggle;
  const available = input.checked;
  input.disabled = true;
  try {
    const { res } = await api(`/supplier${id}/outage`, { method: available ? 'DELETE' : 'POST' });
    if (!res.ok) throw new Error();
    toast(available ? `Supplier ${id} is back online` : `Supplier ${id} is offline. The next search retries it 3 times`);
  } catch {
    input.checked = !available;
    toast(`Could not switch Supplier ${id}`);
  } finally {
    input.disabled = false;
    await refreshHealth();
  }
}

/* ---------- Workflow runs ---------- */

let selectedRun = null;

async function refreshRuns({ select } = {}) {
  const button = $('#refresh-runs');
  button.setAttribute('aria-busy', 'true');
  try {
    const { res, data } = await api('/api/workflows?limit=25');
    if (!res.ok) throw new Error();
    const list = $('#run-list');
    if (data.length === 0) {
      list.innerHTML = '<li class="empty">No runs yet.</li>';
      return;
    }
    list.innerHTML = data
      .map(
        (run) => `
          <li><button type="button" class="run" data-run="${escapeHtml(run.workflowId)}" aria-current="${run.workflowId === selectedRun}">
            <span class="run__dot run__dot--${escapeHtml(run.status)}"></span>
            <span class="run__city">${escapeHtml(run.city || 'run')}</span>
            <span class="run__time">${timeAgo(run.startTime)}</span>
            <span class="run__dur">${formatMs(run.durationMs)}</span>
          </button></li>`,
      )
      .join('');
    const target = select === 'latest' ? data[0].workflowId : select ?? (selectedRun ? null : data[0].workflowId);
    if (target) await openRun(target);
  } catch {
    $('#run-list').innerHTML = '<li class="empty">Could not load runs.</li>';
  } finally {
    button.removeAttribute('aria-busy');
  }
}

function lanes(events, total) {
  const byActivity = new Map();
  for (const event of events) {
    if (!event.activity) continue;
    const lane = byActivity.get(event.activity) ?? { start: event.offsetMs, end: event.offsetMs, tone: 'neutral', attempts: 1 };
    lane.start = Math.min(lane.start, event.offsetMs);
    lane.end = Math.max(lane.end, event.offsetMs);
    if (event.type === 'ActivityCompleted') lane.tone = 'ok';
    if (event.type === 'ActivityFailed' || event.type === 'ActivityTimedOut') lane.tone = 'error';
    const attempt = /attempt (\d+)/.exec(event.title);
    if (attempt) lane.attempts = Number(attempt[1]);
    byActivity.set(event.activity, lane);
  }
  const span = Math.max(total, 1);
  return [...byActivity.entries()]
    .map(([label, lane]) => {
      const left = (lane.start / span) * 100;
      const width = Math.max(((lane.end - lane.start) / span) * 100, 0.8);
      const attempts = lane.attempts > 1 ? ` · ${lane.attempts} attempts` : '';
      return `
        <div class="gantt__row">
          <span class="gantt__label" title="${escapeHtml(label)}">${escapeHtml(label.replace('Cache offers in Redis', 'Cache in Redis'))}</span>
          <span class="gantt__track"><span class="gantt__bar gantt__bar--${lane.tone}" style="left:${left.toFixed(2)}%;width:${Math.min(width, 100 - left).toFixed(2)}%" title="${formatMs(lane.end - lane.start)}${attempts}"></span></span>
        </div>`;
    })
    .join('');
}

async function openRun(workflowId) {
  selectedRun = workflowId;
  $$('.run').forEach((el) => el.setAttribute('aria-current', String(el.dataset.run === workflowId)));
  const panel = $('#run-detail');
  try {
    const { res, data: run } = await api(`/api/workflows/${encodeURIComponent(workflowId)}`);
    if (!res.ok) throw new Error();

    const failedSuppliers = run.result?.suppliers?.filter((s) => s.status === 'failed') ?? [];
    let badge = { cls: 'ok', text: 'Completed' };
    if (run.status === 'COMPLETED' && failedSuppliers.length) badge = { cls: 'warn', text: 'Completed · partial' };
    else if (run.status === 'RUNNING') badge = { cls: '', text: 'Running' };
    else if (run.status !== 'COMPLETED') badge = { cls: 'error', text: run.status.charAt(0) + run.status.slice(1).toLowerCase().replace('_', ' ') };

    const okSuppliers = run.result ? run.result.suppliers.length - failedSuppliers.length : 0;
    const total = run.durationMs ?? run.events.at(-1)?.offsetMs ?? 0;

    panel.innerHTML = `
      <div class="detail__head">
        <div>
          <h3 class="detail__title">${escapeHtml(run.city)}</h3>
          <p class="detail__id">${escapeHtml(run.workflowId)}</p>
        </div>
        <span class="status-badge status-badge--${badge.cls}">${badge.text}</span>
      </div>
      <dl class="stats">
        <div class="stat"><dt>Duration</dt><dd>${formatMs(run.durationMs)}</dd></div>
        <div class="stat"><dt>Best offers</dt><dd>${run.result ? run.result.hotels : '—'}</dd></div>
        <div class="stat"><dt>Suppliers OK</dt><dd>${run.result ? `${okSuppliers} / ${run.result.suppliers.length}` : '0 / 2'}</dd></div>
        <div class="stat"><dt>Cached</dt><dd>${run.result ? (run.result.cached ? 'Yes' : 'No') : '—'}</dd></div>
      </dl>
      <h4 class="sub-title">Activities</h4>
      <div class="gantt">${lanes(run.events, total)}</div>
      <div class="gantt__axis"><span>0 ms</span><span>${formatMs(total)}</span></div>
      <h4 class="sub-title" style="margin-top:28px">Event history</h4>
      <ol class="events">
        ${run.events
          .map(
            (e) => `
              <li class="event event--${e.tone}">
                <span class="event__title">${escapeHtml(e.title)}</span>
                <span class="event__offset">+${formatMs(e.offsetMs)}</span>
                ${e.detail ? `<span class="event__detail">${escapeHtml(e.detail)}</span>` : ''}
              </li>`,
          )
          .join('')}
      </ol>`;
  } catch {
    panel.innerHTML = '<p class="empty">Could not load this run.</p>';
  }
}

/* ---------- Glass highlight follows the pointer ---------- */

let frame = 0;
document.addEventListener('pointermove', (e) => {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const el = e.target.closest?.('.glass');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${e.clientX - rect.left}px`);
    el.style.setProperty('--my', `${e.clientY - rect.top}px`);
  });
}, { passive: true });

/* ---------- Wire up ---------- */

segmented.addEventListener('change', () => { syncThumb(); search(); });
form.addEventListener('submit', search);
$$('[data-toggle]').forEach((input) => input.addEventListener('change', toggleSupplier));
$('#refresh-runs').addEventListener('click', () => refreshRuns());
$('#status-pill').addEventListener('click', refreshHealth);
document.addEventListener('click', (e) => {
  const open = e.target.closest('[data-open-run]');
  if (open) {
    openRun(open.dataset.openRun);
    $('#runs').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  const run = e.target.closest('[data-run]');
  if (run) openRun(run.dataset.run);
});

$('#api-link').href = `${API}/api/hotels?city=delhi`;
$('#health-link').href = `${API}/health`;

syncThumb();
waitForApi().then(async () => {
  await refreshHealth();
  await search();
  if (!selectedRun) await refreshRuns();
});
setInterval(refreshHealth, 30000);
