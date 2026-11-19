import { PracticeEngine } from "./engine.js";
import { YoutubeController, parseVideoId } from "./youtube.js";
import { fetchSuggestions } from "./suggest.js";
import * as store from "./store.js";

const $ = (id) => document.getElementById(id);

const PITCH_LIMIT = 12;
const SPEED_MIN = 0.25;
const SPEED_MAX = 2.0;
const SPEED_STEP = 0.05;

const engine = new PracticeEngine();
const yt = new YoutubeController($("ytHost"));

const state = {
  screen: "home",
  mode: null, // "local" | "youtube"
  token: 0,
  videoId: null,
  title: "",
  titleResolved: false,
  fileName: "",
  fileSize: 0,
  blob: null,
  pitch: 0,
  speed: 1,
  a: null,
  b: null,
  loopOn: false,
  seeking: false,
  pendingFavorite: null,
  coarseRates: null,
};

const el = {
  ytInput: $("ytInput"),
  searchInput: $("searchInput"),
  searchHint: $("searchHint"),
  searchResults: $("searchResults"),
  apiKeyInput: $("apiKeyInput"),
  playerTitle: $("playerTitle"),
  ytWrap: $("ytWrap"),
  localWrap: $("localWrap"),
  localName: $("localName"),
  statusLine: $("statusLine"),
  btnPlay: $("btnPlay"),
  seek: $("seek"),
  tCur: $("tCur"),
  tDur: $("tDur"),
  pitchGroup: $("pitchGroup"),
  pitchNote: $("pitchNote"),
  valPitch: $("valPitch"),
  valSpeed: $("valSpeed"),
  speedRange: $("speedRange"),
  aMin: $("aMin"),
  aSec: $("aSec"),
  bMin: $("bMin"),
  bSec: $("bSec"),
  chkLoop: $("chkLoop"),
  favList: $("favList"),
  favEmpty: $("favEmpty"),
  fileLocal: $("fileLocal"),
  fileImport: $("fileImport"),
};

/* ---------- helpers ---------- */

function fmt(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function nearest(list, value) {
  return list.reduce((best, x) => (Math.abs(x - value) < Math.abs(best - value) ? x : best), list[0]);
}

function decodeEntities(text) {
  const t = document.createElement("textarea");
  t.innerHTML = text;
  return t.value;
}

let toastTimer = null;
function toast(message) {
  const t = $("toast");
  t.textContent = message;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2800);
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ---------- navigation ---------- */

function showScreen(name, push = true) {
  const previous = state.screen;
  if (previous === "player" && name !== "player") stopPlayer();
  for (const id of ["home", "favorites", "player"]) {
    $(`screen-${id}`).hidden = id !== name;
  }
  if (push && previous !== name) history.pushState({ s: name }, "");
  state.screen = name;
  window.scrollTo(0, 0);
  if (name === "favorites") renderFavorites();
}

window.addEventListener("popstate", (e) => showScreen((e.state && e.state.s) || "home", false));
history.replaceState({ s: "home" }, "");

for (const btn of document.querySelectorAll("[data-back]")) {
  btn.addEventListener("click", () => {
    if (history.state && history.state.s !== "home") history.back();
    else showScreen("home", false);
  });
}

/* ---------- iOS audio unlock / wake lock ---------- */

let silentAudio = null;
function unlockAudio() {
  engine.unlock();
  if (!navigator.audioSession && !silentAudio) {
    const rate = 8000;
    const bytes = new Uint8Array(44 + rate);
    const v = new DataView(bytes.buffer);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, "RIFF");
    v.setUint32(4, 36 + rate, true);
    str(8, "WAVEfmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate, true);
    v.setUint16(32, 1, true);
    v.setUint16(34, 8, true);
    str(36, "data");
    v.setUint32(40, rate, true);
    bytes.fill(128, 44);
    silentAudio = new Audio(URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })));
    silentAudio.loop = true;
    silentAudio.setAttribute("playsinline", "");
    silentAudio.play().catch(() => {});
  }
}
if (navigator.audioSession) navigator.audioSession.type = "playback";
document.addEventListener("touchend", unlockAudio, { passive: true });
document.addEventListener("click", unlockAudio);

let wakeLock = null;
let wakeLockPending = false;
async function syncWakeLock(playing) {
  if (!("wakeLock" in navigator)) return;
  try {
    if (playing && !wakeLock && !wakeLockPending && document.visibilityState === "visible") {
      wakeLockPending = true;
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    } else if (!playing && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      await lock.release();
    }
  } catch (e) {
    /* wake lock is best-effort */
  } finally {
    wakeLockPending = false;
  }
}

