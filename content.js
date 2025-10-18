// content.js

// ============================
// Config
// ============================
const API_URL = "http://localhost:11000/generate"; // generate a post
const MARK_POSTED_URL = "http://localhost:11000/mark_posted"; // confirm posted
const API_TIMEOUT_MS = 4 * 60 * 1000;

const log = (...a) => console.log("[X-BOT]", ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const chance = (p) => Math.random() < p;

// runtime state
let XBOT_ENABLED = JSON.parse(localStorage.getItem("xbot_enabled") ?? "true");
let runCancelled = false;
let apiCtrl = null; // AbortController for API fetch
let CURRENT_POST_ID = null; // returned from backend for mark_posted

// ---------- tiny UI (bottom-left), loading dots, statuses ----------
let pop;
function ensurePopup() {
  if (pop) return pop;
  const style = document.createElement("style");
  style.textContent = `
    .xbot-pop{position:fixed;left:16px;bottom:16px;z-index:999999;min-width:240px;max-width:320px;background:rgba(20,20,20,.95);color:#e7e9ea;border:1px solid rgba(255,255,255,.12);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.4);padding:12px 14px;font:13px/1.35 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
    .xbot-row{display:flex;align-items:center;gap:8px}
    .xbot-title{font-weight:700}
    .xbot-msg{opacity:.9}
    .xbot-dots{display:inline-block;width:24px;text-align:left}
    .xbot-dots::after{content:'…';animation:xbot-ellipsis steps(4,end) 900ms infinite;display:inline-block;overflow:hidden;width:0ch}
    @keyframes xbot-ellipsis{0%{width:0ch}25%{width:1ch}50%{width:2ch}75%{width:3ch}100%{width:0ch}}
    .xbot-ok{color:#20c997;font-weight:600}
    .xbot-err{color:#ff4d4f;font-weight:600}
    .xbot-spacer{flex:1}
    .xbot-switch{position:relative;display:inline-block;width:42px;height:24px}
    .xbot-switch input{opacity:0;width:0;height:0}
    .xbot-slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#374151;transition:.2s;border-radius:999px}
    .xbot-slider:before{position:absolute;content:"";height:18px;width:18px;left:3px;top:3px;background:white;border-radius:50%;transition:.2s}
    .xbot-switch input:checked + .xbot-slider{background:#10b981}
    .xbot-switch input:checked + .xbot-slider:before{transform:translateX(18px)}
    .xbot-btn{border:1px solid rgba(255,255,255,.2);background:transparent;color:#e7e9ea;border-radius:8px;padding:4px 8px;font-size:12px;cursor:pointer}
    .xbot-btn:disabled{opacity:.5;cursor:default}
  `;
  document.documentElement.appendChild(style);
  pop = document.createElement("div");
  pop.className = "xbot-pop";
  pop.innerHTML = `
    <div class="xbot-row">
      <span class="xbot-title">X Composer Bot</span>
      <span class="xbot-spacer"></span>
      <label class="xbot-switch" title="Enable/disable bot">
        <input id="xbot-toggle" type="checkbox">
        <span class="xbot-slider"></span>
      </label>
    </div>
    <div class="xbot-row" style="margin-top:6px">
      <span id="xbot-msg" class="xbot-msg">Starting…</span>
      <span id="xbot-dots" class="xbot-dots"></span>
      <span class="xbot-spacer"></span>
      <button id="xbot-cancel" class="xbot-btn">Cancel</button>
    </div>
  `;
  document.documentElement.appendChild(pop);

  // init toggle + cancel
  const toggle = pop.querySelector("#xbot-toggle");
  toggle.checked = !!XBOT_ENABLED;
  toggle.addEventListener("change", () => {
    XBOT_ENABLED = toggle.checked;
    localStorage.setItem("xbot_enabled", JSON.stringify(XBOT_ENABLED));
    if (!XBOT_ENABLED) cancelRun("Disabled by switch");
    else setStatus("Enabled", "ok");
  });
  const cancelBtn = pop.querySelector("#xbot-cancel");
  cancelBtn.addEventListener("click", () => cancelRun("Cancelled"));
  return pop;
}
function setStatus(text, mode="loading") {
  ensurePopup();
  const m = pop.querySelector("#xbot-msg");
  const d = pop.querySelector("#xbot-dots");
  m.classList.remove("xbot-ok","xbot-err");
  d.style.visibility = mode === "loading" ? "visible" : "hidden";
  if (mode === "ok") m.classList.add("xbot-ok");
  if (mode === "err") m.classList.add("xbot-err");
  m.textContent = text;
}

function assertEnabled() {
  if (!XBOT_ENABLED || runCancelled) {
    const reason = !XBOT_ENABLED ? "Disabled" : "Cancelled";
    throw new Error(reason);
  }
}

function cancelRun(reason="Cancelled") {
  runCancelled = true;
  setStatus(`${reason}`, "err");
  try { apiCtrl?.abort(); } catch {}
  try {
    chrome.runtime.sendMessage({ type: "XBOT_CANCEL" }, () => void 0);
  } catch {}
}

// ---------- helpers ----------
async function waitFor(sel, { root = document, timeout = 10000 } = {}) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeout) {
    const el = root.querySelector(sel);
    if (el) return el;
    await sleep(50);
  }
  throw new Error(`waitFor timeout: ${sel}`);
}
function dialogRoot() {
  return document.querySelector('div[role="dialog"]') || document;
}
function modalRoot() {
  // alias for clarity where we specifically mean the dialog
  return dialogRoot();
}
function selectAll(el) {
  const sel = el.ownerDocument.getSelection();
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

// Focus like a human so DraftJS registers a caret/selection
async function focusDraft(el) {
  const rect = el.getBoundingClientRect();
  const x = rect.left + 10, y = rect.top + 10;
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
  el.focus();
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
  await sleep(80);
}

function placeholderIsVisible() {
  const root = modalRoot();
  const ph = root.querySelector(".public-DraftEditorPlaceholder-root");
  if (!ph) return false;
  const cs = getComputedStyle(ph);
  return cs.display !== "none" && cs.visibility !== "hidden";
}

// Ask background (CDP) to focus the editor and type text
function cdpTypeText(text) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "XBOT_FOCUS_AND_TYPE", text }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res?.ok) return resolve();
      reject(new Error(res?.error || "CDP typing failed"));
    });
  });
}

