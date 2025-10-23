// content/content.js — lean entry (no embedded HTML/CSS)

const log = (...a) => console.log("[X-BOT]", ...a);

// --- load CSS + HTML from extension package ---
async function loadPopupAssets() {
  // CSS
  const cssUrl = chrome.runtime.getURL("content/styles/popup.css");
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = cssUrl;
  document.documentElement.appendChild(link);

  // HTML
  const htmlUrl = chrome.runtime.getURL("content/ui/popup.html");
  const html = await fetch(htmlUrl).then(r => r.text());
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  document.documentElement.appendChild(wrap.firstElementChild);
}

function $(sel) { return document.querySelector(sel); }

function setStatus(text, mode = "loading") {
  const m = $("#xbot-msg");
  const d = $("#xbot-dots");
  if (!m || !d) return;
  m.classList.remove("xbot-ok", "xbot-err");
  d.style.visibility = mode === "loading" ? "visible" : "hidden";
  if (mode === "ok") m.classList.add("xbot-ok");
  if (mode === "err") m.classList.add("xbot-err");
  m.textContent = text;
}

function setPlayLabel(isPlaying) {
  const btn = $("#xbot-playpause");
  if (btn) btn.textContent = isPlaying ? "Pause" : "Play";
}

function setFps(val) {
  const el = $("#xbot-fps"); if (el) el.textContent = String(val ?? 0);
}
function setQueueLen(val) {
  const el = $("#xbot-queue"); if (el) el.textContent = String(val ?? 0);
}

// ---------- BG engine controls ----------
function engineStatus() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "XBOT_ENGINE_STATUS" }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(res || { ok: false });
    });
  });
}
function enginePlay() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "XBOT_ENGINE_PLAY" }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(res || { ok: false });
    });
  });
}
function enginePause() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "XBOT_ENGINE_PAUSE" }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(res || { ok: false });
    });
  });
}

async function onPlayPause() {
  try {
    setStatus("Engine: toggling…");
    const st = await engineStatus();
    const running = !!st?.running;
    if (!running) {
      const r = await enginePlay();
      const isRun = !!r?.running;
      setStatus(isRun ? "Engine running" : "Engine idle", isRun ? "ok" : "loading");
      setPlayLabel(isRun);
    } else {
      const r = await enginePause();
      setStatus("Engine paused", "ok");
      setPlayLabel(!!r?.running);
    }
  } catch (e) {
    console.warn("[X-BOT] engine toggle failed:", e);
    setStatus(`Engine error: ${e.message}`, "err");
    setPlayLabel(false);
  }
}

function wireUI() {
  const playBtn = $("#xbot-playpause");
  const cancelBtn = $("#xbot-cancel");
  playBtn?.addEventListener("click", onPlayPause);
  cancelBtn?.addEventListener("click", () => {
    try { chrome.runtime.sendMessage({ type: "XBOT_CANCEL" }, () => void 0); } catch {}
    setStatus("Cancelled", "err");
    setPlayLabel(false);
  });

  // Enqueue a scroll_to_next_post job
  const scrollBtn = $("#xbot-scroll");
  const speedInput = $("#xbot-scroll-speed");
  scrollBtn?.addEventListener("click", async () => {
    try {
      const speed = Math.max(1, Number(speedInput?.value) || 1600); // px/s
      setStatus("Queue: scroll_to_next_post", "loading");
      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          type: "XBOT_QUEUE_ADD",
          workType: "scroll_to_next_post",
          payload: { speed },
        }, (res) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(res);
        });
      });
      setStatus("Queued scroll_to_next_post", "ok");
    } catch (e) {
      console.warn("[X-BOT] enqueue scroll_to_next_post failed:", e);
      setStatus(`Queue error: ${e.message}`, "err");
    }
  });

  const fireBtn = $("#xbot-fire");
  fireBtn?.addEventListener("click", async () => {
    try {

      const xi = 64, yi = 24;
      const xf = 185, yf = 737;
      const speed = 20; // px/s
      setStatus("Queue: mouse_move", "loading");
      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          type: "XBOT_QUEUE_ADD",
          workType: "mouse_move",
          payload: { xi, yi, xf, yf, speed }
        }, (res) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(res);
        });
      });
      setStatus("Queued mouse_move", "ok");
    } catch (e) {
      console.warn("[X-BOT] enqueue mouse_move failed:", e);
      setStatus(`Queue error: ${e.message}`, "err");
    }
  });

  // Capture the nearest post's content (below/near the anchor)
  const captureBtn = $("#xbot-capture");
  captureBtn?.addEventListener("click", async () => {
    try {
      setStatus("Queue: capture_post_content", "loading");
      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          type: "XBOT_QUEUE_ADD",
          workType: "capture_post_content",
        }, (res) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(res);
        });
      });
      setStatus("Queued capture_post_content", "ok");
    } catch (e) {
      console.warn("[X-BOT] enqueue capture_post_content failed:", e);
      setStatus(`Queue error: ${e.message}`, "err");
    }
  });
}

// ---------- optional debug log bridge (BG -> content) ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "XBOT_DEBUG") {
    try { console.log("[X-BOT][debug]", msg.tag || "", msg.payload || msg); } catch {}
  }
  if (msg?.type === "XBOT_CAPTURED_POST") {
    try { console.log("[X-BOT][captured]", msg.payload); } catch {}
    setStatus("Captured post", "ok");
  }
  if (msg?.type === "XBOT_CAPTURED_POST_SKIPPED") {
    try { console.log("[X-BOT][captured][skipped]", msg.reason); } catch {}
    setStatus(`Skipped (${msg.reason || "unknown"})`, "err");
  }
});

// ---------- bootstrap ----------
(async function run() {
  try {
    await loadPopupAssets();
    setStatus("Checking engine…", "loading");
    const s = await engineStatus();
    const isRunning = !!s?.running;
    setStatus(isRunning ? "Engine running" : "Engine idle", isRunning ? "ok" : "loading");
    setPlayLabel(isRunning);
    setFps(s?.fps ?? 0);
    setQueueLen(s?.queue_len ?? 0);
    wireUI();

    // Poll engine status for FPS + queue every 1s
    setInterval(async () => {
      try {
        const st = await engineStatus();
        setFps(st?.fps ?? 0);
        setQueueLen(st?.queue_len ?? 0);
      } catch {}
    }, 1000);
  } catch (err) {
    log("Init failure:", err);
    // best-effort fallback UI
    try { setStatus(`Failed: ${err.message}`, "err"); } catch {}
  }
})();