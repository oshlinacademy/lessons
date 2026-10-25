// Lessons app.
// Content comes from lessons.json (the subject playlists) and links.json (the Library).
// Progress is saved on this phone for now; it moves to Supabase once login is added.

// ---------- Saving ----------

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  }
};

let progress = Object.assign(
  { done: {}, plans: {}, checkins: {}, setAside: {}, math: {} },
  new URLSearchParams(location.search).get("preview") ? {} : store.get("progress", {})
);
// done:     { itemId: "2026-11-02" }       when each item was finished
// plans:    { "2026-11-02": [itemId, …] }   the need-to-do list each school day
// checkins: { "2026-11-02": { answers: [], voice: true, sentAt } }
// setAside: { "2026-11-02": [itemId] }      math skills he stopped on for the day (not finished, not carried)
// math:     { skillId: { stage: "learning" | "practicing" | "got", tries: [{ day, kind, right, total }] } }
function save() {
  if (previewDate || account.role === "parent") return; // previews and parents only look
  store.set("progress", progress);
  schedulePush();
}

// ---------- Content ----------

const SUBJECT_NAMES = {
  civics: "Civics", reading: "Reading", math: "Math", worldHistory: "World history",
  science: "Science", writing: "Writing", currentEvents: "Current events",
  lifeSkills: "Life skills", criticalThinking: "Critical thinking"
};
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// Preview: add ?preview=mon (or tue … fri) to the address to see that school day.
// Nothing is saved and nobody needs to sign in.
const previewKey = new URLSearchParams(location.search).get("preview");
const previewDate = (() => {
  const target = DAY_KEYS.indexOf(previewKey);
  if (target < 1 || target > 5) return null;
  const d = new Date();
  d.setDate(d.getDate() + ((target - d.getDay() + 7) % 7));
  return d;
})();
function today() { return previewDate ? new Date(previewDate) : new Date(); }

let content = { rotation: {}, checkinQuestions: [], subjects: {} };
let links = [];
const byId = {}; // itemId -> { item, subject }

function subjectName(key) { return SUBJECT_NAMES[key] || key; }

async function loadJSON(file) {
  const res = await fetch(file, { cache: "no-cache" });
  if (!res.ok) throw new Error(file + " could not load");
  return res.json();
}

// ---------- Dates ----------