// ---------- X.com specific flow you asked for ----------
async function clickSideNavPost() {
  log("Locating side-nav Post…");
  const btn = document.querySelector('[data-testid="SideNav_NewTweet_Button"], a[href="/compose/post"]');
  if (!btn) throw new Error("Side-nav Post button not found");
  btn.click();
  log("Clicked side-nav Post.");
}

async function waitForModalEditor() {
  log("Waiting for modal…");
  const dlg = await waitFor('div[role="dialog"]', { timeout: 8000 });
  // the active editor inside modal
  const editor = await waitFor('[data-testid="tweetTextarea_0"][contenteditable="true"]', { root: dlg, timeout: 10000 });
  log("Modal + editor found.");
  return editor;
}

async function clickPostNow() {
  const root = dialogRoot();
  const btn = root.querySelector('[data-testid="tweetButton"]') || document.querySelector('[data-testid="tweetButton"]');
  if (!btn) throw new Error("Post button (modal) not found");
  // wait until X enables it (DraftJS state update)
  const t0 = performance.now();
  while (performance.now() - t0 < 8000) {
    if (!btn.disabled) break;
    await sleep(100);
  }
  if (btn.disabled) {
    log("Post still disabled; trying Ctrl/Cmd+Enter…");
    const isMac = navigator.platform.toUpperCase().includes("MAC");
    const opts = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", [isMac ? "metaKey" : "ctrlKey"]: true };
    // fire from the editor to mimic real submit shortcut
    const editor = root.querySelector('[data-testid="tweetTextarea_0"][contenteditable="true"]');
    const target = editor || btn;
    target.dispatchEvent(new KeyboardEvent("keydown", opts));
    target.dispatchEvent(new KeyboardEvent("keyup", opts));
    await sleep(350);
    if (btn.disabled) throw new Error("Post button stayed disabled (X didn't enable it)");
  }
  log("Clicking Post…");
  btn.click();
}

