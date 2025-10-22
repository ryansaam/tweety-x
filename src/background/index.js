// index.js — service worker entry point
import { DEBUG_LOG_STEPS, engine, getTabState, run } from "./engine.js";
import { ensureTimelineAnchor, getTimelineAnchor, invalidate as invalidateLayout } from "./layout.js";
import { attachIfNeeded, maybeDetach } from "./cdp.js";
import { enqueueWork, peek as queuePeek, size as queueSize } from "./queue.js";
import { getActiveMeta } from "./jobs/runner.js";
import { Writer } from "./writer.js";

// Cap outer loop to reduce CDP pressure (keeps UI smooth)
const OUTER_FPS_CAP = 240;
const OUTER_FRAME_MS = Math.ceil(1000 / OUTER_FPS_CAP);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ultra-fast engine loop with fixed-timestep tick + free-running render
async function engineLoop(tabId) {
  const st = getTabState(tabId);
  if (st.engineTicking) return;
  st.engineTicking = true;
  try {
    await attachIfNeeded(tabId);

    // Measure & cache the X tablist anchor once per attach (lazy re-measure on invalidation)
    await ensureTimelineAnchor(tabId);

    if (DEBUG_LOG_STEPS) console.log(`[X-BOT/bg] ENGINE: loop start (tab=${tabId})`);

    let lastFpsLog = 0;

    while (st.running) {
      try {
        const now = performance.now();

        // one frame worth of simulation + render (run() handles frameCount + FPS)
        await run(tabId, now);

        // 1s heartbeat so you can see progress live in SW console
        if (now - lastFpsLog >= 5000) {
          console.log(`[X-BOT/bg] fps=${engine.fps} frames=${engine.frameCount} queue=${queueSize()} active=${getActiveMeta() ? getActiveMeta().type : "none"}`);
          lastFpsLog = now;
        }

        // Cap the outer loop to ~240 FPS (reduces CPU + CDP round-trips)
        await sleep(OUTER_FRAME_MS);
      } catch (e) {
        console.warn("[X-BOT/bg] engine tick error:", e?.message || e);
        break;
      }
    }
  } finally {
    const st2 = getTabState(tabId);
    st2.engineTicking = false;
    await maybeDetach(tabId);
  }
}

// Invalidate cached layout when the DOM/page changes so we re-measure next frame.
chrome.debugger.onEvent.addListener((source, method, _params) => {
  const tabId = source?.tabId;
  if (!tabId) return;
  if (method === "DOM.documentUpdated" || method === "Page.frameNavigated") {
    invalidateLayout(tabId);
    if (DEBUG_LOG_STEPS) {
      console.log(`[X-BOT/bg] layout invalidated due to ${method} (tab=${tabId})`);
    }
  }
});

// ---- Message router ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender?.tab?.id;
  const finish = (payload) => { try { sendResponse(payload); } catch {} };

  (async () => {
    if (!tabId) throw new Error("No sender tabId");

    if (msg.type === "XBOT_CANCEL") {
      if (DEBUG_LOG_STEPS) console.log("[X-BOT/bg] Detach requested via XBOT_CANCEL");
      try { await chrome.debugger.detach({ tabId }); } catch {}
      const st = getTabState(tabId);
      st.attached = false;
      st.running = false;
      st.engineTicking = false;
      finish({ ok: true });
      return;
    }

    // Engine controls
    if (msg.type === "XBOT_ENGINE_PLAY") {
      const st = getTabState(tabId);
      st.running = true;
      if (DEBUG_LOG_STEPS) console.log("[X-BOT/bg] ENGINE: play");
      engineLoop(tabId); // fire-and-forget
      finish({ ok: true, running: true });
      return;
    }
    if (msg.type === "XBOT_ENGINE_PAUSE") {
      const st = getTabState(tabId);
      st.running = false;
      if (DEBUG_LOG_STEPS) console.log("[X-BOT/bg] ENGINE: pause");
      finish({ ok: true, running: false });
      return;
    }
    if (msg.type === "XBOT_ENGINE_STATUS") {
      const st = getTabState(tabId);
      finish({
        ok: true,
        running: !!st.running,
        attached: !!st.attached,
        locks: st.locks,
        fps: engine.fps,
        frames: engine.frameCount,
        queue_len: queueSize() + (getActiveMeta() ? 1 : 0),
        active_job: getActiveMeta(),
      });
      return;
    }

    // Queue endpoints
    if (msg.type === "XBOT_QUEUE_ADD") {
      const { workType, payload } = msg;
      const item = enqueueWork(workType, payload || {});
      finish({ ok: true, id: item.id, queue_len: queueSize() });
      return;
    }
    if (msg.type === "XBOT_QUEUE_PEEK") {
      finish({ ok: true, items: queuePeek(), queue_len: queueSize() });
      return;
    }

    // (optional) keep writer endpoints available
    if (msg.type === "XBOT_FOCUS_AND_TYPE") {
      await Writer.focusAndType(tabId, msg.text || "");
      finish({ ok: true });
      return;
    }
    if (msg.type === "XBOT_SUBMIT") {
      await Writer.submit(tabId, { isMac: !!msg.isMac });
      finish({ ok: true });
      return;
    }

    finish({ ok: false, error: "Unknown message type" });
  })().catch(err => {
    console.error("[X-BOT] background error:", err);
    finish({ ok: false, error: err.message });
  });

  return true; // keep channel open
});