/* ---------- player setup / teardown ---------- */

function stopPlayer() {
  state.token += 1;
  engine.pause();
  yt.destroy();
  syncWakeLock(false);
  state.mode = null;
}

function prepPlayer(mode, title) {
  stopPlayer();
  state.mode = mode;
  state.title = title;
  state.titleResolved = mode !== "youtube";
  state.pitch = 0;
  state.speed = 1;
  state.a = null;
  state.b = null;
  state.loopOn = false;
  state.seeking = false;
  state.coarseRates = null;
  engine.loop = { enabled: false, a: 0, b: 0 };
  for (const f of [el.aMin, el.aSec, el.bMin, el.bSec]) f.value = "";
  el.chkLoop.checked = false;
  el.seek.value = 0;
  el.tCur.textContent = "00:00";
  el.tDur.textContent = "00:00";
  el.playerTitle.textContent = title;
  el.ytWrap.hidden = mode !== "youtube";
  el.localWrap.hidden = mode !== "local";
  el.pitchGroup.classList.toggle("disabled", mode === "youtube");
  el.pitchNote.hidden = mode !== "youtube";
  el.btnPlay.textContent = "재생";
  el.btnPlay.disabled = true;
  updatePitchUi();
  updateSpeedUi();
}

function currentPosition() {
  return state.mode === "local" ? engine.getPosition() : yt.getTime();
}

function currentDuration() {
  return state.mode === "local" ? engine.duration : yt.getDuration();
}

/* ---------- pitch / speed ---------- */

function updatePitchUi() {
  el.valPitch.textContent = state.pitch > 0 ? `+${state.pitch}` : String(state.pitch);
}

function updateSpeedUi() {
  el.valSpeed.textContent = `${state.speed.toFixed(2)}x`;
}

function setPitch(value) {
  if (state.mode !== "local") return;
  state.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, Math.round(value)));
  engine.setPitch(state.pitch);
  updatePitchUi();
}

let rateCheckTimer = null;

function setSpeed(value) {
  state.speed = round2(Math.max(SPEED_MIN, Math.min(SPEED_MAX, value)));
  if (state.mode === "local") {
    engine.setSpeed(state.speed);
  } else if (state.mode === "youtube") {
    yt.setRate(state.speed);
    // The embedded player normally accepts any rate (e.g. 1.05), but if it rounds one it doesn't
    // support, show what it really uses and fall back to its own coarser rate list for stepping.
    clearTimeout(rateCheckTimer);
    rateCheckTimer = setTimeout(() => {
      const actual = yt.getRate();
      if (state.mode !== "youtube" || !actual || Math.abs(actual - state.speed) <= 0.01) return;
      state.coarseRates = yt.getRates();
      state.speed = round2(actual);
      updateSpeedUi();
    }, 400);
  }
  updateSpeedUi();
}

function stepSpeed(direction) {
  if (state.mode === "youtube" && state.coarseRates) {
    const rates = state.coarseRates;
    const index = rates.indexOf(nearest(rates, state.speed));
    setSpeed(rates[Math.max(0, Math.min(rates.length - 1, index + direction))]);
  } else {
    setSpeed(state.speed + direction * SPEED_STEP);
  }
}

$("btnPitchMinus").addEventListener("click", () => setPitch(state.pitch - 1));
$("btnPitchPlus").addEventListener("click", () => setPitch(state.pitch + 1));
$("btnPitchReset").addEventListener("click", () => setPitch(0));
$("btnSpeedMinus").addEventListener("click", () => stepSpeed(-1));
$("btnSpeedPlus").addEventListener("click", () => stepSpeed(1));
$("btnSpeedReset").addEventListener("click", () => setSpeed(1));

/* ---------- A-B loop ---------- */

function readPoint(prefix) {
  const minText = el[`${prefix}Min`].value.trim();
  const secText = el[`${prefix}Sec`].value.trim().replace(",", ".");
  if (!minText && !secText) return null;
  const minutes = parseInt(minText || "0", 10);
  const seconds = parseFloat(secText || "0");
  if (Number.isNaN(minutes) || Number.isNaN(seconds) || minutes < 0 || seconds < 0) return null;
  return minutes * 60 + seconds;
}

