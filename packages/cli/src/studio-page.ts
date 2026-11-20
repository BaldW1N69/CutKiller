/** The single page of `cutkiller studio` (served by studio.ts; no build step, no dependency). */
export const STUDIO_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CutKiller Studio</title>
<style>
:root {
  --bg: #f5f5f7; --panel: #ffffff; --fg: #16171b; --muted: #5f6372; --line: #dcdde3;
  --accent: #d7263d; --accent-fg: #ffffff; --drop: #9a9ca6; --ok: #1f8a4c; --warn: #b7791f;
  --mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) { :root {
  --bg: #111216; --panel: #1a1c22; --fg: #eceef3; --muted: #a0a4b2; --line: #2d3039;
  --accent: #ff5468; --accent-fg: #16171b; --drop: #6b6f7c; --ok: #4cc982; --warn: #e5a94a;
  color-scheme: dark; } }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 var(--sans); }
header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 2; }
h1 { font-size: 16px; margin: 0; letter-spacing: .01em; }
h1 b { color: var(--accent); }
.stats { color: var(--muted); font: 12px var(--mono); }
.spacer { flex: 1; }
button { font: 600 13px var(--sans); border-radius: 6px; padding: 8px 14px; border: 1px solid var(--line); background: var(--panel); color: var(--fg); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
button:disabled { opacity: .5; cursor: progress; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
main { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 420px); gap: 16px; padding: 16px; max-width: 1400px; margin: 0 auto; }
@media (max-width: 820px) { main { grid-template-columns: 1fr; } aside { order: -1; } }
.transcript { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.tools { display: flex; gap: 8px; flex-wrap: wrap; padding: 10px 12px; border-bottom: 1px solid var(--line); align-items: center; }
.tools input[type=search] { flex: 1; min-width: 160px; padding: 7px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); font: inherit; }
ol { list-style: none; margin: 0; padding: 0; max-height: calc(100vh - 190px); overflow-y: auto; }
li { display: grid; grid-template-columns: auto 64px minmax(0, 1fr); gap: 10px; align-items: baseline; padding: 8px 12px; border-bottom: 1px solid var(--line); cursor: pointer; }
li:hover { background: var(--bg); }
li .tc { font: 12px var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; }
li.dropped .text { color: var(--drop); text-decoration: line-through; }
li.source { display: block; cursor: default; font: 600 12px var(--mono); color: var(--muted); text-transform: uppercase; letter-spacing: .06em; background: var(--bg); }
aside { display: grid; gap: 12px; align-content: start; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px; display: grid; gap: 10px; min-width: 0; }
video { width: 100%; max-height: 60vh; background: #000; border-radius: 6px; }
.score { font: 700 28px var(--mono); }
.score.good { color: var(--ok); } .score.warn { color: var(--warn); }
.status { color: var(--muted); font-size: 13px; }
.status.error { color: var(--accent); }
ul.failed { margin: 0; padding-left: 18px; display: grid; gap: 6px; font-size: 13px; }
ul.failed code { font: 12px var(--mono); }
.empty { color: var(--muted); padding: 24px; text-align: center; }
.links { display: flex; gap: 12px; flex-wrap: wrap; font-size: 13px; }
a { color: var(--accent); }
</style>
</head>
<body>
<header>
  <h1>Cut<b>Killer</b> Studio</h1>
  <span class="stats" id="stats"></span>
  <span class="spacer"></span>
  <button id="draft" class="primary">Render draft</button>
  <button id="final">Render final</button>
</header>
<main>
  <section class="transcript" aria-label="Transcript">
    <div class="tools">
      <input type="search" id="filter" placeholder="Find words…" aria-label="Find words">
      <button id="all">Keep all</button>
      <button id="none">Drop all</button>
    </div>
    <ol id="list"><li class="empty">Loading the transcript…</li></ol>
  </section>
  <aside>
    <div class="card">
      <video id="video" controls playsinline hidden></video>
      <div class="empty" id="novideo">Untick the sentences you don't want, then render.</div>
      <div class="status" id="status" role="status"></div>
      <div class="links" id="links" hidden>
        <a href="/files/final.mp4" download>Video</a>
        <a href="/files/final.srt">Subtitles (.srt)</a>
        <a href="/files/quality.md">Quality report</a>
      </div>
    </div>
    <div class="card" id="qa" hidden>
      <div><span class="score" id="score"></span> <span class="status">/100 · <span id="coverage"></span> % of the rules evaluated</span></div>
      <ul class="failed" id="failed"></ul>
    </div>
  </aside>
</main>
<script>
const $ = (id) => document.getElementById(id);
let state = null;
let keep = new Set();
let polling = null;
const tc = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");

function renderList() {
  const q = $("filter").value.trim().toLowerCase();
  const list = $("list");
  list.textContent = "";
  let source = null;
  for (const s of state.sentences) {
    if (q && !s.text.toLowerCase().includes(q)) continue;
    if (s.source !== source) {
      source = s.source;
      const h = document.createElement("li");
      h.className = "source";
      h.textContent = source;
      list.append(h);
    }
    const li = document.createElement("li");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = "s" + s.id;
    box.checked = keep.has(s.id);
    box.setAttribute("aria-label", "Keep: " + s.text);
    const time = document.createElement("span");
    time.className = "tc";
    time.textContent = tc(s.start);
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = s.text;
    li.className = keep.has(s.id) ? "" : "dropped";
    li.append(box, time, text);
    const toggle = () => {
      if (keep.has(s.id)) keep.delete(s.id); else keep.add(s.id);
      box.checked = keep.has(s.id);
      li.className = keep.has(s.id) ? "" : "dropped";
      stats();
    };
    box.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    li.addEventListener("click", toggle);
    list.append(li);
  }
  if (!list.children.length) list.innerHTML = '<li class="empty">No sentence matches.</li>';
  stats();
}

function stats() {
  const kept = state.sentences.filter((s) => keep.has(s.id));
  const secs = kept.reduce((d, s) => d + (s.end - s.start), 0);
  $("stats").textContent = kept.length + "/" + state.sentences.length + " sentences · " + tc(secs) + " of speech kept";
}

function show() {
  const busy = state.busy;
  $("draft").disabled = busy;
  $("final").disabled = busy;
  $("status").className = "status" + (state.error ? " error" : "");
  $("status").textContent = busy ? "Editing, rendering and checking… (about 1–3× the kept duration)" : state.error ? state.error : "";
  if (state.video) {
    const v = $("video");
    const src = "/files/" + state.video;
    if (!v.src.endsWith(src)) v.src = src;
    v.hidden = false;
    $("novideo").hidden = true;
    $("links").hidden = false;
  }
  if (state.report) {
    $("qa").hidden = false;
    $("score").textContent = state.report.score;
    $("score").className = "score " + (state.report.score >= 97 ? "good" : "warn");
    $("coverage").textContent = state.report.coverage;
    const ul = $("failed");
    ul.textContent = "";
    if (!state.report.failed.length) {
      const li = document.createElement("li");
      li.textContent = "Every evaluated rule passes.";
      ul.append(li);
    }
    for (const f of state.report.failed) {
      const li = document.createElement("li");
      li.innerHTML = "<code></code> <span></span>";
      li.children[0].textContent = f.id;
      li.children[1].textContent = f.title + (f.first ? " — " + f.first : "");
      ul.append(li);
    }
  }
}

async function refresh() {
  state = await (await fetch("/api/state")).json();
  show();
  if (!state.busy && polling) { clearInterval(polling); polling = null; }
}

async function render(final) {
  const r = await fetch("/api/render", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keep: [...keep], final }) });
  if (!r.ok) { $("status").textContent = (await r.json()).error; return; }
  state.busy = true;
  show();
  polling = polling || setInterval(refresh, 1500);
}

$("draft").addEventListener("click", () => render(false));
$("final").addEventListener("click", () => render(true));
$("all").addEventListener("click", () => { keep = new Set(state.sentences.map((s) => s.id)); renderList(); });
$("none").addEventListener("click", () => { keep = new Set(); renderList(); });
$("filter").addEventListener("input", renderList);

(async () => {
  await refresh();
  keep = new Set(state.keep);
  renderList();
  if (state.busy) polling = setInterval(refresh, 1500);
})();
</script>
</body>
</html>
`;
