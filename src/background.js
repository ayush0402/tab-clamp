/* tab-clamp — background service worker / event page.
 *
 * A browser extension cannot veto a tab switch or a tab close: the events are
 * notifications, not vetoes. So every rule here is enforced as "undo it
 * immediately" rather than "prevent it", which is why closing a clamped tab
 * makes it reappear instead of refusing to close.
 */

const B = globalThis.browser ?? globalThis.chrome;

const SESSION_KEY = 'tabclamp.session';
const SETTINGS_KEY = 'tabclamp.settings';
const EXITS_KEY = 'tabclamp.exits';

const ALARM_END = 'tabclamp.end';
const ALARM_TICK = 'tabclamp.tick';

const DEFAULT_SETTINGS = {
  reopenClosedTabs: true,
  blockNewTabs: true,
  keepFocus: true,
  reflectionSeconds: 15,
  minReasonWords: 25,
};

const ACK_PHRASE =
  'I am choosing to leave my focus session and I accept the distraction.';

/* ------------------------------------------------------------------ state */

/** In-memory mirror of the persisted session. `undefined` until first load. */
let session;

/* These guards only need to survive a single wake of the worker: they mark
 * tab/window churn that we caused ourselves, so the handlers don't fight it. */
let internalOps = 0;
let unlocking = false;
let restoring = false;
const internalTabIds = new Set();

/** Enforcement is off while we tear a session down or rebuild one. */
function paused() {
  return unlocking || restoring;
}

async function loadSession() {
  if (session === undefined) {
    const stored = await B.storage.local.get(SESSION_KEY);
    session = stored[SESSION_KEY] ?? null;
  }
  return session;
}

async function saveSession(next) {
  session = next;
  if (next) await B.storage.local.set({ [SESSION_KEY]: next });
  else await B.storage.local.remove(SESSION_KEY);
}

async function getSettings() {
  const stored = await B.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] ?? {}) };
}

/** Serializes mutations so two events can't interleave a read-modify-write. */
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function withInternal(fn) {
  internalOps += 1;
  try {
    return await fn();
  } finally {
    internalOps -= 1;
  }
}

/* ------------------------------------------------------------------ policy */

