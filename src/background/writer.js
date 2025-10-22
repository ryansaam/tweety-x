// writer.js — editor focus/type/submit built atop CDP helpers
import { withDebugger, getRoot, getAttributes, centerClick, pressKey } from "./cdp.js";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function focusEditor(tabId) {
  const root = await getRoot(tabId);
  const selectors = [
    '[data-testid="tweetTextarea_0"][contenteditable="true"]',
    '[contenteditable="true"][data-testid^="tweetTextarea"]',
    'div[role="textbox"][contenteditable="true"]',
  ];
  for (const selector of selectors) {
    const { nodeId } = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
      nodeId: root.nodeId, selector,
    });
    if (nodeId) {
      await centerClick(tabId, nodeId);
      return true;
    }
  }
  return false;
}

async function clearEditor(tabId) {
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", modifiers: 8 });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 8 });
  await sleep(30);
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", modifiers: 2 });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
}

async function typeHumanish(tabId, text) {
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
    '[data-testid="tweetButtonInline"]',
    '[data-testid="tweetButton"]',
    'div[role="button"][data-testid="tweetButton"]',
    'div[role="button"][data-testid*="tweetButton"]',
    'div[role="button"][aria-label*="Post"]',
    'div[role="button"][aria-label*="Tweet"]',
  ];
  for (const selector of selectors) {
    const { nodeId } = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", { nodeId: root.nodeId, selector });
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

export const Writer = {
  async focusAndType(tabId, text) {
    return withDebugger(tabId, async () => {
      const focused = await focusEditor(tabId);
      if (!focused) throw new Error("Editor not found to focus");
      await sleep(120);
      await clearEditor(tabId);
      await sleep(80);
      await typeHumanish(tabId, text || "");
      await sleep(200);
    });
  },
  async submit(tabId, { isMac = false } = {}) {
    return withDebugger(tabId, async () => {
      await pressKey(tabId, "Enter");
      await sleep(180);
      await pressKey(tabId, "Enter", { modifiers: isMac ? 8 : 2 });
      await sleep(220);
      const clicked = await clickEnabledTweetButton(tabId);
      if (!clicked) throw new Error("Enabled Post button not found");
      await sleep(300);
    });
  },
};
