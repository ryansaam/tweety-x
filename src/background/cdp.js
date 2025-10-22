// cdp.js — low-level CDP helpers (attach/withDebugger + primitives)
import { getTabState } from "./engine.js";

export async function attachIfNeeded(tabId) {
  const st = getTabState(tabId);
  if (!st.attached) {
    await chrome.debugger.attach({ tabId }, "1.3");
    st.attached = true;
  }
}

export async function maybeDetach(tabId) {
  const st = getTabState(tabId);
  if (st.attached && !st.running && st.locks === 0) {
    try { await chrome.debugger.detach({ tabId }); } catch {}
    st.attached = false;
  }
}

export async function withDebugger(tabId, fn) {
  const st = getTabState(tabId);
  await attachIfNeeded(tabId);
  st.locks++;
  try {
    return await fn();
  } finally {
    st.locks = Math.max(0, st.locks - 1);
    await maybeDetach(tabId);
  }
}

// Small primitives used by writer.js
export async function pressKey(tabId, key, { modifiers = 0 } = {}) {
  const base = {
    key,
    code: key,
    windowsVirtualKeyCode: key === "Enter" ? 13 : 0,
    nativeVirtualKeyCode: key === "Enter" ? 13 : 0,
    modifiers,
  };
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

export async function getRoot(tabId) {
  const { root } = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", { depth: -1 });
  return root;
}

export async function getAttributes(tabId, nodeId) {
  const { attributes } = await chrome.debugger.sendCommand({ tabId }, "DOM.getAttributes", { nodeId });
  const map = {};
  for (let i = 0; i < attributes.length; i += 2) map[attributes[i]] = attributes[i + 1] ?? "";
  return map;
}

export async function centerClick(tabId, nodeId) {
  const { model } = await chrome.debugger.sendCommand({ tabId }, "DOM.getBoxModel", { nodeId });
  const [x1, y1, x2, y2] = [model.content[0], model.content[1], model.content[4], model.content[5]];
  const cx = Math.round((x1 + x2) / 2), cy = Math.round((y1 + y2) / 2);
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });
}

export async function mouseMove(tabId, x, y) {
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: Math.round(x),
    y: Math.round(y),
  });
}

export async function mouseWheel(tabId, { deltaY = 0, deltaX = 0, x = 0, y = 0 } = {}) {
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    deltaY: Math.round(deltaY),
    deltaX: Math.round(deltaX),
    x: Math.round(x),
    y: Math.round(y),
  });
}