function writePoint(prefix, seconds) {
  el[`${prefix}Min`].value = String(Math.floor(seconds / 60));
  el[`${prefix}Sec`].value = String(Number((seconds % 60).toFixed(1)));
}

function applyLoop(showErrors) {
  state.a = readPoint("a");
  state.b = readPoint("b");
  const valid = state.a !== null && state.b !== null && state.b > state.a;
  if (el.chkLoop.checked && !valid) {
    if (showErrors) toast("A와 B를 입력하고, B가 A보다 뒤여야 합니다");
    el.chkLoop.checked = false;
  }
  state.loopOn = el.chkLoop.checked && valid;
  if (state.mode === "local") {
    engine.setLoop(state.loopOn, state.a ?? 0, state.b ?? 0);
  } else if (state.mode === "youtube" && state.loopOn) {
    const pos = yt.getTime();
    if (pos < state.a || pos >= state.b) yt.seek(state.a);
  }
}

$("btnSetA").addEventListener("click", () => {
  writePoint("a", currentPosition());
  applyLoop(false);
});
$("btnSetB").addEventListener("click", () => {
  writePoint("b", currentPosition());
  applyLoop(false);
});
for (const f of [el.aMin, el.aSec, el.bMin, el.bSec]) f.addEventListener("change", () => applyLoop(true));
el.chkLoop.addEventListener("change", () => applyLoop(true));

/* ---------- transport ---------- */

el.btnPlay.addEventListener("click", async () => {
  if (state.mode === "local") {
    if (engine.playing) engine.pause();
    else await engine.play();
  } else if (state.mode === "youtube") {
    if (yt.isPlaying()) yt.pause();
    else yt.play();
  }
});

$("btnRestart").addEventListener("click", async () => {
  const start = state.loopOn ? state.a : 0;
  if (state.mode === "local") {
    engine.seek(start);
    await engine.play();
  } else if (state.mode === "youtube") {
    yt.seek(start);
    yt.play();
  }
});

el.seek.addEventListener("input", () => {
  state.seeking = true;
  el.tCur.textContent = fmt((el.seek.value / 1000) * currentDuration());
});

el.seek.addEventListener("change", () => {
  const target = (el.seek.value / 1000) * currentDuration();
  if (state.mode === "local") engine.seek(target);
  else if (state.mode === "youtube") yt.seek(target);
  state.seeking = false;
});

engine.onEnded = () => {
  el.btnPlay.textContent = "재생";
};

setInterval(() => {
  if (state.screen !== "player" || !state.mode) return;
  let playing;
  if (state.mode === "local") {
    playing = engine.playing;
  } else {
    if (!yt.ready) return;
    playing = yt.isPlaying();
    const pos = yt.getTime();
    if (state.loopOn && pos >= state.b - 0.03 && pos < state.b + 1) yt.seek(state.a);
    if (!state.titleResolved) {
      const title = yt.getTitle();
      if (title) {
        state.title = title;
        state.titleResolved = true;
        el.playerTitle.textContent = title;
      }
    }
  }
  el.btnPlay.textContent = playing ? "일시정지" : "재생";
  syncWakeLock(playing);
  if (state.seeking) return;
  const duration = currentDuration();
  const position = currentPosition();
  el.tCur.textContent = fmt(position);
  el.tDur.textContent = fmt(duration);
  el.seek.value = duration > 0 ? Math.round((position / duration) * 1000) : 0;
}, 80);

/* ---------- opening content ---------- */

function applySettings(s) {
  if (state.mode === "local") setPitch(s.pitch || 0);
  setSpeed(s.speed || 1);
  if (typeof s.a === "number") writePoint("a", s.a);
  if (typeof s.b === "number") writePoint("b", s.b);
  el.chkLoop.checked = !!s.loop;
  applyLoop(false);
}

async function openYoutube(videoId, favorite = null) {
  prepPlayer("youtube", (favorite && favorite.title) || "유튜브 영상");
  state.videoId = videoId;
  const token = state.token;
  showScreen("player");
  el.statusLine.textContent = "영상을 불러오는 중…";
  yt.onError = (code) => {
    const reasons = { 2: "잘못된 영상 주소입니다", 5: "플레이어 오류입니다", 100: "영상을 찾을 수 없습니다", 101: "이 영상은 외부 재생이 허용되지 않습니다", 150: "이 영상은 외부 재생이 허용되지 않습니다" };
    toast(reasons[code] || `재생 오류 (${code})`);
    el.statusLine.textContent = reasons[code] || `재생 오류 (${code})`;
  };
  try {
    await yt.open(videoId);
  } catch (e) {
    if (token === state.token) el.statusLine.textContent = e.message;
    return;
  }
  if (token !== state.token) return;
  el.btnPlay.disabled = false;
  el.statusLine.textContent = "재생이 시작되지 않으면 영상 위의 재생 버튼을 직접 눌러주세요.";
  if (favorite) applySettings(favorite);
}

