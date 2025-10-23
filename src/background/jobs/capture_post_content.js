// capture_post_content.js
// Find the nearest tweet article (by its cell), click "Show more" via CDP if present,
// then extract fields from THAT SAME article. Skips ads/videos. Sends result to content.
import { ensureTimelineAnchor } from "../layout.js";
import { centerClick } from "../cdp.js";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function topFromBoxModel(model) {
  const c = model?.content || [];
  if (c.length < 8) return null;
  // content array is [x0,y0, x1,y1, x2,y2, x3,y3]
  const ys = [c[1], c[3], c[5], c[7]];
  return Math.min(...ys);
}

async function findNearestArticleNode(tabId, anchorBottom) {
  // 1) Find all tweet articles
  const { root } = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", { depth: -1 });
  const { nodeIds: articleIds } = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelectorAll", {
    nodeId: root.nodeId,
    selector: 'article[role="article"][data-testid="tweet"]',
  });
  if (!articleIds || articleIds.length === 0) return null;

  let best = null;
  for (const artId of articleIds) {
    try {
      // Walk up to the virtualized cellInnerDiv ancestor
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

      // Measure cell top via BoxModel
      const { model } = await chrome.debugger.sendCommand({ tabId }, "DOM.getBoxModel", { nodeId: cellId });
      const top = topFromBoxModel(model);
      if (!Number.isFinite(top)) continue;
      const dy = top - anchorBottom;
      const cand = { artId, cellId, top, dy, abs: Math.abs(dy) };
      if (!best) best = cand;
      else if (cand.abs < best.abs || (cand.abs === best.abs && cand.dy >= 0 && best.dy < 0)) best = cand;
    } catch (_) {
      // ignore this article on error
    }
  }
  return best ? best.artId : null;
}

async function clickShowMoreIfPresent(tabId, articleNodeId) {
  // Search inside the known article only
  const { nodeId: btnId } = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
    nodeId: articleNodeId,
    selector: 'button[data-testid="tweet-text-show-more-link"]',
  });
  if (!btnId) return false;
  try {
    await centerClick(tabId, btnId);
    await sleep(160); // allow reflow/expansion
    return true;
  } catch {
    return false;
  }
}

async function extractFromArticle(tabId, articleNodeId) {
  const { object } = await chrome.debugger.sendCommand({ tabId }, "DOM.resolveNode", { nodeId: articleNodeId });
  if (!object?.objectId) return { ok: false, skipped_reason: "resolve_failed" };
  const { result } = await chrome.debugger.sendCommand({ tabId }, "Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: `
      function() {
        try {
          const art = this;
          // Skip Ads
          const hasAd = !!Array.from(art.querySelectorAll('span')).find(s => (s.textContent || '').trim() === 'Ad');
          if (hasAd) return { ok:false, skipped_reason:'ad' };
          // Skip videos (for now)
          if (art.querySelector('video, [data-testid="videoComponent"]')) {
            return { ok:false, skipped_reason:'video' };
          }
          const userBox = art.querySelector('[data-testid="User-Name"]');
          if (!userBox) return { ok:false, skipped_reason:'user_box_missing' };

          // Username + display name
          const links = Array.from(userBox.querySelectorAll('a[role="link"][href^="/"]'));
          let handleLink = links.find(a => (a.textContent || '').trim().startsWith('@'));
          if (!handleLink && links.length >= 2) {
            const guess = links[1];
            if ((guess.textContent || '').trim().startsWith('@')) handleLink = guess;
          }
          const usernameText = (handleLink && handleLink.textContent) ? handleLink.textContent.trim() : '';
          const username = usernameText.replace(/^@/, '');
          let nameLink = links.find(a => !(a.textContent || '').trim().startsWith('@')) || null;
          const author_name = (nameLink ? (nameLink.innerText || '').trim() : '') || '';

          // Timestamp + href/id
          const timeEl = userBox.querySelector('time');
          const timestamp_iso = timeEl ? (timeEl.getAttribute('datetime') || '') : '';
          let post_href = '';
          let post_id = '';
          const timeAnchor = timeEl ? timeEl.closest('a[href*="/status/"]') : null;
          if (timeAnchor) post_href = timeAnchor.getAttribute('href') || '';
          if (!post_href) {
            const any = art.querySelector('a[href*="/status/"]');
            if (any) post_href = any.getAttribute('href') || '';
          }
          const m = post_href.match(/\\/status\\/(\\d+)/);
          if (m) post_id = m[1];

          // Text content (after potential expansion)
          const textBlocks = Array.from(art.querySelectorAll('div[data-testid="tweetText"]'));
          const text = textBlocks.map(b => (b.innerText || '').trim()).filter(Boolean).join('\\n');

          // Images
          const imgEls = Array.from(art.querySelectorAll('div[data-testid="tweetPhoto"] img'));
          const image_urls = Array.from(new Set(imgEls.map(img => img.getAttribute('src') || '').filter(Boolean)));

          return {
            ok: true,
            post: { post_id, post_href, timestamp_iso, author_name, username, text, image_urls }
          };
        } catch (e) {
          return { ok:false, skipped_reason:'extract_failed' };
        }
      }
    `,
    returnByValue: true,
    silent: true,
  });
  return result?.value || { ok: false, skipped_reason: "no_result" };
}

export function begin(job, tabId) {
  job._rt = { tabId, inited: true };
  return true;
}

export function tick(_job, _dtMs) {
  // no-op: single-shot capture in render()
}

export async function render(job, { tabId }) {
  const rt = job._rt;
  if (rt.done) return true;

  const anchor = await ensureTimelineAnchor(tabId);
  if (!anchor) {
    console.warn("[X-BOT/bg] capture_post_content: anchor not found; abort");
    rt.done = true;
    return true;
  }
  const anchorBottom = anchor.rect.bottom;

  try {
    // Find the nearest article by its cell top (stable measurement)
    const artId = await findNearestArticleNode(tabId, anchorBottom);
    if (!artId) {
      await chrome.tabs.sendMessage(tabId, { type: "XBOT_CAPTURED_POST_SKIPPED", reason: "no_article_near_anchor" });
      rt.done = true; return true;
    }

    // Real click on "Show more" if present, let layout settle
    await clickShowMoreIfPresent(tabId, artId);

    // Extract from THAT SAME article
    const val = await extractFromArticle(tabId, artId);
    if (val && val.ok && val.post) {
      try {
        await chrome.tabs.sendMessage(tabId, { type: "XBOT_CAPTURED_POST", payload: val.post });
      } catch (e) {
        console.warn("[X-BOT/bg] capture_post_content: sendMessage failed", e?.message || e);
      }
    } else {
      const reason = val?.skipped_reason || "unknown";
      try { await chrome.tabs.sendMessage(tabId, { type: "XBOT_CAPTURED_POST_SKIPPED", reason }); } catch {}
    }
  } catch (e) {
    console.warn("[X-BOT/bg] capture_post_content: error:", e?.message || e);
    try { await chrome.tabs.sendMessage(tabId, { type: "XBOT_CAPTURED_POST_SKIPPED", reason: "exception" }); } catch {}
  }

  rt.done = true;
  return true;
}