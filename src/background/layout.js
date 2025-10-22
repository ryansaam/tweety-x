// layout.js
// Caches geometry for the X home tablist anchor (For You / Following bar).
// Provides: ensureTimelineAnchor(tabId), getTimelineAnchor(tabId), invalidate(tabId)

const cacheByTab = new Map(); // tabId -> { nodeId, rect, model, measuredAt }

function rectFromModel(model) {
  // model.content is [x0,y0, x1,y1, x2,y2, x3,y3]
  const c = model?.content || [];
  if (c.length < 8) return null;
  const xs = [c[0], c[2], c[4], c[6]];
  const ys = [c[1], c[3], c[5], c[7]];
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

export function getTimelineAnchor(tabId) {
  return cacheByTab.get(tabId) || null;
}

export function invalidate(tabId) {
  cacheByTab.delete(tabId);
}

export async function ensureTimelineAnchor(tabId) {
  if (cacheByTab.has(tabId)) return cacheByTab.get(tabId);

  // Query the stable tablist element:
  // <div role="tablist" data-testid="ScrollSnap-List">
  const { root } = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", { depth: -1 });
  const { nodeId } = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
    nodeId: root.nodeId,
    selector: 'div[role="tablist"][data-testid="ScrollSnap-List"]',
  });
  if (!nodeId) {
    // Not found (wrong page or not hydrated yet)
    return null;
  }
  const { model } = await chrome.debugger.sendCommand({ tabId }, "DOM.getBoxModel", { nodeId });
  const rect = rectFromModel(model);
  if (!rect) return null;

  const entry = { nodeId, rect, model, measuredAt: Date.now() };
  cacheByTab.set(tabId, entry);
  return entry;
}