function stripHash(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

/** The domain a "site lock" is anchored to: hostname minus a leading `www.`. */
function baseHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isExtensionUrl(url) {
  return typeof url === 'string' && url.startsWith(B.runtime.getURL(''));
}

/** True when `url` is somewhere this clamped tab is still allowed to be. */
function isAllowed(entry, url) {
  if (!url || url === 'about:blank') return true;
  if (isExtensionUrl(url)) return true;

  if (entry.urlLock) return stripHash(url) === stripHash(entry.url);

  // Site lock: the anchor domain and anything under it, but not siblings.
  const host = baseHost(url);
  if (!host) return false;
  return host === entry.host || host.endsWith('.' + entry.host);
}

function findEntry(sess, tabId) {
  return sess?.tabs.find((t) => t.tabId === tabId) ?? null;
}

/* ------------------------------------------------------------- injection */

async function injectInto(tabId) {
  try {
    await B.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch {
    // Restricted pages (the store, about:, PDF viewers) reject injection.
    // Background-level enforcement still covers those tabs.
  }
}

async function notifyTab(tabId, message) {
  try {
    await B.tabs.sendMessage(tabId, message);
  } catch {
    // No content script in that tab; nothing to tell.
  }
}

function toast(tabId, text) {
  return notifyTab(tabId, { type: 'tabclamp:toast', text });
}

/* ---------------------------------------------------------------- session */

async function startSession({ tabs, minutes }) {
  const now = Date.now();
  const entries = [];

  for (const req of tabs) {
    let tab;
    try {
      tab = await B.tabs.get(req.tabId);
    } catch {
      continue;
    }
    // Never clamp a private tab: the session is written to disk, and an
    // incognito URL must not outlive its window.
    if (tab.incognito) continue;
    entries.push({
      tabId: tab.id,
      windowId: tab.windowId,
      index: tab.index,
      url: tab.url ?? '',
      host: baseHost(tab.url ?? ''),
      title: tab.title ?? '',
      urlLock: Boolean(req.urlLock),
    });
  }

  if (!entries.length) throw new Error('No tabs selected.');

  const next = {
    active: true,
    startedAt: now,
    endsAt: now + Math.round(minutes * 60_000),
    tabs: entries,
    exitWindowId: null,
  };
  await saveSession(next);

  await B.alarms.clear(ALARM_END);
  await B.alarms.create(ALARM_END, { when: next.endsAt });
  await B.alarms.create(ALARM_TICK, { periodInMinutes: 0.5 });

  await Promise.all(entries.map((e) => injectInto(e.tabId)));
  await B.tabs.update(entries[0].tabId, { active: true });
  await updateBadge();
  return next;
}

async function endSession(reason, note) {
  const sess = await loadSession();
  if (!sess) return;

  unlocking = true;
  try {
    await saveSession(null);
    await B.alarms.clear(ALARM_END);
    await B.alarms.clear(ALARM_TICK);
    await Promise.all(
      sess.tabs.map((e) => notifyTab(e.tabId, { type: 'tabclamp:unlocked' })),
    );

    if (reason === 'emergency') {
      const stored = await B.storage.local.get(EXITS_KEY);
      const exits = stored[EXITS_KEY] ?? [];
      exits.push({
        at: Date.now(),
        note: note ?? '',
        plannedMinutes: Math.round((sess.endsAt - sess.startedAt) / 60_000),
        servedMinutes: Math.round((Date.now() - sess.startedAt) / 60_000),
      });
      await B.storage.local.set({ [EXITS_KEY]: exits.slice(-100) });
    }

    if (sess.exitWindowId != null) {
      try {
        await B.windows.remove(sess.exitWindowId);
      } catch {
        // Already closed by the user.
      }
    }
    await updateBadge();
  } finally {
    // Let the in-flight onRemoved/onCreated events for the teardown drain
    // before we start reopening tabs again.
    setTimeout(() => {
      unlocking = false;
    }, 1500);
  }
}

async function updateBadge() {
  const sess = await loadSession();
  if (!sess) {
    await B.action.setBadgeText({ text: '' });
    return;
  }
  const left = Math.max(0, sess.endsAt - Date.now());
  const mins = Math.ceil(left / 60_000);
  await B.action.setBadgeBackgroundColor({ color: '#2f6f4f' });
  await B.action.setBadgeText({ text: mins >= 60 ? `${Math.floor(mins / 60)}h` : `${mins}` });
}

/* --------------------------------------------------------------- handlers */

/** Snap focus back when the user activates a tab outside the clamp. */
B.tabs.onActivated.addListener((info) =>
  serial(async () => {
    const sess = await loadSession();
    if (!sess || paused()) return;
    const settings = await getSettings();
    if (!settings.keepFocus) return;
    if (findEntry(sess, info.tabId)) return;
    if (internalTabIds.has(info.tabId)) return;

    const home =
      sess.tabs.find((e) => e.windowId === info.windowId) ?? sess.tabs[0];
    try {
      await withInternal(() => B.tabs.update(home.tabId, { active: true }));
      await toast(home.tabId, 'Clamped — you stay on this tab.');
    } catch {
      // The clamped tab vanished; onRemoved will rebuild it.
    }
  }),
);

/** Same idea one level up: don't let another window steal focus. */
B.windows.onFocusChanged.addListener((windowId) =>
  serial(async () => {
    const sess = await loadSession();
    if (!sess || paused()) return;
    if (windowId === B.windows.WINDOW_ID_NONE) return;
    const settings = await getSettings();
    if (!settings.keepFocus) return;
    if (windowId === sess.exitWindowId) return;
    if (sess.tabs.some((e) => e.windowId === windowId)) return;

    try {
      await withInternal(() =>
        B.windows.update(sess.tabs[0].windowId, { focused: true }),
      );
    } catch {
      // Window is gone; the tab-level handlers will re-home it.
    }
  }),
);

/** New tabs are the classic escape hatch, so close them on sight. */
B.tabs.onCreated.addListener((tab) =>
  serial(async () => {
    const sess = await loadSession();
    if (!sess || paused()) return;
    if (internalOps > 0) {
      internalTabIds.add(tab.id);
      return;
    }
    const settings = await getSettings();
    if (!settings.blockNewTabs) return;
    if (findEntry(sess, tab.id) || internalTabIds.has(tab.id)) return;
    if (isExtensionUrl(tab.url ?? tab.pendingUrl ?? '')) return;

    try {
      await withInternal(() => B.tabs.remove(tab.id));
      const home =
        sess.tabs.find((e) => e.windowId === tab.windowId) ?? sess.tabs[0];
      await toast(home.tabId, 'New tabs are blocked while clamped.');
    } catch {
      // Race with the user closing it themselves.
    }
  }),
);

/** A closed clamp tab is reopened where it was. */
B.tabs.onRemoved.addListener((tabId, removeInfo) =>
  serial(async () => {
    const sess = await loadSession();
    internalTabIds.delete(tabId);
    if (!sess || paused()) return;

    if (tabId === sess.exitTabId) {
      await saveSession({ ...sess, exitTabId: null, exitWindowId: null });
      return;
    }

    const entry = findEntry(sess, tabId);
    if (!entry) return;

    const settings = await getSettings();
    if (!settings.reopenClosedTabs) {
      const remaining = sess.tabs.filter((e) => e.tabId !== tabId);
      if (!remaining.length) return endSession('all-tabs-closed');
      await saveSession({ ...sess, tabs: remaining });
      return;
    }

    try {
      const reopened = await withInternal(async () => {
        if (removeInfo.isWindowClosing) {
          const win = await B.windows.create({ url: entry.url, focused: true });
          const tab = win.tabs[0];
          return { tabId: tab.id, windowId: win.id, index: tab.index };
        }
        const tab = await B.tabs.create({
          url: entry.url,
          windowId: entry.windowId,
          index: entry.index,
          active: true,
        });
        return { tabId: tab.id, windowId: tab.windowId, index: tab.index };
      });

      internalTabIds.add(reopened.tabId);
      const fresh = await loadSession();
      if (!fresh) return;
      await saveSession({
        ...fresh,
        tabs: fresh.tabs.map((e) =>
          e.tabId === tabId ? { ...e, ...reopened } : e,
        ),
      });
      await toast(reopened.tabId, 'Clamped — this tab stays open.');
    } catch {
      // Could not reopen (window torn down mid-flight); drop the entry so the
      // session doesn't keep chasing a tab that cannot come back.
      const fresh = await loadSession();
      if (!fresh) return;
      const remaining = fresh.tabs.filter((e) => e.tabId !== tabId);
      if (!remaining.length) return endSession('all-tabs-closed');
      await saveSession({ ...fresh, tabs: remaining });
    }
  }),
);

/* Navigation: revert anything the tab's policy disallows. onBeforeNavigate
 * catches it early, onCommitted is the backstop for redirects that slip past. */
function guardNavigation(details) {
  if (details.frameId !== 0) return;
  return serial(async () => {
    const sess = await loadSession();
    if (!sess || paused()) return;
    const entry = findEntry(sess, details.tabId);
    if (!entry || isAllowed(entry, details.url)) return;

    try {
      await withInternal(() => B.tabs.update(entry.tabId, { url: entry.url }));
      await toast(
        entry.tabId,
        entry.urlLock
          ? 'URL locked — you can only be on this exact page.'
          : `Site locked to ${entry.host}.`,
      );
    } catch {
      // Tab is gone; onRemoved handles it.
    }
  });
}

B.webNavigation.onBeforeNavigate.addListener(guardNavigation);
B.webNavigation.onCommitted.addListener(guardNavigation);

/** SPA route changes never hit onCommitted, so handle them separately. */
B.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  return serial(async () => {
    const sess = await loadSession();
    if (!sess || paused()) return;
    const entry = findEntry(sess, details.tabId);
    if (!entry || isAllowed(entry, details.url)) return;

    // Reverting via tabs.update would reload the page and lose video position,
    // so ask the content script to rewrite history in place instead.
    await notifyTab(entry.tabId, {
      type: 'tabclamp:revert-history',
      url: entry.url,
    });
  });
});