async function openLocal(blob, fileName, favorite = null) {
  const title = fileName.replace(/\.[^.]+$/, "");
  prepPlayer("local", (favorite && favorite.title) || title);
  state.fileName = fileName;
  state.fileSize = blob.size;
  state.blob = blob;
  const token = state.token;
  showScreen("player");
  el.localName.textContent = fileName;
  el.statusLine.textContent = "파일을 불러오는 중…";
  try {
    const buffer = await blob.arrayBuffer();
    await engine.load(buffer);
  } catch (e) {
    if (token === state.token) el.statusLine.textContent = "이 파일은 재생할 수 없습니다 (지원하지 않는 형식이거나 손상된 파일).";
    return;
  }
  if (token !== state.token) return;
  el.btnPlay.disabled = false;
  el.tDur.textContent = fmt(engine.duration);
  el.statusLine.textContent = "소리가 나지 않으면 아이폰 옆면의 무음 스위치를 확인해주세요.";
  applyLoop(false);
  if (favorite) {
    applySettings(favorite);
    if (!favorite.hasAudio) persistLocalAudio(favorite);
  }
}

async function persistLocalAudio(record) {
  const current = store.findFavorite(record) || record;
  try {
    await store.saveAudio(current.id, await state.blob.arrayBuffer());
    store.upsertFavorite({ ...current, hasAudio: true });
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------- home: youtube url / search / local file ---------- */

function openFromInput() {
  const id = parseVideoId(el.ytInput.value);
  if (!id) {
    toast("유튜브 주소를 확인해주세요");
    return;
  }
  openYoutube(id);
}

$("btnOpenYt").addEventListener("click", openFromInput);
el.ytInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") openFromInput();
});

function refreshSearchHint() {
  const hasKey = !!store.getSettings().apiKey;
  el.searchHint.textContent = hasKey ? "" : "검색을 쓰려면 아래 \"검색 설정\"에서 API 키를 저장하세요. 키 없이도 위의 주소 붙여넣기로 열 수 있습니다.";
}

$("btnSaveKey").addEventListener("click", () => {
  store.saveSettings({ apiKey: el.apiKeyInput.value.trim() });
  el.apiKeyInput.value = "";
  refreshSearchHint();
  toast("API 키를 저장했습니다");
});

const suggestList = $("suggestList");
let suggestSeq = 0;
let suggestTimer = null;
let suggestActive = -1;

function hideSuggestions() {
  suggestSeq += 1;
  clearTimeout(suggestTimer);
  suggestActive = -1;
  suggestList.hidden = true;
  suggestList.replaceChildren();
}

function showSuggestions(items) {
  suggestActive = -1;
  if (!items.length) {
    suggestList.hidden = true;
    suggestList.replaceChildren();
    return;
  }
  const nodes = items.slice(0, 8).map((text) => {
    const li = make("li", "", text);
    li.setAttribute("role", "option");
    li.addEventListener("click", () => {
      el.searchInput.value = text;
      runSearch();
    });
    return li;
  });
  suggestList.replaceChildren(...nodes);
  suggestList.hidden = false;
}

function highlightSuggestion(index) {
  [...suggestList.children].forEach((li, i) => li.classList.toggle("active", i === index));
}

el.searchInput.addEventListener("input", () => {
  clearTimeout(suggestTimer);
  const query = el.searchInput.value.trim();
  if (!query) {
    hideSuggestions();
    return;
  }
  suggestTimer = setTimeout(async () => {
    const mine = ++suggestSeq;
    const items = await fetchSuggestions(query);
    if (mine === suggestSeq && document.activeElement === el.searchInput) showSuggestions(items);
  }, 180);
});

// Delay so a tap on a suggestion still registers before the list disappears on blur.
el.searchInput.addEventListener("blur", () => setTimeout(hideSuggestions, 250));