// ---------- API ----------
async function fetchPostFromAPI() {
  log("Fetching text from API:", API_URL);
  setStatus("Contacting API");
  apiCtrl = new AbortController();
  const to = setTimeout(() => apiCtrl.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count: 1 }),
      signal: apiCtrl.signal
    });
    clearTimeout(to);
    if (!res.ok) throw new Error(`API HTTP ${res.status}`);
    const json = await res.json();
    log("API json:", json);
    const post = (json?.x_post || "").trim();
    const postId = json?.post_id ?? null;
    const why = json?.why ?? "";
    if (!post) throw new Error("API returned no x_post");
    if (typeof postId !== "number") log("[X-BOT] warn: API didn't return a numeric post_id; mark_posted may be skipped");
    CURRENT_POST_ID = postId;
    return { post, why, postId };
  } catch (e) {
    clearTimeout(to);
    if (e?.name === "AbortError") throw new Error("API request aborted");
    throw e;
  } finally {
    apiCtrl = null;
  }
}

async function markPosted(postId) {
  if (runCancelled) return; // don't confirm if user cancelled
  if (typeof postId !== "number") {
    log("[X-BOT] Skipping mark_posted: invalid postId", postId);
    return;
  }
  try {
    const res = await fetch(MARK_POSTED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ post_id: postId })
    });
    if (!res.ok) throw new Error(`mark_posted HTTP ${res.status}`);
    const body = await res.json().catch(() => ({}));
    log("[X-BOT] mark_posted ok:", body);
  } catch (err) {
    console.warn("[X-BOT] mark_posted failed:", err);
  }
}
// ---------- main ----------
(async function run() {
   try {
     ensurePopup();
    setStatus(XBOT_ENABLED ? "Preparing" : "Disabled", XBOT_ENABLED ? "loading" : "err");
    if (!XBOT_ENABLED) return;
    assertEnabled();
    const { post: text, why, postId } = await fetchPostFromAPI();
    log("Text to post:", { text, postId, why });
    assertEnabled();
 
     // 1) Click side-nav Post
     setStatus("Opening composer");
     await clickSideNavPost();
    assertEnabled();
 
     // 2) Wait for modal + editor; then pause ~1s as you requested
     const editor = await waitForModalEditor();
     await sleep(1000);
    assertEnabled();
 
    // 3) Focus editor in DOM (cursor) then type via CDP (no Draft crashes)
    setStatus("Typing…");
    await focusDraft(editor);
    await cdpTypeText(text);
    assertEnabled();
 
    // small settle
    await sleep(200);
    assertEnabled();
 
     // Give X a moment to enable the button
     await sleep(300);
    assertEnabled();
 
     // 4) Submit via CDP: Enter → Ctrl/Cmd+Enter → click fallback
     setStatus("Posting…");
     await new Promise((resolve, reject) => {
       const isMac = navigator.platform.toUpperCase().includes("MAC");
       chrome.runtime.sendMessage(
         { type: "XBOT_SUBMIT", isMac },
         (res) => {
           if (chrome.runtime.lastError) {
             return reject(new Error(chrome.runtime.lastError.message));
           }
           if (res?.ok) return resolve();
           reject(new Error(res?.error || "CDP submit failed"));
         }
       );
     });
 
     setStatus("Posted ✅", "ok");
     // Fire-and-forget mark_posted
     markPosted(postId ?? CURRENT_POST_ID);
     log("Done.");
     setTimeout(() => { try{ pop?.remove(); }catch{} pop=null; }, 3000);
   } catch (err) {
     log("Failure:", err);
     setStatus(`Failed: ${err.message}`, "err");
     // keep popup so you can see failure
   }
})();