function isoDate(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function weekNumber(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
}
function niceDate(d) {
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// ---------- Today's plan ----------

// Which subjects today: "lifeSkills|criticalThinking" alternates week to week.
function subjectsFor(d) {
  return (content.rotation[DAY_KEYS[d.getDay()]] || []).map(s => {
    const options = s.split("|");
    return options[weekNumber(d) % options.length];
  });
}

function isDone(id) { return !!progress.done[id]; }

// Finished for the day's list: done, or a math skill he put down for today.
function offList(id, day = isoDate(today())) {
  return isDone(id) || (progress.setAside[day] || []).includes(id);
}

function nextInSubject(subject, skip) {
  return (content.subjects[subject] || []).find(item => !isDone(item.id) && !skip.has(item.id));
}

// Builds today's need-to-do list once per day: unfinished items from the last
// school day go first, then the next undone item from each of today's subjects.
function todayPlan() {
  const now = today();
  const day = isoDate(now);
  if (subjectsFor(now).length === 0) return null; // weekend

  if (!progress.plans[day]) {
    const lastDay = Object.keys(progress.plans).filter(d => d < day).sort().pop();
    const carried = lastDay ? progress.plans[lastDay].filter(id => byId[id] && !offList(id, lastDay)) : [];
    const plan = [...carried];
    for (const subject of subjectsFor(now)) {
      const next = nextInSubject(subject, new Set(plan));
      if (next) plan.push(next.id);
    }
    progress.plans[day] = plan;
    save();
  }
  return progress.plans[day].filter(id => byId[id]);
}

function checkinDone(day = isoDate(today())) { return !!(progress.checkins[day] || {}).sentAt; }

// ---------- Small helpers ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function youtubeId(url) {
  const m = String(url || "").match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}
function vimeoId(url) {
  const m = String(url || "").match(/vimeo\.com\/(?:video\/)?(\d+)/);
  return m ? m[1] : null;
}

// For math, the video lives in item.video; everything else uses item.url.
function mainUrl(item) { return item.video ? item.video.url : item.url; }
function minutesOf(item) { return item.minutes || (item.video && item.video.minutes) || 0; }
function titleOf(item) { return item.title || item.skill || ""; }
function kindOf(item) {
  if (item.video) return "Video";
  return { video: "Video", audio: "Audio", reading: "Reading", podcast: "Podcast", course: "Course" }[item.type] || "Site";
}

// The video's own picture when there is one; otherwise a cover with the title in big type.
function thumbSrc(item) {
  const t = item.thumb;
  if (t && /^[\w-]{11}$/.test(t)) return `https://i.ytimg.com/vi/${t}/hqdefault.jpg`;
  if (t && /^https:\/\//.test(t)) return t;
  const yt = youtubeId(mainUrl(item));
  return yt ? `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` : null;
}

function thumb(item, { play = false, tag = true } = {}) {
  const src = thumbSrc(item);
  const img = src ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()">` : "";
  const mins = minutesOf(item) ? " · " + minutesOf(item) + " min" : "";
  return `<div class="thumb"><span class="cover">${esc(titleOf(item))}</span>${img}${tag ? `<span class="tag">${kindOf(item)}${mins}</span>` : ""}${play && (kindOf(item) === "Video" || kindOf(item) === "Audio") ? `<div class="play"></div>` : ""}</div>`;
}

function player(url, title) {
  const yt = youtubeId(url);
  if (yt) return `<div class="player"><iframe src="https://www.youtube-nocookie.com/embed/${yt}?rel=0&playsinline=1" title="${esc(title)}" allow="fullscreen; picture-in-picture; encrypted-media" allowfullscreen></iframe></div>`;
  const vm = vimeoId(url);
  if (vm) return `<div class="player"><iframe src="https://player.vimeo.com/video/${vm}" title="${esc(title)}" allow="fullscreen; picture-in-picture" allowfullscreen></iframe></div>`;
  if (/\.(mp3|m4a|ogg|wav)(\?|$)/i.test(url || "")) return `<audio controls preload="none" src="${esc(url)}"></audio>`;
  return "";
}

// ---------- Screens ----------

const view = document.getElementById("view");

function renderToday() {
  const now = today();
  const plan = todayPlan();

  if (!plan) {
    view.innerHTML = `
      <div><div class="date">${esc(niceDate(now))}</div><div class="h">Weekend</div></div>
      <p class="read-txt">No lessons today. The Library is open if you want to explore.</p>
      <a class="btn" href="#/library">Open the Library</a>`;
    return;
  }

  const items = plan.map(id => byId[id]);
  const steps = plan.length + 1; // the items plus the check-in
  const finished = plan.filter(id => offList(id)).length + (checkinDone() ? 1 : 0);
  const upNext = items.find(x => !offList(x.item.id));
  const allDone = finished === steps;

  let top = "";
  if (upNext) {
    top = `
      <a class="hero" href="#/lesson/${encodeURIComponent(upNext.item.id)}">
        ${thumb(upNext.item, { play: true })}
        <div class="cap"><span class="subj">${esc(subjectName(upNext.subject))} · up next</span><span class="t">${esc(titleOf(upNext.item))}</span></div>
      </a>`;
  } else if (!checkinDone()) {
    top = `<a class="btn" href="#/checkin">Start your check-in</a>`;
  } else {
    top = `
      <div class="card"><span class="lbl">All done for today</span><p class="read-txt">Nice work. Free pick is open: anything from the Library.</p></div>
      <a class="btn" href="#/library">Pick something</a>`;
  }

  const queue = items.filter(x => x !== upNext).map(({ item, subject }) => `
    <a class="qrow ${offList(item.id) ? "done" : ""}" href="#/lesson/${encodeURIComponent(item.id)}">
      ${thumb(item, { tag: false })}
      <div class="txt"><span class="subj">${esc(subjectName(subject))}</span><span class="t">${esc(titleOf(item))}</span>${minutesOf(item) ? `<span class="m">${minutesOf(item)} min</span>` : ""}</div>
      ${offList(item.id) ? `<span class="tick" aria-label="Done">✓</span>` : ""}
    </a>`).join("");

  const empty = plan.length === 0
    ? `<p class="read-txt">No new lessons on today's list yet. Do your check-in, then pick anything from the Library.</p>` : "";

  view.innerHTML = `
    <div><div class="date">${esc(niceDate(now))}</div><div class="h">${allDone ? "Done for<br>today" : "Today's<br>lineup"}</div></div>
    <div class="bar" aria-label="${finished} of ${steps} done"><i style="width:${Math.round(finished / steps * 100)}%"></i></div>
    ${empty}${top}
    ${queue ? `<div class="queue">${queue}</div>` : ""}
    ${allDone ? "" : `
    <div class="next">
      <a class="card ${checkinDone() ? "done" : ""}" href="#/checkin"><span class="lbl">Then</span><span class="t">Check-in</span></a>
      <a class="card" href="#/library"><span class="lbl">Last</span><span class="t">Free pick</span></a>
    </div>`}`;
}

function renderLesson(id) {
  const found = byId[id];
  if (!found) { location.hash = "#/today"; return; }
  const { item, subject } = found;
  if (subject === "math" && (item.check || []).length) { renderMath(id); return; }
  const url = mainUrl(item);
  const embedded = player(url, titleOf(item));
  const media = embedded || `
    <a href="${esc(url)}" target="_blank" rel="noopener">${thumb(item)}</a>`;

  const source = [item.source || (item.video && item.video.source), minutesOf(item) ? minutesOf(item) + " min" : ""].filter(Boolean).join(" · ");
  const open = !embedded && url ? `<a class="btn quiet" href="${esc(url)}" target="_blank" rel="noopener">Open ${kindOf(item) === "Reading" ? "the reading" : "it"}</a>` : "";
  const practice = item.practice && item.practice.url
    ? `<div class="key"><span class="lbl">Then practice</span><p class="read-txt">Try some problems${item.practice.source ? " on " + esc(item.practice.source) : ""}. Take your time.</p></div>
       <a class="btn quiet" href="${esc(item.practice.url)}" target="_blank" rel="noopener">Open practice</a>` : "";

  view.innerHTML = `
    <a class="back" href="#/today">‹ Today</a>
    ${media}
    <div><span class="subj">${esc(subjectName(subject))}</span><div class="h sm">${esc(titleOf(item))}</div>${source ? `<div class="m" style="margin-top:6px">${esc(source)}</div>` : ""}</div>
    ${item.note ? `<div class="key"><span class="lbl">${{ Video: "Watch for", Audio: "Listen for" }[kindOf(item)] || "Look for"}</span><p class="read-txt">${esc(item.note)}</p></div>` : ""}
    <div class="stack">
      ${open}${practice}
      <button class="btn" id="done">${isDone(id) ? "Done ✓ · next" : "Done, next"}</button>
    </div>`;

  document.getElementById("done").addEventListener("click", () => {
    if (!isDone(id)) { progress.done[id] = isoDate(today()); save(); }
    const plan = todayPlan() || [];
    goNext();
  });
}

// After a step, go to the next unfinished item on today's list, then the check-in.
function goNext() {
  const next = (todayPlan() || []).find(x => !offList(x));
  location.hash = next ? "#/lesson/" + encodeURIComponent(next) : (checkinDone() ? "#/today" : "#/checkin");
}

// ---------- Math ----------
// Each skill: a quick check first (all right = skip ahead), otherwise the video,
// practice, then the check. About 7 in 10 right = Got it. He never sees a score;
// parents do. Missed questions get a calm "not yet" review.

const QUICK_COUNT = 3;
const GOT_IT = 0.7;
const STAGE_NAMES = { learning: "Learning", practicing: "Practicing", got: "Got it" };

let mathRun = null; // { id, step: "intro"|"quick"|"learn"|"check"|"skipped"|"gotit"|"notyet", qs, at, picks }

function mathState(id) { return progress.math[id] || null; }
function setStage(id, stage) {
  progress.math[id] = Object.assign({ tries: [] }, progress.math[id], { stage });
  save();
}
function quickQs(item) { return item.check.slice(0, QUICK_COUNT); }
function mainQs(item) { return item.check.length > QUICK_COUNT ? item.check.slice(QUICK_COUNT) : item.check; }

// Swap a skipped skill on today's list for the next math skill.
function replaceInPlan(id) {
  const day = isoDate(today());
  const plan = progress.plans[day];
  if (!plan) return null;
  const next = nextInSubject("math", new Set(plan));
  const i = plan.indexOf(id);
  if (i >= 0 && next) plan.splice(i + 1, 0, next.id);
  save();
  return next ? next.id : null;
}

function renderMath(id) {
  const { item } = byId[id];
  const state = mathState(id);
  if (!mathRun || mathRun.id !== id) {
    mathRun = { id, step: isDone(id) ? "gotit" : state ? "learn" : "intro" };
  }
  const r = mathRun;
  const head = `
    <a class="back" href="#/today">‹ Today</a>
    <div><span class="subj">Math · ${STAGE_NAMES[(mathState(id) || {}).stage] || "New skill"}</span><div class="h sm">${esc(titleOf(item))}</div></div>`;

  if (r.step === "intro") {
    view.innerHTML = `${head}
      <p class="read-txt">Start with ${QUICK_COUNT} quick questions. If you already know this, you'll skip straight to the next skill.</p>
      <button class="btn" id="go">Start quick check</button>`;
    document.getElementById("go").onclick = () => startQuestions("quick", quickQs(item));
    return;
  }

  if (r.step === "quick" || r.step === "check") {
    const q = r.qs[r.at];
    const bars = r.qs.map((_, i) => `<i class="${i <= r.at ? "on" : ""}"></i>`).join("");
    view.innerHTML = `${head}
      <div class="steps">${bars}</div>
      <div><div class="lbl">${r.step === "quick" ? "Quick check" : "Check"} · ${r.at + 1} of ${r.qs.length}</div><div class="t" style="font-size:20px;margin-top:6px">${esc(q.q)}</div></div>
      <div class="choices">${q.choices.map((c, i) => `<button class="choice" data-i="${i}">${esc(c)}</button>`).join("")}</div>`;
    view.querySelectorAll(".choice").forEach(b => b.onclick = () => {
      view.querySelectorAll(".choice").forEach(x => x.classList.toggle("on", x === b));
      r.picks[r.at] = Number(b.dataset.i);
      setTimeout(() => { r.at++; r.at < r.qs.length ? renderMath(id) : finishQuestions(id); }, 250);
    });
    return;
  }

  if (r.step === "skipped") {
    view.innerHTML = `${head}
      <div class="card"><span class="lbl">You've got this one</span><p class="read-txt">No need to study it. On to the next skill.</p></div>
      <button class="btn" id="go">${r.nextId ? "Next skill" : "Continue"}</button>`;
    document.getElementById("go").onclick = () => { mathRun = null; goNext(); };
    return;
  }

  if (r.step === "gotit") {
    view.innerHTML = `${head}
      <div class="card"><span class="lbl">Got it</span><p class="read-txt">This skill is done. Nice work.</p></div>
      <button class="btn" id="go">Done, next</button>`;
    document.getElementById("go").onclick = () => { mathRun = null; goNext(); };
    return;
  }

  if (r.step === "notyet") {
    const missed = r.qs.map((q, i) => ({ q, pick: r.picks[i] })).filter(x => x.pick !== x.q.answer);
    view.innerHTML = `${head}
      <div class="card"><span class="lbl">Not yet</span><p class="read-txt">Almost there. Look over these, then try again whenever you're ready, today or next time.</p></div>
      <div class="stack">${missed.map(({ q }) => `
        <div class="key"><span class="t" style="font-size:16px">${esc(q.q)}</span><p class="read-txt">Answer: ${esc(q.choices[q.answer])}</p></div>`).join("")}
      </div>
      <div class="stack">
        <button class="btn" id="again">Try the check again</button>
        <button class="btn quiet" id="rewatch">Watch the video again</button>
        <button class="btn quiet" id="later">Done for today</button>
      </div>`;
    document.getElementById("again").onclick = () => startQuestions("check", mainQs(item));
    document.getElementById("rewatch").onclick = () => { r.step = "learn"; renderMath(id); };
    document.getElementById("later").onclick = () => {
      const day = isoDate(today());
      progress.setAside[day] = [...new Set([...(progress.setAside[day] || []), id])];
      save();
      mathRun = null;
      goNext();
    };
    return;
  }

  // "learn": the video, then practice, then the check.
  const v = item.video || {};
  const embedded = player(v.url, titleOf(item));
  view.innerHTML = `${head}
    ${embedded || (v.url ? `<a href="${esc(v.url)}" target="_blank" rel="noopener">${thumb(item)}</a>` : "")}
    ${!embedded && v.url ? `<a class="btn quiet" href="${esc(v.url)}" target="_blank" rel="noopener">Open the video</a>` : ""}
    ${item.note ? `<div class="key"><span class="lbl">Watch for</span><p class="read-txt">${esc(item.note)}</p></div>` : ""}
    ${item.practice && item.practice.url ? `
      <div class="key"><span class="lbl">Then practice</span><p class="read-txt">Try some problems${item.practice.source ? " on " + esc(item.practice.source) : ""}. Take your time; mistakes here are how it sticks.</p></div>
      <a class="btn quiet" href="${esc(item.practice.url)}" target="_blank" rel="noopener">Open practice</a>` : ""}
    <button class="btn" id="go">I'm ready for the check</button>`;
  document.getElementById("go").onclick = () => startQuestions("check", mainQs(item));

  function startQuestions(kind, qs) {
    Object.assign(mathRun, { step: kind, qs, at: 0, picks: [] });
    renderMath(id);
  }
}

function finishQuestions(id) {
  const r = mathRun;
  const right = r.qs.filter((q, i) => r.picks[i] === q.answer).length;
  const total = r.qs.length;
  const day = isoDate(today());
  const state = Object.assign({ tries: [] }, progress.math[id]);
  state.tries.push({ day, kind: r.step, right, total });
  progress.math[id] = state;

  if (r.step === "quick") {
    if (right === total) {
      state.stage = "got";
      progress.done[id] = day;
      r.nextId = replaceInPlan(id);
      r.step = "skipped";
    } else {
      state.stage = "learning";
      r.step = "learn";
    }
  } else if (right / total >= GOT_IT) {
    state.stage = "got";
    progress.done[id] = day;
    r.step = "gotit";
  } else {
    state.stage = "practicing";
    r.step = "notyet";
  }
  save();
  renderMath(id);
}

// ---------- Check-in ----------

// 2 or 3 general questions a day, taken in turn from the rotating list.
function questionsFor(d) {
  const all = content.checkinQuestions || [];
  if (!all.length) return [];
  const count = Math.min(all.length, d.getDay() % 2 ? 3 : 2);
  const start = Math.floor(d.getTime() / 86400000) * 2;
  return Array.from({ length: count }, (_, i) => all[(start + i) % all.length]);
}

let checkinState = null; // { day, step, answers, voiceBlob }

function renderCheckin() {
  const now = today();
  const day = isoDate(now);
  const questions = questionsFor(now);
  if (!checkinState || checkinState.day !== day) {
    const saved = progress.checkins[day] || {};
    checkinState = { day, step: 0, answers: saved.answers || [], voiceBlob: null };
  }
  const s = checkinState;
  const total = questions.length + 1; // questions plus the voice note
  const bars = Array.from({ length: total }, (_, i) => `<i class="${i <= s.step ? "on" : ""}"></i>`).join("");

  if (checkinDone(day)) {
    view.innerHTML = `
      <a class="back" href="#/today">‹ Today</a>
      <div class="h sm">Check-in sent</div>
      <p class="read-txt">Thanks. Free pick is open now.</p>
      <a class="btn" href="#/library">Pick something</a>`;
    return;
  }

  if (s.step < questions.length) {
    view.innerHTML = `
      <a class="back" href="#/today">‹ Today</a>
      <div class="steps">${bars}</div>
      <div><div class="lbl">Question ${s.step + 1} of ${questions.length}</div><div class="t" style="font-size:20px;margin-top:6px">${esc(questions[s.step])}</div></div>
      <textarea id="answer" class="search" rows="4" placeholder="A sentence or two is plenty">${esc(s.answers[s.step] || "")}</textarea>
      <button class="btn" id="next">Next</button>`;
    const box = document.getElementById("answer");
    document.getElementById("next").addEventListener("click", () => {
      s.answers[s.step] = box.value.trim();
      s.step++;
      renderCheckin();
    });
    return;
  }

  view.innerHTML = `
    <a class="back" href="#/today">‹ Today</a>
    <div class="steps">${bars}</div>
    <div style="display:grid;gap:6px"><span class="lbl">Voice note · up to 60 sec</span><div class="t" style="font-size:20px">Tell us about one thing you learned today, in your own words.</div></div>
    <div class="mic">
      <button class="dot ${recording() ? "rec" : ""}" id="rec" aria-label="${recording() ? "Stop recording" : "Start recording"}"></button>
      <div style="display:grid;gap:4px;flex:1"><span class="t" id="rec-label">${recording() ? "Recording…" : s.voiceBlob ? "Recorded. Play it back below." : "Tap to record"}</span><span class="m" id="rec-time"></span></div>
    </div>
    <audio id="playback" controls ${s.voiceBlob ? "" : "hidden"}></audio>
    ${s.voiceBlob ? `<button class="btn quiet" id="redo">Record again</button>` : ""}
    <button class="btn" id="send" ${s.voiceBlob ? "" : "disabled"}>Send check-in</button>
    <p class="m" id="send-msg"></p>`;

  if (s.voiceBlob) document.getElementById("playback").src = URL.createObjectURL(s.voiceBlob);
  document.getElementById("rec").addEventListener("click", toggleRecording);
  const redo = document.getElementById("redo");
  if (redo) redo.addEventListener("click", () => { s.voiceBlob = null; renderCheckin(); });
  document.getElementById("send").addEventListener("click", async e => {
    e.target.disabled = true;
    e.target.textContent = "Sending…";
    let voicePath = null;
    if (db && s.voiceBlob && !previewDate) {
      voicePath = await uploadVoice(day, s.voiceBlob);
      if (!voicePath) {
        e.target.disabled = false;
        e.target.textContent = "Send check-in";
        document.getElementById("send-msg").textContent = "The voice note didn't send. Check the internet connection and try again.";
        return;
      }
    }
    progress.checkins[day] = { answers: s.answers, questions, voice: !!s.voiceBlob, voicePath, sentAt: new Date().toISOString() };
    save();
    renderCheckin();
  });
}

let recorder = null;
let recTimer = null;
function recording() { return !!(recorder && recorder.state === "recording"); }

async function toggleRecording() {
  if (recording()) { recorder.stop(); return; }
  const label = document.getElementById("rec-label");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    const started = Date.now();
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      clearInterval(recTimer);
      stream.getTracks().forEach(t => t.stop());
      checkinState.voiceBlob = new Blob(chunks, { type: recorder.mimeType || "audio/mp4" });
      renderCheckin();
    };
    recorder.start();
    renderCheckin();
    recTimer = setInterval(() => {
      const secs = Math.floor((Date.now() - started) / 1000);
      const t = document.getElementById("rec-time");
      if (t) t.textContent = "0:" + String(secs).padStart(2, "0") + " of 1:00";
      if (secs >= 60 && recording()) recorder.stop();
    }, 250);
  } catch (err) {
    if (label) label.textContent = "The microphone isn't available. Check this app's microphone permission in the phone's settings.";
  }
}