async function runSearch() {
  hideSuggestions();
  const key = store.getSettings().apiKey;
  const query = el.searchInput.value.trim();
  if (!key) {
    toast("먼저 검색 설정에서 API 키를 저장해주세요");
    document.querySelector("#screen-home details").open = true;
    return;
  }
  if (!query) return;
  el.searchResults.replaceChildren(make("p", "note", "검색 중…"));
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=15&q=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(describeApiError(data.error, res.status));
    renderSearchResults(data.items || []);
  } catch (e) {
    el.searchResults.replaceChildren(make("p", "note", `검색에 실패했습니다: ${e.message}`));
  }
}

function describeApiError(error, status) {
  const message = (error && error.message) || "";
  const reasons = [
    ...((error && error.errors) || []).map((x) => x.reason),
    ...((error && error.details) || []).map((x) => x.reason),
    error && error.status,
  ].filter(Boolean);
  const reason = [...new Set(reasons)].join(", ");
  const text = `${reasons.join(" ")} ${message}`.toLowerCase();
  let hint = "";
  if (/accessnotconfigured|service_disabled|has not been used|is disabled/.test(text)) {
    hint = "이 키가 속한 프로젝트에서 YouTube Data API v3가 사용 설정되지 않았습니다. 키를 만든 프로젝트와 같은 프로젝트에서 \"사용\"을 눌렀는지 확인하세요.";
  } else if (/referer|referrer/.test(text)) {
    hint = "키의 웹사이트 제한에 이 사이트 주소가 맞지 않습니다. \"https://내계정.github.io/*\" 형식(소문자, 끝에 /*)으로 등록했는지 확인하세요.";
  } else if (/api_key_service_blocked|are blocked|api target/.test(text)) {
    hint = "키의 \"API 제한\"에 YouTube Data API v3가 포함되어 있지 않습니다.";
  } else if (/quota|ratelimit|rate_limit|dailylimit/.test(text)) {
    hint = "오늘의 무료 검색 한도를 모두 썼습니다. 태평양 시간 자정(한국 시간 오후 4~5시)에 초기화됩니다.";
  } else if (/keyinvalid|api_key_invalid|api key not valid/.test(text)) {
    hint = "API 키가 올바르지 않습니다. 복사한 키가 전부 들어갔는지 확인하세요.";
  } else if (/permission|forbidden|denied/.test(text)) {
    hint = "키 설정(API 사용 설정, 키 제한)을 확인하세요. 제한을 잠시 \"없음\"으로 풀어서 되는지 보면 원인을 좁힐 수 있습니다.";
  }
  const detail = [message || `검색 실패 (${status})`, reason && `[${reason}]`].filter(Boolean).join(" ");
  return hint ? `${hint}\n(${detail})` : detail;
}

function renderSearchResults(items) {
  if (!items.length) {
    el.searchResults.replaceChildren(make("p", "note", "검색 결과가 없습니다"));
    return;
  }
  const nodes = items.map((item) => {
    const videoId = item.id.videoId;
    const row = make("div", "item");
    const img = make("img", "thumb");
    img.loading = "lazy";
    img.alt = "";
    img.src = (item.snippet.thumbnails.medium || item.snippet.thumbnails.default).url;
    const meta = make("div", "meta");
    meta.append(make("div", "title", decodeEntities(item.snippet.title)), make("div", "sub", decodeEntities(item.snippet.channelTitle)));
    row.append(img, meta);
    row.addEventListener("click", () => openYoutube(videoId, { title: decodeEntities(item.snippet.title) }));
    return row;
  });
  el.searchResults.replaceChildren(...nodes);
}

$("btnSearch").addEventListener("click", runSearch);
el.searchInput.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  const items = [...suggestList.children];
  if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length && !suggestList.hidden) {
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    suggestActive = (suggestActive + step + items.length) % items.length;
    highlightSuggestion(suggestActive);
  } else if (e.key === "Escape") {
    hideSuggestions();
  } else if (e.key === "Enter") {
    if (suggestActive >= 0 && items[suggestActive]) el.searchInput.value = items[suggestActive].textContent;
    runSearch();
  }
});

$("btnOpenLocal").addEventListener("click", () => el.fileLocal.click());

el.fileLocal.addEventListener("change", () => {
  const file = el.fileLocal.files[0];
  el.fileLocal.value = "";
  if (!file) return;
  const pending = state.pendingFavorite;
  state.pendingFavorite = null;
  const favorite = pending && pending.fileName === file.name ? pending : null;
  openLocal(file, file.name, favorite);
});

$("btnFavorites").addEventListener("click", () => showScreen("favorites"));

/* ---------- favorites ---------- */

