//runner.js

import { dequeue as queueDequeue } from "../queue.js";
import { mouseMove, mouseWheel } from "../cdp.js";
import { TICK_DT_MS } from "../engine.js";
import * as MouseMove from "./mouse_move.js";
import * as ScrollToNext from "./scroll_to_next_post.js";
import * as CapturePost from "./capture_post_content.js";

// Simple registry; expand with more job types later.
const REGISTRY = {
  "mouse_move": MouseMove,
  "scroll_to_next_post": ScrollToNext,
  "capture_post_content": CapturePost,
};

let activeJob = null; // { id, type, payload, _rt:{} }

export function getActiveMeta() {
  return activeJob ? { id: activeJob.id, type: activeJob.type } : null;
}

export async function tick(tabId, dtMs) {
  if (!activeJob) {
    const next = queueDequeue();
    if (next && REGISTRY[next.type]?.begin) {
      console.log(`[X-BOT/bg] processing event: ${next.type} (id=${next.id})`);
      const ok = REGISTRY[next.type].begin(next, tabId);
      if (!ok) {
        // drop if cannot start
        activeJob = null;
      } else {
        activeJob = next;
      }
    }
  }
  if (!activeJob) return;
  const impl = REGISTRY[activeJob.type];
  if (!impl?.tick) return;
  impl.tick(activeJob, dtMs);
}

export async function render(tabId, frameAlpha, dtPerTick) {
  if (!activeJob) return;
  const impl = REGISTRY[activeJob.type];
  if (!impl?.render) return;
  const done = await impl.render(activeJob, {
    tabId,
    frameAlpha,
    dtPerTick: dtPerTick ?? TICK_DT_MS,
    mouseMove,
    mouseWheel,
  });
  if (done) {
    console.log(`[X-BOT/bg] event complete: ${activeJob.type} #${activeJob.id}`);
    activeJob = null;
  }
}