// ---------- Library ----------

let libSubject = "All";
let libQuery = "";

function linkSubject(l) { return l.subject || l.category || "Other"; }

function renderLibrary() {
  const subjects = ["All", ...new Set(links.map(linkSubject))];
  const q = libQuery.toLowerCase();
  const shown = links
    .map((l, i) => ({ ...l, i }))
    .filter(l => (libSubject === "All" || linkSubject(l) === libSubject) &&
      (!q || (l.title + " " + (l.note || l.description || "")).toLowerCase().includes(q)));

  const shelves = [...new Set(shown.map(linkSubject))].map(s => `
    <div class="shelf">
      <span class="subj">${esc(s)}</span>
      <div class="shelf-row">
        ${shown.filter(l => linkSubject(l) === s).map(l => `
          <a class="item" href="${youtubeId(l.url) ? "#/watch/" + l.i : esc(l.url)}" ${youtubeId(l.url) ? "" : `target="_blank" rel="noopener"`}>
            ${thumb(l)}
            <span class="t">${esc(l.title)}</span>
            ${l.note || l.description ? `<span class="m">${esc(l.note || l.description)}</span>` : ""}
          </a>`).join("")}
      </div>
    </div>`).join("");

  view.innerHTML = `
    <div class="h sm">Library</div>
    <input id="search" class="search" type="search" placeholder="Search videos, podcasts, sites" aria-label="Search the Library" value="${esc(libQuery)}">
    <div class="chips">${subjects.map(s => `<button class="chip ${s === libSubject ? "on" : ""}" data-s="${esc(s)}">${esc(s)}</button>`).join("")}</div>
    ${shelves || `<p class="m">Nothing matches that search.</p>`}`;

  const box = document.getElementById("search");
  box.addEventListener("input", () => {
    libQuery = box.value;
    renderLibrary();
    const again = document.getElementById("search");
    again.focus();
    again.setSelectionRange(again.value.length, again.value.length);
  });
  view.querySelectorAll(".chip").forEach(c => c.addEventListener("click", () => { libSubject = c.dataset.s; renderLibrary(); }));
}

