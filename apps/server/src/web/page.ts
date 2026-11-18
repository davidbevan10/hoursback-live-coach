/** The private second-screen coach page. Vanilla HTML + SSE: fewest moving parts, lowest latency. */
export const COACH_PAGE = /* html */ `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>PRIVATE coach - do not share</title>
<style>
  :root {
    --bg: #0f1419; --panel: #172029; --line: #26323d; --text: #e8edf2; --muted: #8b9aa8;
    --accent: #f0a04b; --probe: #5fb3f9; --objection: #f2685c; --signal: #4fd18b; --shift: #c792ea;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .warn { background: #5a1d1d; color: #ffd9d4; padding: 8px 16px; font-size: 13px; display: flex; justify-content: space-between; gap: 12px; align-items: center; }
  .warn button { background: transparent; border: 1px solid #ffd9d4; color: #ffd9d4; border-radius: 6px; padding: 2px 10px; cursor: pointer; }
  header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--line); }
  header .who { font-weight: 600; }
  header .muted, .muted { color: var(--muted); font-size: 13px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; background: #555; margin-right: 6px; }
  .dot.live { background: var(--signal); box-shadow: 0 0 8px var(--signal); }
  main { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 16px; padding: 16px; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  .cue { background: var(--panel); border: 1px solid var(--line); border-left: 6px solid var(--accent); border-radius: 12px; padding: 18px 20px; }
  .cue.big { min-height: 170px; }
  .cue.big .headline { font-size: 26px; font-weight: 700; line-height: 1.2; }
  .cue.big .say { font-size: 22px; margin-top: 10px; }
  .cue .type { text-transform: uppercase; letter-spacing: .08em; font-size: 12px; font-weight: 700; }
  .cue .meta { margin-top: 10px; color: var(--muted); font-size: 13px; }
  .t-probe { border-left-color: var(--probe); } .t-probe .type { color: var(--probe); }
  .t-objection { border-left-color: var(--objection); } .t-objection .type { color: var(--objection); }
  .t-buying_signal { border-left-color: var(--signal); } .t-buying_signal .type { color: var(--signal); }
  .t-stage_shift { border-left-color: var(--shift); } .t-stage_shift .type { color: var(--shift); }
  .empty { color: var(--muted); font-size: 18px; display: flex; align-items: center; justify-content: center; min-height: 170px; }
  .fb { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
  .fb button { background: #22303c; color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 6px 12px; font-size: 14px; cursor: pointer; }
  .fb button.on { background: var(--accent); color: #111; border-color: var(--accent); }
  .history { margin-top: 16px; display: grid; gap: 10px; }
  .history .cue { padding: 12px 14px; }
  .history .headline { font-weight: 600; }
  aside section { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; margin-bottom: 12px; }
  aside h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 8px; }
  ul.check { list-style: none; padding: 0; margin: 0; }
  ul.check li { padding: 2px 0; }
  ul.check li.ok::before { content: "\\2713  "; color: var(--signal); }
  ul.check li.no::before { content: "\\25CB  "; color: var(--muted); }
  .gaps li { color: var(--accent); }
  select, .seg button { background: #22303c; color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; font-size: 14px; width: 100%; }
  .seg { display: flex; gap: 6px; } .seg button { width: auto; flex: 1; cursor: pointer; } .seg button.on { background: var(--accent); color: #111; }
  .transcript { max-height: 260px; overflow: auto; font-size: 13px; }
  .transcript p { margin: 0 0 6px; } .transcript .host { color: var(--muted); }
  .warnline { color: var(--accent); font-size: 13px; margin-top: 6px; }
  label { display: block; font-size: 12px; color: var(--muted); margin: 8px 0 4px; }
</style>
</head>
<body>
<div class="warn" id="shareWarn"><span><strong>NOT FOR SHARING.</strong> In Zoom, share a single window, never "Entire screen". Keep this window on your second monitor.</span><button onclick="document.getElementById('shareWarn').remove()">Got it</button></div>
<header>
  <span><span class="dot" id="dot"></span><span class="who" id="who">Waiting for a Zoom call</span></span>
  <span class="muted" id="playbook"></span>
  <span class="muted" id="model"></span>
</header>
<main>
  <div>
    <div id="current"><div class="cue big empty">Listening. Cues appear here when they would help.</div></div>
    <div class="history" id="history"></div>
  </div>
  <aside>
    <section><h2>Coverage</h2><div id="stage" class="muted">Not assessed yet</div><ul class="check gaps" id="gaps"></ul><ul class="check" id="covered"></ul><ul class="check" id="missing"></ul></section>
    <section><h2>This call</h2>
      <label for="booking">Booking</label><select id="booking"></select>
      <label for="calltype">Call type</label>
      <select id="calltype"><option value="sme_discovery">SME discovery (15 min)</option><option value="enterprise_intro">Enterprise intro (20 min)</option><option value="other">Other (prospect playbook only)</option></select>
      <label>Cue rate</label><div class="seg" id="rate"><button data-r="conservative">Fewer</button><button data-r="balanced">Balanced</button><button data-r="proactive">More</button></div>
      <div id="warnings"></div>
    </section>
    <section><h2>Transcript</h2><div class="transcript" id="transcript"></div></section>
  </aside>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TYPE = { probe: 'Probe', objection: 'Objection', buying_signal: 'Buying signal', stage_shift: 'Move on' };
let S = { cues: [], turns: [], feedback: {}, state: null, bundle: null, candidates: [] };

function cueHtml(c, big) {
  const fb = S.feedback[c.id];
  const btn = (v, l) => '<button class="' + (fb === v ? 'on' : '') + '" onclick="feedback(\\'' + c.id + '\\',\\'' + v + '\\')">' + l + '</button>';
  return '<div class="cue t-' + esc(c.type) + (big ? ' big' : '') + '">' +
    '<div class="type">' + esc(TYPE[c.type] || c.type) + '</div>' +
    '<div class="headline">' + esc(c.headline) + '</div>' +
    '<div class="say">' + esc(c.say_this) + '</div>' +
    '<div class="meta">' + esc(c.why) + ' &middot; ' + esc(c.playbook_ref) + '</div>' +
    '<div class="fb">' + btn('used', 'Used it') + btn('useful', 'Useful') + btn('obvious', 'Obvious') + btn('useless', 'Useless') + '</div></div>';
}

function render() {
  const cues = S.cues.slice().reverse();
  $('current').innerHTML = cues[0] ? cueHtml(cues[0], true) : '<div class="cue big empty">Listening. Cues appear here when they would help.</div>';
  $('history').innerHTML = cues.slice(1, 6).map((c) => cueHtml(c, false)).join('');
  const st = S.state;
  $('stage').textContent = st ? 'Stage: ' + st.stage : 'Not assessed yet';
  $('gaps').innerHTML = st ? st.top_gaps.map((g) => '<li>Gap: ' + esc(g) + '</li>').join('') : '';
  $('covered').innerHTML = st ? st.covered.map((g) => '<li class="ok">' + esc(g) + '</li>').join('') : '';
  $('missing').innerHTML = st ? st.missing.map((g) => '<li class="no">' + esc(g) + '</li>').join('') : '';
  $('transcript').innerHTML = S.turns.slice(-30).map((t) => '<p class="' + t.role + '"><strong>' + esc(t.speaker) + ':</strong> ' + esc(t.text) + '</p>').join('');
  $('transcript').scrollTop = 1e9;
  const b = S.bundle;
  if (b) {
    $('who').textContent = b.label;
    $('playbook').textContent = b.playbookTitle ? 'Playbook: ' + b.playbookTitle : 'No prospect playbook';
    $('calltype').value = b.callType;
    $('warnings').innerHTML = (b.warnings || []).map((w) => '<div class="warnline">' + esc(w) + '</div>').join('');
  }
}

async function loadBookings() {
  const r = await fetch('/api/calls', { credentials: 'same-origin' });
  if (!r.ok) return;
  const recent = await r.json();
  const seen = new Set();
  const all = [...(S.candidates || []), ...recent].filter((c) => !seen.has(c.id) && seen.add(c.id));
  const cur = S.bundle && S.bundle.callId;
  $('booking').innerHTML = '<option value="">None (generic framework)</option>' + all.map((c) =>
    '<option value="' + c.id + '"' + (c.id === cur ? ' selected' : '') + '>' + esc(c.label) + (c.scheduledAt ? ' - ' + new Date(c.scheduledAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '') + (c.hasPlaybook ? '' : ' (no playbook)') + '</option>').join('');
}

function setRate(r) { document.querySelectorAll('#rate button').forEach((b) => b.classList.toggle('on', b.dataset.r === r)); }

const post = (url, body) => fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
window.feedback = (id, label) => { S.feedback[id] = label; render(); post('/api/feedback', { cueId: id, label }); };
$('booking').onchange = (e) => post('/api/call', { callId: e.target.value || null });
$('calltype').onchange = (e) => post('/api/call', { callType: e.target.value });
document.querySelectorAll('#rate button').forEach((b) => (b.onclick = () => { setRate(b.dataset.r); post('/api/settings', { cueRate: b.dataset.r }); }));

function connect() {
  const es = new EventSource('/events');
  es.addEventListener('snapshot', (m) => {
    const d = JSON.parse(m.data);
    setRate(d.cueRate);
    const s = d.session;
    if (!s) { $('dot').className = 'dot'; return; }
    $('dot').className = 'dot' + (s.ended ? '' : ' live');
    $('model').textContent = 'Model: ' + s.cueModel;
    S = { cues: s.cues, turns: s.turns, feedback: s.feedback, state: s.state, bundle: s.bundle, candidates: s.candidates };
    render(); loadBookings();
  });
  es.addEventListener('turn', (m) => { S.turns.push(JSON.parse(m.data).turn); render(); });
  es.addEventListener('cue', (m) => { S.cues.push(JSON.parse(m.data).cue); render(); });
  es.addEventListener('state', (m) => { S.state = JSON.parse(m.data).state; render(); });
  es.addEventListener('feedback', (m) => { const d = JSON.parse(m.data); S.feedback[d.cueId] = d.label; render(); });
  es.addEventListener('ended', () => { $('dot').className = 'dot'; });
  es.onerror = () => { $('dot').className = 'dot'; };
}
connect();
</script>
</body>
</html>`;
