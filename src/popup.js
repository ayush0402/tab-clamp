const B = globalThis.browser ?? globalThis.chrome;

const $ = (id) => document.getElementById(id);
const send = (msg) => B.runtime.sendMessage(msg);

/** tabId -> { selected, urlLock } while the popup is open. */
const choices = new Map();
let ticker;

function faviconFor(tab) {
  return (
    tab.favIconUrl ||
    'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
          '<rect width="16" height="16" rx="3" fill="#2a3a31"/></svg>',
      )
  );
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return url ?? '';
  }
}

/* ------------------------------------------------------------ setup view */

function renderTabRow(tab) {
  const row = document.createElement('div');
  row.className = 'tab-row';

  const select = document.createElement('input');
  select.type = 'checkbox';
  select.title = 'Clamp this tab';

  const icon = document.createElement('img');
  icon.src = faviconFor(tab);
  icon.alt = '';

  const meta = document.createElement('div');
  meta.className = 'tab-meta';
  const title = document.createElement('div');
  title.className = 'tab-title';
  title.textContent = tab.title || shortUrl(tab.url);
  const url = document.createElement('div');
  url.className = 'tab-url';
  url.textContent = shortUrl(tab.url);
  meta.append(title, url);

  const lockLabel = document.createElement('label');
  lockLabel.className = 'switch';
  lockLabel.title = 'Lock this tab to its exact URL';
  const lock = document.createElement('input');
  lock.type = 'checkbox';
  lock.disabled = true;
  const track = document.createElement('span');
  track.className = 'track';
  const lockText = document.createElement('span');
  lockText.textContent = 'URL';
  lockLabel.append(lockText, lock, track);

  const state = { selected: false, urlLock: false };
  choices.set(tab.id, state);

  select.addEventListener('change', () => {
    state.selected = select.checked;
    lock.disabled = !select.checked;
    if (!select.checked) {
      lock.checked = false;
      state.urlLock = false;
    }
    row.classList.toggle('selected', select.checked);
    validate();
  });
  lock.addEventListener('change', () => {
    state.urlLock = lock.checked;
  });

  row.append(select, icon, meta, lockLabel);
  return row;
}

function validate() {
  const any = [...choices.values()].some((c) => c.selected);
  $('start').disabled = !any;
  $('setup-error').textContent = '';
}

/* Incognito access is off by default in both browsers and can only be granted
 * by hand, so the popup points at the setting rather than failing quietly. */
function renderIncognitoWarning(allowed) {
  $('incognito-warning').classList.toggle('hidden', allowed);
  if (allowed) return;
  const firefox = navigator.userAgent.includes('Firefox');
  $('incognito-how').textContent = firefox
    ? 'Opening a private window escapes the clamp. To close that gap, allow tab-clamp to "Run in Private Windows" in about:addons.'
    : 'Opening an incognito window escapes the clamp. To close that gap, turn on "Allow in Incognito" for tab-clamp in chrome://extensions.';
}

async function renderSetup(settings, incognitoAllowed) {
  $('headline').textContent = 'idle';
  $('setup').classList.remove('hidden');
  $('active').classList.add('hidden');
  renderIncognitoWarning(incognitoAllowed);

  const tabs = await B.tabs.query({ currentWindow: true });
  const list = $('tab-list');
  list.textContent = '';
  choices.clear();
  for (const tab of tabs) {
    if (tab.url?.startsWith(B.runtime.getURL(''))) continue;
    if (tab.incognito) continue; // never recorded to disk
    list.appendChild(renderTabRow(tab));
  }
  validate();

  for (const input of document.querySelectorAll('[data-setting]')) {
    input.checked = Boolean(settings[input.dataset.setting]);
    input.addEventListener('change', () =>
      send({
        type: 'tabclamp:save-settings',
        payload: { [input.dataset.setting]: input.checked },
      }),
    );
  }
}

for (const preset of document.querySelectorAll('.preset')) {
  preset.addEventListener('click', () => {
    document.querySelectorAll('.preset').forEach((p) => p.classList.remove('active'));
    preset.classList.add('active');
    $('minutes').value = preset.dataset.minutes;
  });
}

$('minutes').addEventListener('input', () => {
  document.querySelectorAll('.preset').forEach((p) => {
    p.classList.toggle('active', p.dataset.minutes === $('minutes').value);
  });
});

$('start').addEventListener('click', async () => {
  const minutes = Number($('minutes').value);
  if (!Number.isFinite(minutes) || minutes < 1) {
    $('setup-error').textContent = 'Pick a duration of at least a minute.';
    return;
  }
  const tabs = [...choices.entries()]
    .filter(([, c]) => c.selected)
    .map(([tabId, c]) => ({ tabId, urlLock: c.urlLock }));

  $('start').disabled = true;
  try {
    const result = await send({ type: 'tabclamp:start', payload: { tabs, minutes } });
    if (result?.ok === false) throw new Error(result.error);
    window.close();
  } catch (err) {
    $('setup-error').textContent = String(err?.message ?? err);
    $('start').disabled = false;
  }
});

/* ----------------------------------------------------------- active view */

function formatLeft(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function renderActive(session, exits) {
  $('headline').textContent = 'clamped';
  $('setup').classList.add('hidden');
  $('active').classList.remove('hidden');

  const tick = () => {
    const left = session.endsAt - Date.now();
    $('countdown').textContent = formatLeft(left);
    if (left <= 0) {
      clearInterval(ticker);
      load();
    }
  };
  tick();
  ticker = setInterval(tick, 1000);

  const locked = session.tabs.filter((t) => t.urlLock).length;
  $('active-sub').textContent =
    `${session.tabs.length} tab${session.tabs.length === 1 ? '' : 's'}` +
    (locked ? ` · ${locked} URL-locked` : '');

  const list = $('active-tabs');
  list.textContent = '';
  for (const entry of session.tabs) {
    const row = document.createElement('div');
    row.className = 'tab-row selected';
    const meta = document.createElement('div');
    meta.className = 'tab-meta';
    const title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = entry.title || entry.host;
    const url = document.createElement('div');
    url.className = 'tab-url';
    url.textContent = entry.urlLock ? shortUrl(entry.url) : `${entry.host} (site)`;
    meta.append(title, url);

    const badge = document.createElement('span');
    badge.className = 'muted';
    badge.textContent = entry.urlLock ? 'URL' : 'site';

    row.append(meta, badge);
    list.appendChild(row);
  }

  const recent = exits.filter((e) => Date.now() - e.at < 7 * 24 * 3600 * 1000);
  $('exit-count').textContent = recent.length
    ? `${recent.length} emergency exit${recent.length === 1 ? '' : 's'} in the last 7 days.`
    : 'No emergency exits in the last 7 days.';
}

$('exit').addEventListener('click', async () => {
  await send({ type: 'tabclamp:open-exit' });
  window.close();
});

/* ------------------------------------------------------------------ boot */

async function load() {
  clearInterval(ticker);
  const state = await send({ type: 'tabclamp:get-state' });
  if (state?.session?.active) renderActive(state.session, state.exits);
  else await renderSetup(state?.settings ?? {}, state?.incognitoAllowed ?? false);
}

load();
