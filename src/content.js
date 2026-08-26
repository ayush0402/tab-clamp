/* tab-clamp — in-page guard.
 *
 * The background worker is the real enforcement; this script exists to make the
 * clamp visible and to catch the two cases background events handle badly:
 * SPA route changes (reverting them from the background would reload the page)
 * and tab closes (only a beforeunload handler can raise the native prompt).
 */

(() => {
  const B = globalThis.browser ?? globalThis.chrome;

  // Re-injected on every navigation, and again whenever a new session starts
  // in a page that is still loaded, so a second run just refreshes the policy.
  if (window.__tabClamp) {
    window.__tabClamp.refresh();
    return;
  }

  let policy = null;
  let host;
  let shadow;
  let pillTime;
  let toastEl;
  let toastTimer;

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  /* ------------------------------------------------------------- policy */

  function stripHash(url) {
    try {
      const u = new URL(url, location.href);
      u.hash = '';
      return u.toString();
    } catch {
      return url;
    }
  }

  function baseHost(url) {
    try {
      return new URL(url, location.href).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function isAllowed(url) {
    if (!policy || !url) return true;
    if (url.startsWith('javascript:') || url.startsWith('about:')) return true;
    if (policy.urlLock) return stripHash(url) === stripHash(policy.allowedUrl);
    const h = baseHost(url);
    return h === policy.host || h.endsWith('.' + policy.host);
  }

  /* ----------------------------------------------------------------- ui */

  const STYLE = `
    :host { all: initial; }
    .pill {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      display: flex; align-items: center; gap: 8px;
      padding: 8px 14px; border-radius: 999px;
      font: 500 13px/1.2 system-ui, -apple-system, Segoe UI, sans-serif;
      color: #e8f0e8; background: #16241c;
      border: 1px solid #2f6f4f; box-shadow: 0 4px 16px rgba(0,0,0,.35);
      pointer-events: none; user-select: none;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; }
    .mode { opacity: .65; font-size: 11px; text-transform: uppercase;
            letter-spacing: .06em; }
    .toast {
      position: fixed; right: 16px; bottom: 64px; z-index: 2147483647;
      max-width: 320px; padding: 10px 14px; border-radius: 10px;
      font: 500 13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif;
      color: #fff; background: #7f1d1d; border: 1px solid #b91c1c;
      box-shadow: 0 4px 16px rgba(0,0,0,.35);
      opacity: 0; transform: translateY(6px); transition: all .15s ease;
      pointer-events: none;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
  `;

  function mountUi() {
    if (host) return;
    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647';
    shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = STYLE;

    const pill = document.createElement('div');
    pill.className = 'pill';
    const dot = document.createElement('div');
    dot.className = 'dot';
    pillTime = document.createElement('span');
    const mode = document.createElement('span');
    mode.className = 'mode';
    mode.textContent = policy.urlLock ? 'URL lock' : policy.host;
    pill.append(dot, pillTime, mode);

    toastEl = document.createElement('div');
    toastEl.className = 'toast';

    shadow.append(style, pill, toastEl);
    (document.body ?? document.documentElement).appendChild(host);
  }

  function showToast(text) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  function renderTime() {
    if (!policy || !pillTime) return;
    const left = Math.max(0, policy.endsAt - Date.now());
    const total = Math.floor(left / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    pillTime.textContent = h
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }

  /* ------------------------------------------------------------ guards */

  function onClick(event) {
    if (!policy || event.defaultPrevented) return;
    const link = event.target?.closest?.('a[href]');
    if (!link) return;

    // A link opening a new tab is blocked whatever it points at — the new tab
    // itself is the escape, not the destination.
    if (link.target && link.target !== '_self') {
      event.preventDefault();
      event.stopPropagation();
      showToast('New tabs are blocked while clamped.');
      return;
    }
    if (!isAllowed(link.href)) {
      event.preventDefault();
      event.stopPropagation();
      showToast(
        policy.urlLock
          ? 'URL locked — this page only.'
          : `Site locked to ${policy.host}.`,
      );
    }
  }

  function onBeforeUnload(event) {
    if (!policy) return;
    event.preventDefault();
    event.returnValue = '';
    return '';
  }

  /** Undo a disallowed SPA route change without reloading the page. */
  function revertHistory(url) {
    try {
      originalReplaceState.call(history, history.state, '', url);
    } catch {
      // Cross-origin state; nothing sensible to restore.
    }
  }

  function patchHistory() {
    const wrap = (original) =>
      function (state, title, url) {
        if (url != null && !isAllowed(String(url))) {
          showToast('URL locked — this page only.');
          return;
        }
        return original.apply(this, arguments);
      };
    history.pushState = wrap(originalPushState);
    history.replaceState = wrap(originalReplaceState);
  }

  function unpatchHistory() {
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
  }

  function onPopState() {
    if (policy && !isAllowed(location.href)) revertHistory(policy.allowedUrl);
  }

  /* ------------------------------------------------------------- wiring */

  let ticker;

  function activate(next) {
    policy = next;
    mountUi();
    renderTime();
    ticker = setInterval(renderTime, 1000);
    document.addEventListener('click', onClick, true);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('popstate', onPopState);
    if (policy.urlLock) patchHistory();
  }

  function deactivate() {
    policy = null;
    clearInterval(ticker);
    document.removeEventListener('click', onClick, true);
    window.removeEventListener('beforeunload', onBeforeUnload);
    window.removeEventListener('popstate', onPopState);
    unpatchHistory();
    host?.remove();
    host = shadow = pillTime = toastEl = undefined;
  }

  B.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'tabclamp:toast') showToast(msg.text);
    else if (msg?.type === 'tabclamp:unlocked') deactivate();
    else if (msg?.type === 'tabclamp:revert-history') revertHistory(msg.url);
  });

  function refresh() {
    return B.runtime
      .sendMessage({ type: 'tabclamp:tab-policy' })
      .then((next) => {
        if (!next) {
          if (policy) deactivate();
        } else if (policy) {
          policy = next; // same session, updated bounds
        } else {
          activate(next);
        }
      })
      .catch(() => {
        // Worker asleep or session already over.
      });
  }

  window.__tabClamp = { refresh };
  refresh();
})();