/** Reinject after every real navigation so the overlay survives reloads. */
B.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const sess = await loadSession();
  if (!sess) return;
  if (findEntry(sess, details.tabId)) await injectInto(details.tabId);
});

B.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_END) await endSession('timer');
  else if (alarm.name === ALARM_TICK) {
    const sess = await loadSession();
    if (sess && Date.now() >= sess.endsAt) await endSession('timer');
    else await updateBadge();
  }
});

/* Quitting the browser used to be a free escape: the session was dropped on the
 * way back up. Tab ids don't survive a restart, but the stored URLs do, so the
 * clamp is rebuilt from those instead. A session whose timer ran out while the
 * browser was closed just ends, which is what keeps this from following you
 * into the next morning. */
async function restoreSession() {
  session = undefined;
  const sess = await loadSession();
  if (!sess?.active) return;

  if (Date.now() >= sess.endsAt) {
    await saveSession(null);
    await updateBadge();
    return;
  }

  restoring = true;
  try {
    // Let the browser finish restoring its own tabs first, so we adopt them
    // rather than opening a second copy of everything.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const open = await B.tabs.query({});
    const claimed = new Set();
    const tabs = [];

    for (const entry of sess.tabs) {
      // Match on the anchor domain, not the exact URL — a restored tab may
      // have come back on a different page of the same site, and the
      // navigation guard will pull it back into policy once it's clamped.
      const match = open.find(
        (t) =>
          !claimed.has(t.id) &&
          !t.incognito &&
          baseHost(t.url ?? '') === entry.host,
      );

      if (match) {
        claimed.add(match.id);
        tabs.push({
          ...entry,
          tabId: match.id,
          windowId: match.windowId,
          index: match.index,
        });
      } else {
        const created = await withInternal(() =>
          B.tabs.create({ url: entry.url, active: false }),
        );
        tabs.push({
          ...entry,
          tabId: created.id,
          windowId: created.windowId,
          index: created.index,
        });
      }
    }

    await saveSession({ ...sess, tabs, exitWindowId: null, exitTabId: null });
    await B.alarms.create(ALARM_END, { when: sess.endsAt });
    await B.alarms.create(ALARM_TICK, { periodInMinutes: 0.5 });
    await Promise.all(tabs.map((e) => injectInto(e.tabId)));
    await B.tabs.update(tabs[0].tabId, { active: true });
    await updateBadge();
  } finally {
    restoring = false;
  }
}

