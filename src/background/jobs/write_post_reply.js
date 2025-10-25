// write_post_reply.js
// Click the reply button in the nearest article, human-type the reply, click Post, then mark posted.
import { ensureTimelineAnchor } from "../layout.js";
import { centerClick } from "../cdp.js";
import { getTabState } from "../engine.js";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function topFromBoxModel(model) {
  const c = model?.content || [];
  if (c.length < 8) return null;
  const ys = [c[1], c[3], c[5], c[7]];
  return Math.min(...ys);
}

async function findNearestArticleNode(tabId, anchorBottom) {
  const { root } = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", { depth: -1 });
  const { nodeIds: articleIds } = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelectorAll", {
    nodeId: root.nodeId,
    selector: 'article[role="article"][data-testid="tweet"]',
  });
  if (!articleIds || articleIds.length === 0) return null;
  let best = null;
  for (const artId of articleIds) {
    try {
      const { object } = await chrome.debugger.sendCommand({ tabId }, "DOM.resolveNode", { nodeId: artId });
      if (!object?.objectId) continue;
      const { result: ancRes } = await chrome.debugger.sendCommand({ tabId }, "Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: `
          function() {
            let el = this;
            while (el && el !== document.documentElement) {
              if (el.dataset && el.dataset.testid === 'cellInnerDiv') return el;
              el = el.parentElement;
            }
            return null;
          }
        `,
        returnByValue: false,
        silent: true,
      });
      if (!ancRes?.objectId) continue;
      const { nodeId: cellId } = await chrome.debugger.sendCommand({ tabId }, "DOM.requestNode", {
        objectId: ancRes.objectId,
      });
      if (!cellId) continue;
      const { model } = await chrome.debugger.sendCommand({ tabId }, "DOM.getBoxModel", { nodeId: cellId });
      const top = topFromBoxModel(model);
      if (!Number.isFinite(top)) continue;
      const dy = top - anchorBottom;
      const cand = { artId, dy, abs: Math.abs(dy) };
      if (!best) best = cand;
      else if (cand.abs < best.abs || (cand.abs === best.abs && cand.dy >= 0 && best.dy < 0)) best = cand;
    } catch { /* ignore */ }
  }
  return best ? best.artId : null;
}

async function clickReply(tabId, articleNodeId) {
  const { nodeId: btnId } = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
    nodeId: articleNodeId,
    selector: 'button[data-testid="reply"]',
  });
  if (!btnId) throw new Error("reply_button_not_found");
  await centerClick(tabId, btnId);
  await sleep(150);
}

async function waitForReplyModal(tabId, { timeoutMs = 2000, pollMs = 120 } = {}) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const { root } = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", { depth: -1 });
    const { nodeId: dialogId } = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
      nodeId: root.nodeId,
      selector: 'div[role="dialog"][aria-labelledby="modal-header"]',
    });
    if (dialogId) return { dialogId, elapsed: Math.round(performance.now() - start) };
    await sleep(pollMs);
  }
  return { dialogId: null, elapsed: Math.round(performance.now() - start) };
}

// --- NEW: robust composer lookup inside the reply dialog ---
async function findComposerInDialog(tabId, dialogNodeId) {
  const tryQuery = async (selector) => {
    const { nodeId } = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
      nodeId: dialogNodeId, selector,
    });
    return nodeId || null;
  };
  // X frequently uses role="textbox" + contenteditable on the inner div; testids vary.
  const selectors = [
    'div[role="textbox"][contenteditable="true"]:not([aria-hidden="true"])',
    '[data-testid^="tweetTextarea"] div[role="textbox"][contenteditable="true"]',
    '[data-testid^="tweetTextarea"] [contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
  ];
  for (const sel of selectors) {
    const id = await tryQuery(sel);
    if (id) return id;
  }
  return null;
}

async function clickPost(tabId) {
  const { root } = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", { depth: -1 });
  const { nodeId: dialogId } = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
    nodeId: root.nodeId,
    selector: 'div[role="dialog"][aria-labelledby="modal-header"]',
  });
  if (!dialogId) throw new Error("composer_dialog_not_found");
  const { nodeId: postBtn } = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
    nodeId: dialogId,
    selector: 'button[data-testid="tweetButton"]',
  });
  if (!postBtn) throw new Error("tweet_button_not_found");
  await centerClick(tabId, postBtn);
  await sleep(250);
}

// Focus the exact contenteditable node via CDP and bring page to front
async function focusNode(tabId, nodeId) {
  await chrome.debugger.sendCommand({ tabId }, "DOM.focus", { nodeId });
  await chrome.debugger.sendCommand({ tabId }, "Page.bringToFront");
  await sleep(40);
}

// Insert a single character at the caret using Input.insertText
async function insertChar(tabId, ch) {
  await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text: ch });
}

function sliceTo280(str) {
  str = String(str ?? "");
  if (str.length <= 280) return str;
  let s = str.slice(0, 280);
  const last = s.charCodeAt(s.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) s = s.slice(0, -1);
  return s;
}
const rand = (a, b) => a + Math.random() * (b - a);

async function humanType(tabId, text, maxCPS, setIdleHint) {
  const cps = Math.max(3, Math.min(30, Math.floor(maxCPS || 12)));
  const base = 1000 / cps;
  const chars = Array.from(sliceTo280(text)); // safe even if text was non-string

  return {
    async typeInto() {
      for (const ch of chars) {
        await insertChar(tabId, ch);
        let d = base * rand(0.6, 1.6);
        if (/[.,?!:)]/.test(ch)) d += rand(40, 120);
        if (Math.random() < 0.05) d += rand(100, 220);
        setIdleHint?.(Math.max(8, Math.min(50, Math.floor(d))));
        await sleep(d);
      }
    }
  };
}

function baseUrlFromStored(serverUrl) {
  try {
    if (!serverUrl) return "http://localhost:11000";
    const u = new URL(serverUrl);
    if (u.pathname.endsWith("/generate")) u.pathname = "/";
    return u.origin + (u.pathname.endsWith("/") ? u.pathname.slice(0, -1) : u.pathname);
  } catch {
    return "http://localhost:11000";
  }
}

export function begin(job, tabId) {
  const st = getTabState(tabId);
  // Prefer server's "reply" field; keep "x_reply" for back-compat
  const text =
    job?.payload?.text ??
    st?.lastGeneratedReply?.reply ??
    st?.lastGeneratedReply?.x_reply ??
    "";
  if (!text || typeof text !== "string") {
    job._rt = { phase: "error", error: "no_reply_text" };
    return true; // render() will now short-circuit (see below)
  }
  job._rt = {
    tabId,
    text,
    maxCPS: (job.payload && job.payload.maxCPS) || 12,
    started: false,
    done: false,
    error: null,
  };
  return true;
}

export function tick() { /* no-op */ }

export async function render(job, { tabId, setIdleHint, postToContent }) {
  const rt = job._rt;
  if (!rt || rt.done || rt.started) return !!rt?.done;
  // If begin() marked an error (e.g., missing text), exit cleanly and notify UI
  if (rt.phase === "error") {
    postToContent?.({ type: "XBOT_REPLY_POST_FAILED", payload: { ok: false, reason: rt.error || "unknown" } });
    rt.done = true;
    return true;
  }
  rt.started = true;
  try {
    const anchor = await ensureTimelineAnchor(tabId);
    if (!anchor) throw new Error("anchor_not_found");
    const artId = await findNearestArticleNode(tabId, anchor.rect.bottom);
    if (!artId) throw new Error("article_not_found");

    await clickReply(tabId, artId);

    // Wait for modal + locate composer, then click inside once to hard-focus caret.
    const modal = await waitForReplyModal(tabId, { timeoutMs: 2000, pollMs: 120 });
    if (!modal.dialogId) throw new Error("composer_dialog_not_found");
    const composerId = await findComposerInDialog(tabId, modal.dialogId);
    if (!composerId) throw new Error("composer_not_found");

    // Ensure actual caret focus on the contenteditable
    await focusNode(tabId, composerId);

    // Type per char using Input.insertText with human pacing
    const typer = await humanType(tabId, rt.text, rt.maxCPS, setIdleHint);

    await typer.typeInto();
    await clickPost(tabId);

    // Best-effort mark posted
    const st = getTabState(tabId);
    const replyId = st.lastGeneratedReply && st.lastGeneratedReply.id;
    if (replyId) {
      const { serverUrl } = await chrome.storage.sync.get({ serverUrl: "http://localhost:11000/generate" });
      const base = baseUrlFromStored(serverUrl);
      try {
        await fetch(`${base}/mark_posted`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reply_id: replyId }),
        });
      } catch { /* ignore */ }
    }

    postToContent?.({ type: "XBOT_REPLY_POSTED", payload: { ok: true } });
  } catch (e) {
    postToContent?.({ type: "XBOT_REPLY_POST_FAILED", payload: { ok: false, reason: e?.message || String(e) } });
  }
  rt.done = true;
  return true;
}