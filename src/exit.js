const B = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const send = (msg) => B.runtime.sendMessage(msg);

let ackPhrase = '';
let minWords = 25;
let waitLeft = 15;

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function mark(el, done, label) {
  el.classList.toggle('done', done);
  el.textContent = `${done ? '✓' : '○'}  ${label}`;
}

function validate() {
  const text = $('reason').value;
  const hasPhrase = text.includes(ackPhrase);
  // The acknowledgement sentence is boilerplate, so it doesn't count toward
  // the words the user has to write themselves.
  const ownWords = countWords(text.replace(ackPhrase, ' '));

  mark($('chk-phrase'), hasPhrase, 'Contains the acknowledgement sentence');
  mark(
    $('chk-words'),
    ownWords >= minWords,
    `Explains why, in your own words (${ownWords}/${minWords})`,
  );
  mark(
    $('chk-wait'),
    waitLeft <= 0,
    waitLeft > 0 ? `Reflection pause (${waitLeft}s)` : 'Reflection pause',
  );

  $('unlock').disabled = !(hasPhrase && ownWords >= minWords && waitLeft <= 0);
}

function formatLeft(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')} left`;
}

async function boot() {
  const state = await send({ type: 'tabclamp:get-state' });
  if (!state?.session?.active) {
    document.body.textContent = 'No session is running.';
    return;
  }

  ackPhrase = state.ackPhrase;
  minWords = state.settings.minReasonWords;
  waitLeft = state.settings.reflectionSeconds;

  $('ack-phrase').textContent = ackPhrase;

  const session = state.session;
  const served = Math.round((Date.now() - session.startedAt) / 60_000);
  const planned = Math.round((session.endsAt - session.startedAt) / 60_000);
  $('summary').textContent =
    `You are ${served} of ${planned} minutes into this session, ` +
    `across ${session.tabs.length} tab${session.tabs.length === 1 ? '' : 's'}.`;

  setInterval(() => {
    $('remaining').textContent = formatLeft(session.endsAt - Date.now());
  }, 1000);
  $('remaining').textContent = formatLeft(session.endsAt - Date.now());

  const countdown = setInterval(() => {
    waitLeft -= 1;
    if (waitLeft <= 0) clearInterval(countdown);
    validate();
  }, 1000);

  $('reason').addEventListener('input', validate);
  validate();
}

$('unlock').addEventListener('click', async () => {
  $('unlock').disabled = true;
  const result = await send({
    type: 'tabclamp:emergency-exit',
    note: $('reason').value,
  });
  if (result?.ok) {
    window.close();
  } else {
    $('error').textContent = result?.error ?? 'Could not unlock.';
    $('unlock').disabled = false;
  }
});

$('stay').addEventListener('click', () => window.close());

boot();