function describeFavorite(fav) {
  const parts = [];
  if (fav.type === "local") parts.push(`피치 ${fav.pitch > 0 ? "+" : ""}${fav.pitch || 0}`);
  parts.push(`${(fav.speed || 1).toFixed(2)}x`);
  if (fav.loop && typeof fav.a === "number" && typeof fav.b === "number") parts.push(`반복 ${fmt(fav.a)}–${fmt(fav.b)}`);
  if (fav.type === "local" && !fav.hasAudio) parts.push("파일 다시 선택 필요");
  return parts.join(" · ");
}

function renderFavorites() {
  const favorites = store.listFavorites();
  el.favEmpty.hidden = favorites.length > 0;
  const nodes = favorites.map((fav) => {
    const row = make("div", "item");
    let thumb;
    if (fav.type === "youtube") {
      thumb = make("img", "thumb");
      thumb.loading = "lazy";
      thumb.alt = "";
      thumb.src = `https://i.ytimg.com/vi/${encodeURIComponent(fav.videoId)}/mqdefault.jpg`;
    } else {
      thumb = make("div", "thumb ph", "🎵");
    }
    const meta = make("div", "meta");
    meta.append(make("div", "title", fav.title || fav.fileName || fav.videoId), make("div", "sub", describeFavorite(fav)));
    meta.addEventListener("click", () => openFavorite(fav));
    thumb.addEventListener("click", () => openFavorite(fav));
    const del = make("button", "del", "삭제");
    del.addEventListener("click", async () => {
      if (!confirm("이 즐겨찾기를 삭제할까요?")) return;
      await store.removeFavorite(fav.id);
      renderFavorites();
    });
    row.append(thumb, meta, del);
    return row;
  });
  el.favList.replaceChildren(...nodes);
}

async function openFavorite(fav) {
  if (fav.type === "youtube") {
    openYoutube(fav.videoId, fav);
    return;
  }
  if (!fav.hasAudio) {
    state.pendingFavorite = fav;
    toast(`"${fav.fileName}" 파일을 다시 선택해주세요`);
    el.fileLocal.click();
    return;
  }
  let buffer;
  try {
    buffer = await store.loadAudio(fav.id);
  } catch (e) {
    buffer = null;
  }
  if (!buffer) {
    state.pendingFavorite = { ...fav, hasAudio: false };
    history.back();
    toast(`보관된 파일이 없습니다. 홈에서 "${fav.fileName}" 파일을 다시 열어주세요`);
    return;
  }
  openLocal(new Blob([buffer]), fav.fileName, fav);
}

$("btnSaveFav").addEventListener("click", async () => {
  if (!state.mode) return;
  applyLoop(false);
  const common = {
    title: state.title,
    speed: state.speed,
    a: state.a,
    b: state.b,
    loop: state.loopOn,
  };
  if (state.mode === "youtube") {
    store.upsertFavorite({ type: "youtube", videoId: state.videoId, pitch: 0, ...common });
    toast("즐겨찾기에 저장했습니다");
    return;
  }
  const identity = { type: "local", fileName: state.fileName, fileSize: state.fileSize };
  const existing = store.findFavorite(identity);
  const record = store.upsertFavorite({ ...identity, pitch: state.pitch, ...common, hasAudio: existing ? !!existing.hasAudio : false });
  if (record.hasAudio) {
    toast("즐겨찾기에 저장했습니다");
  } else if (await persistLocalAudio(record)) {
    toast("저장했습니다 (음악 파일도 이 기기에 함께 보관)");
  } else {
    toast("설정만 저장했습니다. 저장 공간이 부족해 다시 열 때 파일을 다시 선택해야 합니다");
  }
});

$("btnExport").addEventListener("click", async () => {
  const json = store.exportFavoritesJson();
  const file = new File([json], "ytpractice-favorites.json", { type: "application/json" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: "YT 연습 플레이어 즐겨찾기" });
      return;
    }
  } catch (e) {
    if (e && e.name === "AbortError") return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});

$("btnImport").addEventListener("click", () => el.fileImport.click());

el.fileImport.addEventListener("change", async () => {
  const file = el.fileImport.files[0];
  el.fileImport.value = "";
  if (!file) return;
  try {
    const count = store.importFavoritesJson(await file.text());
    toast(`즐겨찾기 ${count}개를 가져왔습니다`);
    renderFavorites();
  } catch (e) {
    toast(`가져오기에 실패했습니다: ${e.message}`);
  }
});

/* ---------- boot ---------- */

refreshSearchHint();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
