/*
Overlay Widget (vanilla JS + Shadow DOM)

How to run (local demo):
- Start your dev server (e.g., `npm run dev`) that serves this repo at http://localhost:3000
- Open http://localhost:3000/overlay-demo.html

How to embed:
- Include the script on your page with data-* attributes:
  <script src="/overlay-widget.js"
          data-merchant-id="demo-merchant-1"
          data-api-key="DEMO_KEY_123"
          data-api-base="http://localhost:3000"></script>
  - data-merchant-id: required (e.g., demo-merchant-1)
  - data-api-key: optional in local; if provided, sent as `x-overlay-key`
  - data-api-base: optional; defaults to same origin

Notes on headers/CORS:
- The demo BFF endpoints are CORS-enabled. In local dev, `x-overlay-key` is optional unless the server env sets `WIDGET_OVERLAY_KEY`.
- This widget uses fetch() to call:
  - GET  /api/bff/demo/catalog?merchantId=...
  - POST /api/bff/demo/purchase

Accessibility:
- ESC closes the modal. Clicking the backdrop closes the modal.

Constraints met:
- Dependency-free (no bundlers/packages). Shadow DOM to isolate styles.
*/

(function () {
  const scriptEl = document.currentScript;
  if (!scriptEl) {
    // Fail silently if the script element cannot be determined
    return;
  }

  // Read config from script tag
  const MERCHANT_ID = scriptEl.getAttribute('data-merchant-id') || '';
  const API_KEY = scriptEl.getAttribute('data-api-key') || '';
  const API_BASE = (scriptEl.getAttribute('data-api-base') || window.location.origin).replace(/\/$/, '');

  if (!MERCHANT_ID) {
    console.warn('[overlay-widget] Missing data-merchant-id');
  }

  // Host container + Shadow DOM
  const hostId = 'overlay-widget-host';
  if (document.getElementById(hostId)) {
    // Prevent double-mount if script included multiple times
    return;
  }
  const host = document.createElement('div');
  host.id = hostId;
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  // State
  let isOpen = false;
  let offersCache = null; // cache offers for session
  const selected = new Map(); // offerId -> qty
  let view = 'catalog'; // 'catalog' | 'checkout' | 'confirm' | 'error' | 'loading'
  let lastErrorMessage = '';
  let lastOrder = null; // store confirmation
  const health = { status: 'idle', code: '', last: 0 }; // idle | checking | ok | error

  // Utilities
  function cls(parts) { return parts.filter(Boolean).join(' '); }

  function formatMoney(currency, minor) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100);
    } catch (_) {
      // Fallback: assume two decimals
      const value = (minor / 100).toFixed(2);
      return `${currency} ${value}`;
    }
  }

  function sumSelectedSubtotalMinor(offers) {
    let sum = 0;
    for (const [offerId, qty] of selected.entries()) {
      const offer = offers.find(o => o.id === offerId);
      if (offer) sum += offer.amountMinor * qty;
    }
    return sum;
  }

  function countSelectedItems() {
    let count = 0;
    for (const [, qty] of selected.entries()) count += qty;
    return count;
  }

  function getSelectedItems() {
    const items = [];
    for (const [offerId, qty] of selected.entries()) {
      if (qty > 0) items.push({ offerId, qty });
    }
    return items;
  }

  // API
  async function fetchOffersOnce() {
    if (offersCache) return offersCache;
    const url = `${API_BASE}/api/bff/demo/catalog?merchantId=${encodeURIComponent(MERCHANT_ID)}`;
    const headers = {};
    if (API_KEY) headers['x-overlay-key'] = API_KEY;
    let resp;
    try {
      resp = await fetch(url, { headers });
    } catch (e) {
      throw new Error('NETWORK');
    }
    if (!resp.ok) {
      // Try parse error code
      try {
        const data = await resp.json();
        if (data && data.error) throw new Error(data.error);
      } catch (_) {}
      throw new Error('REQUEST_FAILED');
    }
    try {
      const data = await resp.json();
      if (!data || !Array.isArray(data.offers)) throw new Error('BAD_RESPONSE');
      const active = data.offers.filter(o => o && o.active);
      offersCache = { merchantId: data.merchantId, offers: active };
      return offersCache;
    } catch (e) {
      throw new Error('PARSE');
    }
  }

  async function submitPurchase(body) {
    const url = `${API_BASE}/api/bff/demo/purchase`;
    const headers = { 'content-type': 'application/json' };
    if (API_KEY) headers['x-overlay-key'] = API_KEY;
    let resp;
    try {
      resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (e) {
      throw new Error('NETWORK');
    }
    let data;
    try {
      data = await resp.json();
    } catch (_) {
      throw new Error('PARSE');
    }
    if (!resp.ok) {
      if (data && data.error) throw new Error(data.error);
      throw new Error('REQUEST_FAILED');
    }
    if (data && data.error) {
      throw new Error(data.error);
    }
    return data;
  }

  // Styles (Shadow DOM scoped)
  const styles = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .ow-font { font: 14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0f172a; }
    .ow-fab {
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
      background: #0ea5e9; color: #fff; border: none; border-radius: 9999px;
      padding: 14px 16px; cursor: pointer; box-shadow: 0 8px 24px rgba(2, 6, 23, 0.2);
      display: flex; align-items: center; gap: 8px; font-weight: 600;
    }
    .ow-fab:hover { background: #0284c7; }
    .ow-fab:active { transform: translateY(1px); }
    .ow-fab .ow-dot { font-size: 18px; }
    .ow-status-dot { width: 10px; height: 10px; border-radius: 9999px; display: inline-block; background: #cbd5e1; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.08); }
    .ow-status-dot.ok { background: #16a34a; }
    .ow-status-dot.err { background: #dc2626; }
    .ow-status-dot.checking { background: #f59e0b; animation: ow-pulse 1s ease-in-out infinite; }
    @keyframes ow-pulse { 0%,100%{ opacity:.6 } 50%{ opacity:1 } }

    .ow-modal { position: fixed; inset: 0; display: none; z-index: 2147483646; }
    .ow-modal.open { display: block; }
    .ow-backdrop { position: absolute; inset: 0; background: rgba(2, 6, 23, 0.5); }
    .ow-dialog {
      position: absolute; right: 20px; bottom: 84px; width: min(680px, calc(100vw - 40px)); max-height: min(80vh, 720px);
      background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 24px 48px rgba(2, 6, 23, 0.35);
      display: flex; flex-direction: column;
    }
    .ow-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #e2e8f0; background: #f8fafc; }
    .ow-title { margin: 0; font-size: 16px; font-weight: 700; color: #0f172a; }
    .ow-close { border: none; background: transparent; font-size: 18px; cursor: pointer; color: #334155; padding: 6px; }
    .ow-close:hover { color: #0f172a; }
    .ow-head-right { display:flex; align-items:center; gap:8px; }
    .ow-status-pill { font-size: 12px; color: #0f172a; background:#e2e8f0; border-radius:9999px; padding:2px 8px; }
    .ow-status-pill.ok { background:#dcfce7; color:#166534; }
    .ow-status-pill.err { background:#fee2e2; color:#991b1b; }
    .ow-status-pill.checking { background:#fef3c7; color:#92400e; }
    .ow-status-retry { border:none; background:#e2e8f0; color:#0f172a; border-radius:6px; padding:4px 8px; cursor:pointer; }
    .ow-status-retry:hover { background:#cbd5e1; }
    .ow-body { overflow: auto; padding: 12px; }
    .ow-footer { padding: 12px; border-top: 1px solid #e2e8f0; display: flex; gap: 8px; justify-content: flex-end; background: #fff; }

    .ow-grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
    @media (min-width: 560px) { .ow-grid { grid-template-columns: 1fr 1fr; } }

    .ow-card { border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; display: flex; background: #fff; }
    .ow-media { width: 120px; height: 100%; background: #f1f5f9; display: flex; align-items: center; justify-content: center; }
    .ow-media img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .ow-content { padding: 10px; display: flex; flex-direction: column; gap: 6px; flex: 1; }
    .ow-name { font-weight: 700; color: #0f172a; }
    .ow-desc { color: #475569; font-size: 13px; }
    .ow-price { color: #0f172a; font-weight: 600; }
    .ow-qty { margin-top: auto; display: flex; align-items: center; gap: 8px; }
    .ow-qty button { width: 28px; height: 28px; border-radius: 6px; border: 1px solid #cbd5e1; background: #fff; cursor: pointer; }
    .ow-qty button:disabled { opacity: 0.5; cursor: not-allowed; }
    .ow-qty input { width: 48px; text-align: center; border: 1px solid #cbd5e1; border-radius: 6px; padding: 4px; }

    .ow-actions { display: flex; justify-content: space-between; align-items: center; padding-top: 6px; }
    .ow-actions .ow-note { color: #64748b; font-size: 12px; }

    .ow-btn { border: none; border-radius: 8px; padding: 10px 14px; font-weight: 700; cursor: pointer; }
    .ow-btn.primary { background: #0ea5e9; color: #fff; }
    .ow-btn.primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .ow-btn.secondary { background: #e2e8f0; color: #0f172a; }

    .ow-empty, .ow-error { text-align: center; color: #334155; padding: 24px; }
    .ow-error code { background: #fee2e2; color: #991b1b; padding: 2px 6px; border-radius: 4px; }

    .ow-spinner { width: 24px; height: 24px; border-radius: 50%; border: 3px solid #bae6fd; border-top-color: #0ea5e9; animation: ow-spin 1s linear infinite; margin: 12px auto; }
    @keyframes ow-spin { to { transform: rotate(360deg); } }

    .ow-form { display: grid; grid-template-columns: 1fr; gap: 10px; }
    .ow-field { display: flex; flex-direction: column; gap: 4px; }
    .ow-label { font-size: 13px; color: #334155; }
    .ow-input { border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px; font-size: 14px; }
    .ow-input.invalid { border-color: #ef4444; background: #fef2f2; }
    .ow-hint { color: #ef4444; font-size: 12px; }

    .ow-summary { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; }
    .ow-summary ul { margin: 0; padding-left: 18px; }
    .ow-summary li { margin: 3px 0; }

    .ow-confirm { padding: 10px; }
    .ow-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; }
  `;

  // Root HTML skeleton
  const container = document.createElement('div');
  container.className = 'ow-font';
  container.innerHTML = `
    <style>${styles}</style>
    <button class="ow-fab" type="button" aria-haspopup="dialog" aria-controls="ow-modal">
      <span class="ow-dot">🎁</span>
      <span>Gifts</span>
      <span class="ow-status-dot" id="ow-status-dot" aria-hidden="true"></span>
    </button>
    <div id="ow-modal" class="ow-modal" role="dialog" aria-modal="true" aria-label="Gift Cards Modal">
      <div class="ow-backdrop"></div>
      <div class="ow-dialog">
        <div class="ow-header">
          <h2 class="ow-title">Gift Cards</h2>
          <div class="ow-head-right">
            <span class="ow-status-pill" id="ow-status-label">Status: Idle</span>
            <button class="ow-status-retry" type="button" id="ow-status-retry" title="Recheck" aria-label="Recheck">↻</button>
            <button class="ow-close" type="button" aria-label="Close">✕</button>
          </div>
        </div>
        <div class="ow-body" id="ow-body"></div>
        <div class="ow-footer" id="ow-footer"></div>
      </div>
    </div>
  `;
  root.appendChild(container);

  const fabBtn = container.querySelector('.ow-fab');
  const modal = container.querySelector('#ow-modal');
  const bodyEl = container.querySelector('#ow-body');
  const footerEl = container.querySelector('#ow-footer');
  const closeBtn = container.querySelector('.ow-close');
  const statusDot = container.querySelector('#ow-status-dot');
  const statusLabel = container.querySelector('#ow-status-label');
  const statusRetry = container.querySelector('#ow-status-retry');

  // Event wiring
  fabBtn.addEventListener('click', async () => {
    openModal();
  });
  closeBtn.addEventListener('click', () => { closeModal(); });
  modal.querySelector('.ow-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  // ESC handling (global)
  const escHandler = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  window.addEventListener('keydown', escHandler);
  if (statusRetry) statusRetry.addEventListener('click', () => runHealthCheck());

  // Render functions
  function renderLoading(message) {
    bodyEl.innerHTML = `
      <div class="ow-empty">
        <div class="ow-spinner"></div>
        <div>${message || 'Loading...'}</div>
      </div>
    `;
    footerEl.innerHTML = '';
  }

  function renderError(message, code) {
    bodyEl.innerHTML = `
      <div class="ow-error">
        <div>Something went wrong${code ? ':' : ''} ${code ? `<code>${code}</code>` : ''}</div>
        ${message ? `<div style=\"margin-top:6px;color:#64748b\">${message}</div>` : ''}
      </div>
    `;
    footerEl.innerHTML = `
      <button class="ow-btn secondary" type="button" id="ow-back">Back</button>
    `;
    footerEl.querySelector('#ow-back').addEventListener('click', () => {
      setView('catalog');
    });
  }

  function updateStatusUI() {
    if (!statusDot || !statusLabel) return;
    statusDot.classList.remove('ok','err','checking');
    statusLabel.classList.remove('ok','err','checking');
    let text = 'Status: Idle';
    if (health.status === 'checking') { statusDot.classList.add('checking'); statusLabel.classList.add('checking'); text = 'Checking…'; }
    else if (health.status === 'ok') { statusDot.classList.add('ok'); statusLabel.classList.add('ok'); text = 'Connected'; }
    else if (health.status === 'error') { statusDot.classList.add('err'); statusLabel.classList.add('err'); text = 'Error' + (health.code ? `: ${health.code}` : ''); }
    statusLabel.textContent = text;
    statusLabel.title = health.last ? `${text} • ${new Date(health.last).toLocaleTimeString()}` : text;
  }

  async function runHealthCheck() {
    health.status = 'checking'; health.code = ''; health.last = Date.now(); updateStatusUI();
    const url = `${API_BASE}/api/bff/demo/catalog?merchantId=${encodeURIComponent(MERCHANT_ID)}`;
    const headers = {}; if (API_KEY) headers['x-overlay-key'] = API_KEY;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = setTimeout(() => { try { ctrl && ctrl.abort(); } catch(_){} }, 8000);
    let resp;
    try {
      resp = await fetch(url, { method: 'GET', headers, cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    } catch (e) {
      clearTimeout(timeout);
      health.status = 'error'; health.code = 'NETWORK'; health.last = Date.now(); updateStatusUI();
      return;
    }
    clearTimeout(timeout);
    if (resp && resp.ok) {
      health.status = 'ok'; health.code = ''; health.last = Date.now(); updateStatusUI();
      return;
    }
    try {
      const data = await resp.json();
      if (data && data.error) health.code = data.error;
    } catch (_) {}
    health.status = 'error'; if (!health.code) health.code = 'REQUEST_FAILED'; health.last = Date.now(); updateStatusUI();
  }

  function renderCatalog(offers, currency) {
    const cards = offers.map((o) => {
      const qty = selected.get(o.id) || 0;
      const reachMax = typeof o.maxPerOrder === 'number' && qty >= o.maxPerOrder;
      const price = formatMoney(o.currency || currency || 'EUR', o.amountMinor);
      const maxNote = o.maxPerOrder ? `Max per order: ${o.maxPerOrder}` : '';
      const img = o.imageUrl ? `<img alt="${escapeHtml(o.name)}" src="${escapeAttr(o.imageUrl)}">` : `<div style="font-size:28px;">🛍️</div>`;
      return `
        <div class="ow-card">
          <div class="ow-media">${img}</div>
          <div class="ow-content">
            <div class="ow-name">${escapeHtml(o.name || 'Unnamed')}</div>
            <div class="ow-desc">${escapeHtml(o.description || '')}</div>
            <div class="ow-actions">
              <div class="ow-price">${price}</div>
              <div class="ow-note">${maxNote}</div>
            </div>
            <div class="ow-qty">
              <button type="button" class="ow-dec" data-id="${escapeAttr(o.id)}">−</button>
              <input type="text" class="ow-qty-input" data-id="${escapeAttr(o.id)}" value="${qty}" aria-label="Quantity for ${escapeAttr(o.name)}">
              <button type="button" class="ow-inc" data-id="${escapeAttr(o.id)}" ${reachMax ? 'disabled' : ''}>＋</button>
            </div>
          </div>
        </div>
      `;
    }).join('');
    bodyEl.innerHTML = `<div class="ow-grid">${cards || '<div class="ow-empty">No active offers.</div>'}</div>`;

    const itemCount = countSelectedItems();
    const subtotal = sumSelectedSubtotalMinor(offers);
    const subtotalFmt = offers.length ? formatMoney(offers[0].currency || 'EUR', subtotal) : '';
    footerEl.innerHTML = `
      <div style="margin-right:auto;display:flex;align-items:center;gap:10px;color:#334155;">
        <div>Selected: <strong>${itemCount}</strong></div>
        ${itemCount > 0 ? `<div>Subtotal: <strong>${subtotalFmt}</strong></div>` : ''}
      </div>
      <button class="ow-btn secondary" type="button" id="ow-cancel">Close</button>
      <button class="ow-btn primary" type="button" id="ow-checkout" ${itemCount === 0 ? 'disabled' : ''}>Checkout</button>
    `;
    footerEl.querySelector('#ow-cancel').addEventListener('click', closeModal);
    footerEl.querySelector('#ow-checkout').addEventListener('click', () => setView('checkout'));

    // Bind qty controls
    bodyEl.querySelectorAll('.ow-inc').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const offer = offers.find(o => o.id === id);
        const qty = selected.get(id) || 0;
        const next = Math.min(qty + 1, Number.isFinite(offer.maxPerOrder) ? offer.maxPerOrder : qty + 1);
        selected.set(id, next);
        setView('catalog');
      });
    });
    bodyEl.querySelectorAll('.ow-dec').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const qty = selected.get(id) || 0;
        const next = Math.max(0, qty - 1);
        if (next === 0) selected.delete(id); else selected.set(id, next);
        setView('catalog');
      });
    });
    bodyEl.querySelectorAll('.ow-qty-input').forEach(inp => {
      inp.addEventListener('change', () => {
        const id = inp.getAttribute('data-id');
        const offer = offers.find(o => o.id === id);
        const v = Number(String(inp.value).trim());
        const safe = Number.isFinite(v) && v >= 0 ? v : 0;
        const max = Number.isFinite(offer.maxPerOrder) ? offer.maxPerOrder : safe;
        const bounded = Math.min(safe, max);
        if (bounded === 0) selected.delete(id); else selected.set(id, bounded);
        setView('catalog');
      });
    });
  }

  function renderCheckout(offers) {
    const items = getSelectedItems();
    const haveItems = items.length > 0;
    const summary = items.map(it => {
      const offer = offers.find(o => o.id === it.offerId);
      const name = offer ? offer.name : it.offerId;
      const price = offer ? formatMoney(offer.currency || 'EUR', offer.amountMinor) : '';
      return `<li><strong>${escapeHtml(name)}</strong> × ${it.qty} <span style=\"color:#64748b\">(${price} each)</span></li>`;
    }).join('');
    bodyEl.innerHTML = `
      <div class="ow-form">
        <div class="ow-summary">
          <div style="font-weight:700;margin-bottom:6px;">Order Summary</div>
          <ul>${summary || '<li>No items selected.</li>'}</ul>
        </div>
        <div class="ow-field">
          <label class="ow-label" for="ow-buyer-name">Buyer Name</label>
          <input class="ow-input" id="ow-buyer-name" type="text" placeholder="Jane Doe">
          <div class="ow-hint" id="ow-buyer-name-hint" style="display:none;">Please enter your name</div>
        </div>
        <div class="ow-field">
          <label class="ow-label" for="ow-buyer-email">Buyer Email</label>
          <input class="ow-input" id="ow-buyer-email" type="email" placeholder="jane@acme.com">
          <div class="ow-hint" id="ow-buyer-email-hint" style="display:none;">Please enter a valid email</div>
        </div>
        <div class="ow-field">
          <label class="ow-label" for="ow-recipient-email">Recipient Email</label>
          <input class="ow-input" id="ow-recipient-email" type="email" placeholder="recipient@domain.com">
          <div class="ow-hint" id="ow-recipient-email-hint" style="display:none;">Please enter a valid email</div>
        </div>
      </div>
    `;
    footerEl.innerHTML = `
      <button class="ow-btn secondary" type="button" id="ow-back">Back</button>
      <button class="ow-btn primary" type="button" id="ow-submit" ${haveItems ? '' : 'disabled'}>Submit Purchase</button>
    `;
    footerEl.querySelector('#ow-back').addEventListener('click', () => setView('catalog'));
    const submitBtn = footerEl.querySelector('#ow-submit');
    submitBtn.addEventListener('click', async () => {
      // Validate
      const nameEl = bodyEl.querySelector('#ow-buyer-name');
      const buyerEmailEl = bodyEl.querySelector('#ow-buyer-email');
      const recipEmailEl = bodyEl.querySelector('#ow-recipient-email');
      const v = {
        name: (nameEl.value || '').trim(),
        buyerEmail: (buyerEmailEl.value || '').trim(),
        recipientEmail: (recipEmailEl.value || '').trim(),
      };
      let valid = true;
      function setInvalid(el, hintId, bad) {
        if (bad) { el.classList.add('invalid'); bodyEl.querySelector('#'+hintId).style.display = 'block'; }
        else { el.classList.remove('invalid'); bodyEl.querySelector('#'+hintId).style.display = 'none'; }
      }
      setInvalid(nameEl, 'ow-buyer-name-hint', v.name.length === 0);
      setInvalid(buyerEmailEl, 'ow-buyer-email-hint', !isValidEmail(v.buyerEmail));
      setInvalid(recipEmailEl, 'ow-recipient-email-hint', !isValidEmail(v.recipientEmail));
      valid = v.name && isValidEmail(v.buyerEmail) && isValidEmail(v.recipientEmail) && haveItems;
      if (!valid) return;

      // Submit
      setView('loading', 'Submitting order...');
      try {
        const payload = {
          merchantId: MERCHANT_ID,
          buyer: { name: v.name, email: v.buyerEmail },
          recipient: { email: v.recipientEmail },
          items: getSelectedItems(),
        };
        const res = await submitPurchase(payload);
        lastOrder = res;
        setView('confirm');
      } catch (e) {
        lastErrorMessage = e && e.message ? e.message : 'UNKNOWN';
        setView('error');
      }
    });
  }

  function renderConfirm(order) {
    const total = formatMoney(order.currency || 'EUR', order.totalMinor);
    const codes = (order.giftCards || []).map(g => `<li><span class=\"ow-mono\">${escapeHtml(g.code)}</span> — ${escapeHtml(g.recipientEmail)} (${escapeHtml(g.currency || order.currency)} ${((g.valueMinor || 0)/100).toFixed(2)})</li>`).join('');
    bodyEl.innerHTML = `
      <div class="ow-confirm">
        <div style="font-size:16px;font-weight:700;margin-bottom:6px;">Order Confirmed</div>
        <div style="margin-bottom:10px;">Order ID: <span class="ow-mono">${escapeHtml(order.orderId)}</span></div>
        <div style="margin-bottom:10px;">Total: <strong>${total}</strong></div>
        <div style="font-weight:700;margin-top:10px;">Issued Codes</div>
        <ul style="margin-top:6px;padding-left:18px;">${codes || '<li>No codes issued.</li>'}</ul>
      </div>
    `;
    footerEl.innerHTML = `
      <button class="ow-btn secondary" type="button" id="ow-done">Done</button>
    `;
    footerEl.querySelector('#ow-done').addEventListener('click', () => {
      closeModal();
    });
  }

  function setView(next, loadingMessage) {
    view = next;
    if (view === 'loading') {
      renderLoading(loadingMessage);
      return;
    }
    if (view === 'error') {
      const code = sanitizeErrorCode(lastErrorMessage);
      renderError(undefined, code);
      return;
    }
    if (view === 'catalog') {
      renderLoading('Loading offers...');
      fetchOffersOnce().then(({ offers }) => {
        renderCatalog(offers, offers[0]?.currency || 'EUR');
      }).catch((e) => {
        lastErrorMessage = e && e.message ? e.message : 'UNKNOWN';
        renderError(undefined, sanitizeErrorCode(lastErrorMessage));
      });
      return;
    }
    if (view === 'checkout') {
      fetchOffersOnce().then(({ offers }) => {
        renderCheckout(offers);
      }).catch((e) => {
        lastErrorMessage = e && e.message ? e.message : 'UNKNOWN';
        renderError(undefined, sanitizeErrorCode(lastErrorMessage));
      });
      return;
    }
    if (view === 'confirm') {
      if (lastOrder) renderConfirm(lastOrder); else renderError('Missing order', 'UNKNOWN');
      return;
    }
  }

  function openModal() {
    if (isOpen) { modal.classList.add('open'); return; }
    isOpen = true;
    modal.classList.add('open');
    setView('catalog'); // fetch on first open via view
    runHealthCheck();
  }

  function closeModal() {
    modal.classList.remove('open');
    // persist selections during the session; do not clear selected
  }

  // Helpers
  function isValidEmail(email) {
    // Simple email heuristic
    return /.+@.+\..+/.test(email);
  }
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
  function escapeAttr(str) { return escapeHtml(str).replace(/"/g, '&quot;'); }
  function sanitizeErrorCode(msg) {
    const known = ['NO_ITEMS','OFFER_NOT_FOUND','QTY_LIMIT','CURRENCY_MISMATCH','INVALID_MERCHANT','UNAUTHORISED','NETWORK','REQUEST_FAILED','PARSE','BAD_RESPONSE'];
    if (known.includes(msg)) return msg;
    // The server might send other codes; display uppercase wordlike
    const up = String(msg || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    return up || 'UNKNOWN';
  }
  // Initial passive health check shortly after load
  setTimeout(runHealthCheck, 200);
})();