B.runtime.onStartup.addListener(restoreSession);

/* Incognito is a one-keystroke escape, so close the window outright. This only
 * fires when the user has granted incognito access; without it the browser
 * hides private windows from extensions entirely and there is nothing to hook.
 * Clamped tabs are never allowed to be incognito, so no private URL is ever
 * written to storage. */
B.windows.onCreated.addListener((win) =>
  serial(async () => {
    const sess = await loadSession();
    if (!sess || paused() || internalOps > 0) return;
    if (!win.incognito) return;

    try {
      await withInternal(() => B.windows.remove(win.id));
      await toast(sess.tabs[0].tabId, 'Private windows are blocked while clamped.');
    } catch {
      // Already gone, or we lack the access needed to close it.
    }
  }),
);

/* --------------------------------------------------------------- messages */

async function openExitWindow() {
  const sess = await loadSession();
  if (!sess) return null;
  if (sess.exitWindowId != null) {
    try {
      await B.windows.update(sess.exitWindowId, { focused: true });
      return sess.exitWindowId;
    } catch {
      // Stale id; fall through and open a fresh one.
    }
  }

  const win = await withInternal(() =>
    B.windows.create({
      url: B.runtime.getURL('exit.html'),
      type: 'popup',
      width: 560,
      height: 640,
      focused: true,
    }),
  );
  const tab = win.tabs?.[0];
  if (tab) internalTabIds.add(tab.id);
  const fresh = await loadSession();
  if (fresh) {
    await saveSession({
      ...fresh,
      exitWindowId: win.id,
      exitTabId: tab?.id ?? null,
    });
  }
  return win.id;
}

async function handleMessage(msg, sender) {
  switch (msg?.type) {
    case 'tabclamp:get-state': {
      const [sess, settings, stored, incognitoAllowed] = await Promise.all([
        loadSession(),
        getSettings(),
        B.storage.local.get(EXITS_KEY),
        // False by default in both browsers, and the user has to grant it by
        // hand — so the popup nags rather than silently leaving the hole open.
        B.extension?.isAllowedIncognitoAccess?.().catch(() => false) ?? false,
      ]);
      return {
        session: sess,
        settings,
        exits: stored[EXITS_KEY] ?? [],
        ackPhrase: ACK_PHRASE,
        incognitoAllowed,
      };
    }

    case 'tabclamp:start':
      return serial(() => startSession(msg.payload));

    case 'tabclamp:save-settings': {
      const settings = { ...(await getSettings()), ...msg.payload };
      await B.storage.local.set({ [SETTINGS_KEY]: settings });
      return settings;
    }

    case 'tabclamp:open-exit':
      return serial(openExitWindow);

    case 'tabclamp:emergency-exit': {
      const settings = await getSettings();
      const note = String(msg.note ?? '').trim();
      const words = note.split(/\s+/).filter(Boolean).length;
      if (!note.includes(ACK_PHRASE)) {
        return { ok: false, error: 'The acknowledgement sentence is missing.' };
      }
      if (words < settings.minReasonWords + ACK_PHRASE.split(/\s+/).length) {
        return { ok: false, error: 'Write more about why you are leaving.' };
      }
      await serial(() => endSession('emergency', note));
      return { ok: true };
    }

    case 'tabclamp:end':
      // Only reachable once the timer has already run out.
      return serial(async () => {
        const sess = await loadSession();
        if (sess && Date.now() < sess.endsAt) {
          return { ok: false, error: 'Session still running.' };
        }
        await endSession('manual');
        return { ok: true };
      });

    case 'tabclamp:tab-policy': {
      const sess = await loadSession();
      const tabId = sender?.tab?.id;
      const entry = tabId == null ? null : findEntry(sess, tabId);
      if (!entry) return null;
      return {
        endsAt: sess.endsAt,
        urlLock: entry.urlLock,
        allowedUrl: entry.url,
        host: entry.host,
      };
    }

    default:
      return null;
  }
}

B.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse, (err) =>
    sendResponse({ ok: false, error: String(err?.message ?? err) }),
  );
  return true; // keep the channel open for the async response
});
