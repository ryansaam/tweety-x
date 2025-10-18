// background.js
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withDebugger(tabId, fn) {
  await chrome.debugger.attach({ tabId }, "1.3");
  try { return await fn(); }
  finally { try { await chrome.debugger.detach({ tabId }); } catch {} }
}

async function pressKey(tabId, key, { modifiers = 0 } = {}) {
  const base = {
    key, code: key, windowsVirtualKeyCode: key === "Enter" ? 13 : 0, nativeVirtualKeyCode: key === "Enter" ? 13 : 0, modifiers
  };
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

async function getRoot(tabId) {
  const { root } = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", { depth: -1 });
  return root;
}

async function getAttributes(tabId, nodeId) {
  const { attributes } = await chrome.debugger.sendCommand({ tabId }, "DOM.getAttributes", { nodeId });
  // attributes: [name, value, name, value, ...] -> map
  const map = {};
  for (let i = 0; i < attributes.length; i += 2) map[attributes[i]] = attributes[i + 1] ?? "";
  return map;
}

async function centerClick(tabId, nodeId) {
  const { model } = await chrome.debugger.sendCommand({ tabId }, "DOM.getBoxModel", { nodeId });
  const [x1, y1, x2, y2] = [model.content[0], model.content[1], model.content[4], model.content[5]];
  const cx = Math.round((x1 + x2) / 2), cy = Math.round((y1 + y2) / 2);
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });
}

async function focusEditor(tabId) {
  const root = await getRoot(tabId);
  // Try a few selectors that X uses for the editor
  const selectors = [
    '[data-testid="tweetTextarea_0"][contenteditable="true"]',
    '[contenteditable="true"][data-testid^="tweetTextarea"]',
    'div[role="textbox"][contenteditable="true"]',
  ];
  for (const selector of selectors) {
    const { nodeId } = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
      nodeId: root.nodeId, selector
    });
    if (nodeId) {
      await centerClick(tabId, nodeId);
      return true;
    }
  }
  return false;
}

async function typeHumanish(tabId, text) {
  // CDP typing with small random pauses, chunking by 3–6 chars
  let i = 0;
  while (i < text.length) {
    const chunkLen = Math.min(text.length - i, Math.floor(Math.random() * 4) + 3);
    const chunk = text.slice(i, i + chunkLen);
    await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text: chunk });
    i += chunkLen;
    await sleep(Math.floor(Math.random() * 120) + 60);
  }
}

async function clickEnabledTweetButton(tabId) {
  const root = await getRoot(tabId);
  const selectors = [
    // common testids
    '[data-testid="tweetButtonInline"]',
    '[data-testid="tweetButton"]',
    'div[role="button"][data-testid="tweetButton"]',
    'div[role="button"][data-testid*="tweetButton"]',
    // fallback based on role and label text
    'div[role="button"][aria-label*="Post"]',
    'div[role="button"][aria-label*="Tweet"]',
  ];
  for (const selector of selectors) {
    const { nodeId } = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
      nodeId: root.nodeId, selector
    });
    if (!nodeId) continue;
    const attrs = await getAttributes(tabId, nodeId);
    const ariaDisabled = (attrs["aria-disabled"] || "").toLowerCase() === "true";
    const disabled = "disabled" in attrs;
    if (!ariaDisabled && !disabled) {
      await centerClick(tabId, nodeId);
      return true;
    }
  }
  return false;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender?.tab?.id;
  const finish = (payload) => { try { sendResponse(payload); } catch {} };

  (async () => {
    if (!tabId) throw new Error("No sender tabId");

    if (msg.type === "XBOT_CANCEL") {
      console.log("[X-BOT/bg] Detach requested via XBOT_CANCEL");
      // best-effort: detach from this tab to stop any in-flight CDP actions
      try { await chrome.debugger.detach({ tabId }); } catch {}
      finish({ ok: true });
      return;
    }

    if (msg.type === "XBOT_FOCUS_AND_TYPE") {
      const { text } = msg;
      await withDebugger(tabId, async () => {
        // put a cursor in the editor first
        const focused = await focusEditor(tabId);
        if (!focused) throw new Error("Editor not found to focus");
        // small pause so Draft selection settles
        await sleep(120);
        // clear any pre-filled content: select-all + backspace
        // Try Meta+A (mac) then Ctrl+A (others)
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", modifiers: 8 /* Meta */ });
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 8 });
        await sleep(30);
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", modifiers: 2 /* Ctrl */ });
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 });
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
        await sleep(80);
        // type the text in human-ish chunks
        await typeHumanish(tabId, text);
        await sleep(250);
      });
      finish({ ok: true });
      return;
    }

    if (msg.type === "XBOT_SUBMIT") {
      const { isMac } = msg;
      console.log("[X-BOT/bg] Submit sequence starting (Enter → Ctrl/Cmd+Enter → click)");
      await withDebugger(tabId, async () => {
        // Try plain Enter (some builds accept this)
        await pressKey(tabId, "Enter");
        await sleep(200);
        // Then Ctrl/Cmd+Enter
        await pressKey(tabId, "Enter", { modifiers: isMac ? 8 /* Meta */ : 2 /* Ctrl */ });
        await sleep(250);
        // Fallback: robust button click (aria-disabled aware)
        const clicked = await clickEnabledTweetButton(tabId);
        if (!clicked) throw new Error("Enabled Post button not found");
      });
      finish({ ok: true });
      return;
    }

    // Unknown message
    finish({ ok: false, error: "Unknown message type" });
  })().catch(err => {
    console.error("[X-BOT] background error:", err);
    finish({ ok: false, error: err.message });
  });

  // IMPORTANT: keep the message channel open for async work
  return true;
});