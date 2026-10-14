/**
 * The inspector of `--inspect`, one self-contained document: no network, no
 * libraries. It draws the state the server streams and posts the three
 * actions. Text from the run reaches the page only through `textContent`.
 */

export const INSPECTOR_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>e2e inspector</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#1b1f24; --muted:#6a737d; --line:#d0d7de; --panel:#f6f8fa; --accent:#0969da; --ok:#1a7f37; --bad:#cf222e; --warn:#9a6700; --cur:#fff8c5; --curline:#bf8700; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#8b949e; --line:#30363d; --panel:#161b22; --accent:#4493f8; --ok:#3fb950; --bad:#f85149; --warn:#d29922; --cur:#3a2e0a; --curline:#d29922; } }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
  header { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--line); background: var(--panel); }
  button { font: inherit; padding: 6px 14px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  button.danger { color: var(--bad); }
  button:disabled { opacity: .45; cursor: default; }
  button kbd { font: 11px ui-monospace, monospace; opacity: .8; margin-left: 6px; }
  #status { margin-left: auto; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--line); font-size: 12px; }
  #status[data-phase=paused] { color: var(--warn); border-color: var(--warn); }
  #status[data-phase=running] { color: var(--accent); border-color: var(--accent); }
  #status[data-phase=finished] { color: var(--ok); border-color: var(--ok); }
  #status[data-phase=stopped] { color: var(--bad); border-color: var(--bad); }
  #now { padding: 8px 14px; border-bottom: 1px solid var(--line); min-height: 38px; }
  #now b { font-family: ui-monospace, monospace; }
  #now .where { color: var(--muted); font-family: ui-monospace, monospace; font-size: 12px; margin-left: 8px; }
  main { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  #file { padding: 4px 14px; color: var(--muted); font: 12px ui-monospace, monospace; border-bottom: 1px solid var(--line); }
  #code { flex: 1; min-height: 0; overflow: auto; margin: 0; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .ln { display: flex; white-space: pre; padding-right: 14px; }
  .ln .no { flex: none; width: 3.6em; text-align: right; padding-right: 10px; color: var(--muted); user-select: none; }
  .ln .mark { flex: none; width: 1.6em; text-align: center; user-select: none; }
  .ln.ok .mark { color: var(--ok); } .ln.bad { background: color-mix(in srgb, var(--bad) 14%, transparent); } .ln.bad .mark { color: var(--bad); }
  .ln.cur { background: var(--cur); box-shadow: inset 3px 0 0 var(--curline); } .ln.cur .mark { color: var(--curline); font-weight: 700; }
  #steps { flex: none; max-height: 34%; overflow: auto; border-top: 1px solid var(--line); background: var(--panel); }
  .st { display: flex; gap: 10px; padding: 3px 14px; cursor: pointer; font: 12px ui-monospace, monospace; }
  .st:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .st .i { flex: none; width: 1.6em; } .st .t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .st .d { flex: none; color: var(--muted); }
  .st.passed .i { color: var(--ok); } .st.failed .i, .st.timed-out .i, .st.blocked .i { color: var(--bad); } .st.waiting .i, .st.running .i { color: var(--curline); }
  #bar { display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: center; padding: 6px 14px; border-bottom: 1px solid var(--line); font-size: 12px; color: var(--muted); }
  #bar label { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; color: var(--fg); }
  #bar .count b { color: var(--fg); } #bar .ok { color: var(--ok); } #bar .bad { color: var(--bad); }
  .tg { display: flex; gap: 8px; align-items: center; padding: 5px 14px; border-top: 1px solid var(--line); background: var(--bg); cursor: pointer; font: 12px system-ui, sans-serif; position: sticky; top: 0; }
  .tg:first-child { border-top: 0; } .tg .arrow { flex: none; width: 1em; color: var(--muted); } .tg .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .tg .meta { flex: none; color: var(--muted); font: 11px ui-monospace, monospace; } .tg.cur { box-shadow: inset 3px 0 0 var(--curline); }
  .tg .si { flex: none; width: 1.4em; text-align: center; } .tg.passed .si, .tg.flaky .si { color: var(--ok); } .tg.failed .si, .tg.timed-out .si { color: var(--bad); } .tg.running .si { color: var(--curline); }
  .sub { padding: 2px 14px 2px 38px; color: var(--muted); font: 11px ui-monospace, monospace; }
  .st .auto { flex: none; color: var(--muted); font: 11px system-ui, sans-serif; border: 1px solid var(--line); border-radius: 999px; padding: 0 7px; }
  #err { color: var(--bad); padding: 0 14px 6px; font: 12px ui-monospace, monospace; white-space: pre-wrap; }
  #empty { padding: 24px 14px; color: var(--muted); }
</style>
</head>
<body>
<header>
  <button id="next" class="primary" disabled>Next step<kbd>c</kbd></button>
  <button id="test" disabled>Finish test<kbd>t</kbd></button>
  <button id="rest" disabled>Run the rest<kbd>r</kbd></button>
  <button id="stop" class="danger" disabled>Stop<kbd>q</kbd></button>
  <span id="status" data-phase="starting">connecting</span>
</header>
<div id="bar">
  <span class="count" id="progress"></span>
  <label><input type="checkbox" id="holdSetup"> Hold setup steps</label>
  <label><input type="checkbox" id="holdRetries"> Hold retries</label>
</div>
<div id="now"></div>
<main>
  <div id="file"></div>
  <div id="code"><div id="empty">Waiting for the first step…</div></div>
  <div id="err"></div>
  <div id="steps"></div>
</main>
<script>
(function () {
  var base = location.pathname;
  var state = null, sources = {}, shownFile = null, selected = null, expanded = {};
  var $ = function (id) { return document.getElementById(id); };
  function press(action) {
    fetch(base + 'press', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: action }) }).catch(function () {});
  }
  $('next').onclick = function () { press('next'); };
  $('test').onclick = function () { press('test'); };
  $('rest').onclick = function () { press('rest'); };
  function setHold(change) {
    fetch(base + 'hold', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change) }).catch(function () {});
  }
  $('holdSetup').onchange = function () { setHold({ setup: this.checked }); };
  $('holdRetries').onchange = function () { setHold({ retries: this.checked }); };
  $('stop').onclick = function () { press('stop'); };
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'c' || e.key === 'n') press('next'); else if (e.key === 't') press('test'); else if (e.key === 'r') press('rest'); else if (e.key === 'q') press('stop');
  });
  function mark(status) { return status === 'passed' ? '\\u2713' : status === 'waiting' || status === 'running' ? '\\u25B6' : status ? '\\u2717' : ''; }
  function cls(status) { return status === 'passed' ? 'ok' : status === 'waiting' || status === 'running' ? 'cur' : status ? 'bad' : ''; }
  function stepText(s) { return s.api + (s.label ? ' ' + s.label : ''); }
  function fetchSource(file) {
    if (sources[file] !== undefined) return;
    sources[file] = null;
    fetch(base + 'source?file=' + encodeURIComponent(file)).then(function (r) { return r.ok ? r.text() : Promise.reject(); }).then(function (t) { sources[file] = t.split('\\n'); render(); }).catch(function () { sources[file] = ['(source not available)']; render(); });
  }
  function render() {
    if (!state) return;
    var steps = state.steps, cur = state.current === undefined ? null : steps[state.current];
    var focus = selected !== null && steps[selected] ? steps[selected] : cur;
    var phase = state.phase;
    $('status').dataset.phase = phase;
    $('status').textContent = phase === 'paused' ? 'paused' : phase === 'running' ? (state.free ? 'running to the end' : 'running') : phase === 'finished' ? 'finished' : phase === 'stopped' ? 'stopped' : 'starting';
    var held = phase === 'paused';
    $('next').disabled = $('test').disabled = $('rest').disabled = $('stop').disabled = !held;
    $('holdSetup').checked = !!state.hold.setup; $('holdRetries').checked = !!state.hold.retries;
    var counts = { passed: 0, failed: 0 };
    state.tests.forEach(function (t) { if (t.status === 'passed' || t.status === 'flaky') counts.passed++; else if (t.status === 'failed' || t.status === 'timed-out') counts.failed++; });
    var prog = $('progress'); prog.textContent = '';
    var running = state.tests.filter(function (t) { return t.status === 'running'; })[0];
    var at = running ? state.tests.indexOf(running) + 1 : state.tests.length;
    var lead = document.createElement('span'); lead.className = 'count';
    var bold = document.createElement('b'); bold.textContent = 'Test ' + at + (state.total ? ' of ' + state.total : '');
    lead.appendChild(bold); prog.appendChild(lead);
    var ok = document.createElement('span'); ok.className = 'ok'; ok.textContent = '  \u2713 ' + counts.passed; prog.appendChild(ok);
    var bad = document.createElement('span'); bad.className = 'bad'; bad.textContent = '  \u2717 ' + counts.failed; prog.appendChild(bad);
    if (state.finishing) { var fin = document.createElement('span'); fin.textContent = '  \u00B7 finishing this test'; prog.appendChild(fin); }
    var now = $('now'); now.textContent = '';
    if (cur) {
      var lead = document.createElement('span');
      lead.textContent = (phase === 'paused' ? 'Next: ' : phase === 'running' ? 'Running: ' : 'Last: ') + 'step ' + cur.n + '  ';
      var b = document.createElement('b'); b.textContent = stepText(cur);
      var where = document.createElement('span'); where.className = 'where'; where.textContent = cur.file ? cur.file + (cur.line ? ':' + cur.line : '') : '';
      now.appendChild(lead); now.appendChild(b); now.appendChild(where);
      if (cur.test) { var t = document.createElement('div'); t.className = 'where'; t.style.marginLeft = '0'; t.textContent = cur.test; now.appendChild(t); }
    }
    var file = focus && focus.file;
    $('file').textContent = file || '';
    var code = $('code');
    if (file) {
      fetchSource(file);
      var lines = sources[file];
      if (lines) {
        var byLine = {};
        steps.forEach(function (s) { if (s.file === file && s.line && s.testId === focus.testId) byLine[s.line] = s; });
        var frag = document.createDocumentFragment(), focusRow = null;
        lines.forEach(function (text, i) {
          var no = i + 1, s = byLine[no], row = document.createElement('div');
          row.className = 'ln ' + (s ? cls(s.status) : '');
          var n = document.createElement('span'); n.className = 'no'; n.textContent = String(no);
          var m = document.createElement('span'); m.className = 'mark'; m.textContent = s ? mark(s.status) : '';
          var c = document.createElement('span'); c.textContent = text;
          row.appendChild(n); row.appendChild(m); row.appendChild(c); frag.appendChild(row);
          if (focus && focus.line === no) focusRow = row;
        });
        var top = code.scrollTop; code.textContent = ''; code.appendChild(frag);
        if (focusRow) { var r = focusRow.getBoundingClientRect(), cr = code.getBoundingClientRect(); if (r.top < cr.top + 40 || r.bottom > cr.bottom - 40) focusRow.scrollIntoView({ block: 'center' }); else code.scrollTop = top; }
      }
    } else { code.textContent = ''; var e = document.createElement('div'); e.id = 'empty'; e.textContent = 'Waiting for the first step\\u2026'; code.appendChild(e); }
    $('err').textContent = focus && focus.error ? focus.error : '';
    var list = $('steps'); list.textContent = '';
    var testByKey = {}; state.tests.forEach(function (t) { testByKey[t.key] = t; });
    var targetNames = {}; state.steps.forEach(function (s) { targetNames[s.target] = true; }); var severalTargets = Object.keys(targetNames).length > 1;
    var curKey = cur ? cur.testKey : null, groupKey = null, groupOpen = true, lastAttempt = 0;
    steps.forEach(function (s, i) {
      if (s.testKey !== groupKey) {
        groupKey = s.testKey; lastAttempt = 0;
        var t = testByKey[groupKey] || { status: 'running', title: s.test, file: s.file };
        var open = expanded[groupKey] !== undefined ? expanded[groupKey] : (groupKey === curKey || t.status === 'running');
        groupOpen = open;
        var head = document.createElement('div'); head.className = 'tg ' + t.status + (groupKey === curKey ? ' cur' : '');
        var ar = document.createElement('span'); ar.className = 'arrow'; ar.textContent = open ? '\u25BE' : '\u25B8';
        var si = document.createElement('span'); si.className = 'si'; si.textContent = t.status === 'running' ? '\u25B6' : t.status === 'passed' || t.status === 'flaky' ? '\u2713' : t.status === 'skipped' ? '\u2013' : '\u2717';
        var nm = document.createElement('span'); nm.className = 'name'; nm.textContent = (severalTargets ? '[' + s.target + '] ' : '') + (s.setup ? '[setup] ' : '') + (t.title || s.test);
        var mt = document.createElement('span'); mt.className = 'meta'; mt.textContent = t.file || '';
        head.appendChild(ar); head.appendChild(si); head.appendChild(nm); head.appendChild(mt);
        var key = groupKey;
        head.onclick = function () { expanded[key] = !open; render(); };
        list.appendChild(head);
      }
      if (!groupOpen) return;
      if (s.attempt !== lastAttempt || (s.attempt > 0 && lastAttempt === 0)) { lastAttempt = s.attempt; var sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = 'retry ' + s.attempt; list.appendChild(sub); }
      var row = document.createElement('div'); row.className = 'st ' + s.status;
      var ic = document.createElement('span'); ic.className = 'i'; ic.textContent = mark(s.status) || '\u00B7';
      var tx = document.createElement('span'); tx.className = 't'; tx.textContent = s.n + '. ' + stepText(s);
      row.appendChild(ic); row.appendChild(tx);
      if (s.auto && s.auto !== 'rest') { var au = document.createElement('span'); au.className = 'auto'; au.textContent = s.auto === 'first' ? 'first step' : s.auto === 'test' ? 'finishing test' : s.auto; row.appendChild(au); }
      var d = document.createElement('span'); d.className = 'd'; d.textContent = s.durationMs !== undefined ? s.durationMs + ' ms' : '';
      row.appendChild(d);
      row.onclick = function () { selected = selected === i ? null : i; render(); };
      list.appendChild(row);
    });
    if (selected === null) list.scrollTop = list.scrollHeight;
  }
  var source = new EventSource(base + 'events');
  source.onmessage = function (e) { state = JSON.parse(e.data); if (state.phase === 'paused' || state.phase === 'running') selected = null; render(); };
  source.onerror = function () { $('status').dataset.phase = 'stopped'; $('status').textContent = 'disconnected'; $('next').disabled = $('test').disabled = $('rest').disabled = $('stop').disabled = true; };
})();
</script>
</body>
</html>
`;