function renderWatch(i) {
  const l = links[i];
  if (!l) { location.hash = "#/library"; return; }
  view.innerHTML = `
    <a class="back" href="#/library">‹ Library</a>
    ${player(l.url, l.title)}
    <div><span class="subj">${esc(linkSubject(l))}</span><div class="h sm">${esc(l.title)}</div></div>
    ${l.note || l.description ? `<p class="read-txt">${esc(l.note || l.description)}</p>` : ""}`;
}

// ---------- Progress ----------

function renderProgress() {
  const now = today();
  const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const weekStart = isoDate(monday);

  const doneIds = Object.keys(progress.done).filter(id => byId[id]);
  const thisWeek = doneIds.filter(id => progress.done[id] >= weekStart);
  const mins = thisWeek.reduce((sum, id) => sum + minutesOf(byId[id].item), 0);
  const time = mins >= 60 ? Math.floor(mins / 60) + "h " + (mins % 60) + "m" : mins + "m";

  const rows = Object.keys(content.subjects).map(s => {
    const list = content.subjects[s] || [];
    if (!list.length) return "";
    const n = list.filter(x => isDone(x.id)).length;
    return `<div class="prow"><div class="top"><span class="t" style="font-size:15px">${esc(subjectName(s))}</span><span class="m">${n} of ${list.length}</span></div><div class="bar"><i style="width:${Math.round(n / list.length * 100)}%"></i></div></div>`;
  }).join("");

  const recent = Object.keys(progress.checkins).filter(d => progress.checkins[d].sentAt).sort().reverse().slice(0, 5).map(d => {
    const c = progress.checkins[d];
    const answered = (c.answers || []).filter(Boolean).length;
    return `<div class="prow" style="border-bottom:1px solid var(--line);padding-bottom:8px"><div class="top"><span>${esc(niceDate(new Date(d + "T12:00")))}</span><span class="m">${answered} answered${c.voice ? " · voice note" : ""}</span></div></div>`;
  }).join("");

  const light = document.documentElement.dataset.theme === "light";
  view.innerHTML = `
    <div class="h sm">Progress</div>
    <div class="stats">
      <div class="card"><span class="num">${time}</span><span class="m">This week</span></div>
      <div class="card"><span class="num">${doneIds.length}</span><span class="m">Lessons done</span></div>
    </div>
    <div class="rows"><span class="lbl">By subject</span>${rows || `<p class="m">Lessons will show here once they're added.</p>`}</div>
    <div class="rows"><span class="lbl">Recent check-ins</span>${recent || `<p class="m">None yet.</p>`}</div>
    <div class="rows"><span class="lbl">Look</span>
      <div class="toggle">
        <button class="chip ${light ? "" : "on"}" data-theme="dark">Dark</button>
        <button class="chip ${light ? "on" : ""}" data-theme="light">Light</button>
      </div>
    </div>
    ${db ? `<p class="m">Signed in as ${esc(account.email)}.</p><button class="btn quiet" id="signout">Sign out</button>`
         : `<p class="m">Progress is saved on this phone for now.</p>`}`;

  const out = document.getElementById("signout");
  if (out) out.addEventListener("click", async () => {
    await db.auth.signOut();
    try { localStorage.removeItem("progress"); } catch { /* storage unavailable */ }
    location.hash = "#/today";
    location.reload();
  });

  view.querySelectorAll("[data-theme]").forEach(b => b.addEventListener("click", () => {
    document.documentElement.dataset.theme = b.dataset.theme;
    try { localStorage.setItem("theme", b.dataset.theme); } catch { /* storage unavailable */ }
    document.querySelector('meta[name="theme-color"]').content = b.dataset.theme === "light" ? "#f2f1ee" : "#111213";
    renderProgress();
  }));
}

// ---------- Login and syncing (Supabase) ----------
// With config.js filled in, everyone signs in once per phone and stays signed in.
// His progress is copied to Supabase after every change, so it follows him to any
// phone. Parent logins see his progress, check-ins and voice notes.

const cfg = window.APP_CONFIG || {};
const db = cfg.supabaseUrl && cfg.supabaseKey && window.supabase
  ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey)
  : null;
const account = { role: "local", id: null, email: "" };
const family = { updated: null, none: false };
const nav = document.querySelector(".nav");

async function signIn() {
  const { data } = await db.auth.getSession();
  if (data.session) await afterLogin(data.session.user);
  else renderLogin();
}

function renderLogin(message = "") {
  nav.hidden = true;
  view.innerHTML = `
    <div class="h">Sign in</div>
    <p class="read-txt">You only need to do this once on this phone.</p>
    <form id="login" class="stack">
      <input class="search" type="email" name="email" placeholder="Email" autocomplete="username" required>
      <input class="search" type="password" name="password" placeholder="Password" autocomplete="current-password" required>
      <button class="btn">Sign in</button>
      <p class="m" id="login-msg">${esc(message)}</p>
    </form>`;
  document.getElementById("login").addEventListener("submit", async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    document.getElementById("login-msg").textContent = "Signing in…";
    const { data, error } = await db.auth.signInWithPassword({ email: f.get("email").trim(), password: f.get("password") });
    if (error) {
      document.getElementById("login-msg").textContent = /fetch|network/i.test(error.message)
        ? "No internet connection. Try again when you're online."
        : "That email and password didn't match. Check them and try again.";
      return;
    }
    await afterLogin(data.user);
  });
}

async function afterLogin(user) {
  account.id = user.id;
  account.email = user.email;
  nav.hidden = false;

  // Saved progress on this phone belongs to whoever signed in last.
  if (store.get("progressOwner", null) !== user.id) {
    progress = { done: {}, plans: {}, checkins: {}, setAside: {}, math: {} };
    try { localStorage.removeItem("progress"); } catch { /* storage unavailable */ }
    store.set("progressOwner", user.id);
  }

  let parent = store.get("role", null) === "parent";
  try {
    const { data, error } = await db.rpc("is_parent");
    if (!error) { parent = !!data; store.set("role", parent ? "parent" : "student"); }
  } catch { /* offline: use the role saved last time */ }

  if (parent) {
    account.role = "parent";
    document.querySelector('.nav a[data-tab="today"]').textContent = "Overview";
    await loadFamily();
  } else {
    account.role = "student";
    await pull();
  }
  route();
}

// Combines what's on this phone with what's saved online, keeping everything finished in either.
function merge(a, b) {
  const out = {
    done: { ...b.done, ...a.done },
    plans: { ...b.plans },
    checkins: { ...b.checkins },
    setAside: { ...b.setAside },
    math: { ...b.math }
  };
  for (const [day, ids] of Object.entries(a.plans || {})) out.plans[day] = [...new Set([...(out.plans[day] || []), ...ids])];
  for (const [day, c] of Object.entries(a.checkins || {})) if (c.sentAt || !(out.checkins[day] || {}).sentAt) out.checkins[day] = c;
  for (const [day, ids] of Object.entries(a.setAside || {})) out.setAside[day] = [...new Set([...(out.setAside[day] || []), ...ids])];
  for (const [id, m] of Object.entries(a.math || {})) {
    if (!out.math[id] || (m.tries || []).length >= (out.math[id].tries || []).length) out.math[id] = m;
  }
  return out;
}

async function pull() {
  try {
    const { data, error } = await db.from("progress").select("data").eq("user_id", account.id).maybeSingle();
    if (error) return;
    if (data) progress = merge(progress, Object.assign({ done: {}, plans: {}, checkins: {}, setAside: {}, math: {} }, data.data));
    store.set("progress", progress);
    push();
  } catch { /* offline: carry on with this phone's copy */ }
}

let pushTimer = null;
function schedulePush() {
  if (!db || account.role !== "student") return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(push, 1500);
}
async function push() {
  if (!db || account.role !== "student") return;
  try {
    await db.from("progress").upsert({ user_id: account.id, data: progress, updated_at: new Date().toISOString() });
  } catch { /* offline: sent again after the next change or when back online */ }
}
window.addEventListener("online", schedulePush);

async function uploadVoice(day, blob) {
  const ext = /mp4|m4a|aac/.test(blob.type) ? "m4a" : /ogg/.test(blob.type) ? "ogg" : "webm";
  const path = `${account.id}/${day}.${ext}`;
  try {
    const { error } = await db.storage.from("voice").upload(path, blob, { upsert: true, contentType: blob.type || undefined });
    return error ? null : path;
  } catch { return null; }
}

// ---------- Parent view ----------

async function loadFamily() {
  try {
    const { data, error } = await db.from("progress").select("user_id, data, updated_at").neq("user_id", account.id).order("updated_at", { ascending: false }).limit(1);
    if (error) throw error;
    family.none = !data.length;
    if (data.length) {
      progress = Object.assign({ done: {}, plans: {}, checkins: {}, setAside: {}, math: {} }, data[0].data);
      family.updated = data[0].updated_at;
      store.set("familyCopy", { progress, updated: family.updated });
    }
  } catch {
    const copy = store.get("familyCopy", null); // offline: last copy seen
    if (copy) { progress = copy.progress; family.updated = copy.updated; }
  }
}

// A need-to-do item still undone after two school days in a row.
function skippedItems() {
  const day = isoDate(today());
  const days = Object.keys(progress.plans).filter(d => d < day).sort().slice(-2);
  if (days.length < 2) return [];
  const [first, second] = days;
  return progress.plans[second].filter(id =>
    byId[id] && progress.plans[first].includes(id) &&
    !(progress.done[id] && progress.done[id] <= second) &&
    !(progress.setAside[second] || []).includes(id));
}

function dayStatus(day) {
  const plan = progress.plans[day];
  if (!plan) return "";
  const finished = plan.filter(id => offList(id, day)).length + (checkinDone(day) ? 1 : 0);
  return finished === plan.length + 1 ? "full" : finished ? "part" : "";
}

async function renderParent() {
  const now = today();
  const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const strip = ["M", "T", "W", "T", "F"].map((letter, i) => {
    const d = new Date(monday); d.setDate(monday.getDate() + i);
    const day = isoDate(d);
    return `<div class="day ${dayStatus(day)} ${day === isoDate(now) ? "today" : ""}"><span>${letter}</span></div>`;
  }).join("");

  const flags = skippedItems().map(id => `
    <div class="flag"><span class="lbl">Skipped two days running</span><span class="t">${esc(subjectName(byId[id].subject))}: ${esc(titleOf(byId[id].item))}</span></div>`).join("");

  const mathList = content.subjects.math || [];
  const current = mathList.find(x => !isDone(x.id));
  const got = mathList.filter(x => isDone(x.id)).length;
  const stage = current ? (STAGE_NAMES[(progress.math[current.id] || {}).stage] || "Not started") : "";
  const tries = Object.entries(progress.math).filter(([id]) => byId[id]).flatMap(([id, m]) =>
    (m.tries || []).map(t => ({ ...t, title: titleOf(byId[id].item) }))).sort((a, b) => b.day.localeCompare(a.day)).slice(0, 20);
  const scores = tries.map(t => `
    <div class="prow"><div class="top"><span>${esc(t.title)}</span><span class="m">${t.kind === "quick" ? "Quick check" : "Check"} · ${t.right}/${t.total} · ${esc(niceDate(new Date(t.day + "T12:00")))}</span></div></div>`).join("");

  const lastDay = Object.keys(progress.checkins).filter(d => progress.checkins[d].sentAt).sort().pop();
  const last = lastDay ? progress.checkins[lastDay] : null;
  const answers = last ? (last.questions || []).map((q, i) => `
    <div class="key"><span class="lbl">${esc(q)}</span><p class="read-txt">${esc((last.answers || [])[i] || "No answer")}</p></div>`).join("") : "";

  view.innerHTML = `
    <div><div class="date">${family.updated ? "Updated " + esc(new Date(family.updated).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })) : ""}</div><div class="h">Overview</div></div>
    ${family.none ? `<p class="read-txt">Nothing yet. His progress appears here after he signs in and starts a lesson.</p>` : ""}
    <div class="rows"><span class="lbl">This week</span><div class="week">${strip}</div></div>
    ${flags}
    <div class="card">
      <span class="lbl">Math</span>
      ${current ? `<span class="t">${esc(titleOf(current))}</span><span class="m">${esc(stage)} · ${got} of ${mathList.length} skills done</span>` : `<span class="t">${mathList.length ? "All skills done" : "No math skills added yet"}</span>`}
      ${scores ? `<details><summary class="m">Scores</summary><div class="rows" style="margin-top:10px">${scores}</div></details>` : ""}
    </div>
    <div class="rows">
      <span class="lbl">Latest check-in${lastDay ? " · " + esc(niceDate(new Date(lastDay + "T12:00"))) : ""}</span>
      ${last ? answers + (last.voicePath ? `<audio id="voice" controls preload="none"></audio>` : last.voice ? `<p class="m">Voice note recorded before login was set up, so it stayed on his phone.</p>` : "") : `<p class="m">None yet.</p>`}
    </div>
    <button class="btn quiet" id="refresh">Refresh</button>`;

  document.getElementById("refresh").addEventListener("click", async () => { await loadFamily(); renderParent(); });
  if (last && last.voicePath) {
    const { data } = await db.storage.from("voice").createSignedUrl(last.voicePath, 3600);
    const audio = document.getElementById("voice");
    if (data && audio) audio.src = data.signedUrl;
  }
}

function showPreviewBar() {
  const names = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri" };
  const bar = document.createElement("div");
  bar.className = "preview";
  bar.innerHTML = `<span class="lbl">Preview · nothing is saved</span><div class="chips">${Object.entries(names).map(([k, n]) =>
    `<a class="chip ${k === previewKey ? "on" : ""}" href="?preview=${k}#/today">${n}</a>`).join("")}<a class="chip" href="./">Exit</a></div>`;
  document.body.prepend(bar);
}

// ---------- Moving between screens ----------

function route() {
  const [, screen, arg] = (location.hash || "#/today").split("/");
  const tab = { lesson: "today", checkin: "today", watch: "library" }[screen] || screen || "today";
  document.querySelectorAll(".nav a").forEach(a => a.classList.toggle("on", a.dataset.tab === tab));
  if (screen === "lesson") renderLesson(decodeURIComponent(arg || ""));
  else if (screen === "checkin") renderCheckin();
  else if (screen === "library") renderLibrary();
  else if (screen === "watch") renderWatch(Number(arg));
  else if (screen === "progress") renderProgress();
  else if (account.role === "parent") renderParent();
  else renderToday();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

// ---------- Start ----------

(async function start() {
  try {
    const [c, k] = await Promise.all([loadJSON("lessons.json"), loadJSON("links.json")]);
    content = Object.assign(content, c);
    links = k.links || [];
    for (const [subject, list] of Object.entries(content.subjects || {})) {
      for (const item of list) byId[item.id] = { item, subject };
    }
  } catch (err) {
    view.innerHTML = `<div class="card"><span class="t">Couldn't load the lessons</span><p class="read-txt">Check your connection. If it keeps happening, a lesson file may have a typo.</p></div>`;
    console.error(err);
    return;
  }
  if (previewDate) showPreviewBar();
  if (db && !previewDate) await signIn();
  else route();
})();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
