// Find the nearest tweet article (by its cell), click "Show more" via CDP if present,
// pretty-scroll so the tweet cell’s BOTTOM kisses the viewport bottom (only if below the fold),
// then extract fields from THAT SAME article. Skips ads/videos. Sends result to content
// and caches it in engine state for downstream jobs.
import { ensureTimelineAnchor } from "../layout.js";
import { centerClick } from "../cdp.js";
import { setLastCapturedPost } from "../engine.js";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const EPS = 2; // px tolerance for bottom alignment

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

// Read current px/s from your injected UI control (#xbot-scroll-speed); fall back to a sane default.
async function readScrollSpeedPxPerSec(tabId, def = 200) {
  const { result } = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression: `
      (function(){
        try{
          const el = document.getElementById('xbot-scroll-speed');
          const v = el ? Number(el.value) : NaN;
          return (Number.isFinite(v) && v > 0) ? v : ${Number(def)};
        }catch(_){ return ${Number(def)}; }
      })()
    `,
    returnByValue: true,
    silent: true,
  });
  return Number(result?.value) || def;
}

// Pull the tweet /status/{id} from inside the ARTICLE
async function getStatusIdFromArticle(tabId, articleNodeId) {
  const { nodeId: anchorNode } = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
    nodeId: articleNodeId,
    selector: 'a[role="link"][href*="/status/"]',
  });
  if (!anchorNode) return null;
  const { attributes } = await chrome.debugger.sendCommand({ tabId }, "DOM.getAttributes", { nodeId: anchorNode });
  let href = "";
  for (let i = 0; i < attributes.length; i += 2) {
    if (attributes[i] === "href") { href = attributes[i + 1] || ""; break; }
  }
  const m = href.match(/\/status\/(\d+)/);
  return m ? m[1] : null;
}

// Measure the BOTTOM of the tweet’s virtualized cell by stable status id (no stale nodeIds)
async function measureCellBottomByStatus(tabId, statusId) {
  const expr = `
    (function(id){
      try {
        const a = document.querySelector('article[role="article"][data-testid="tweet"] a[role="link"][href*="/status/' + id + '"]');
        if (!a) return { ok:false, bottom:null, vh: window.innerHeight };
        let el = a;
        while (el && el !== document.documentElement) {
          if (el.dataset && el.dataset.testid === 'cellInnerDiv') break;
          el = el.parentElement;
        }
        if (!el) return { ok:false, bottom:null, vh: window.innerHeight };
        const r = el.getBoundingClientRect();
        return { ok:true, bottom:r.bottom, vh: window.innerHeight };
      } catch(_) { return { ok:false, bottom:null, vh:null }; }
    })(${JSON.stringify(String("STATUS_ID_PLACEHOLDER"))})
  `.replace("STATUS_ID_PLACEHOLDER", String(statusId));
  const { result } = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression: expr, returnByValue: true, awaitPromise: true, silent: true,
  });
  const v = result?.value || {};
  return { ok: !!v.ok, bottom: Number(v.bottom), vh: Number(v.vh) };
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
  job._rt = { tabId, inited: true, aligning: false, statusId: null, speedPxS: null };
  return true;
}

export function tick(_job, _dtMs) {
  // no-op: single-shot capture in render()
}

export async function render(job, { tabId, mouseWheel, frameAlpha, dtPerTick, setIdleHint }) {
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

    // --- Pretty scroll: align the tweet cell's BOTTOM with the viewport bottom (only if below fold) ---
    if (!rt.aligning && mouseWheel) {
      // Determine stable status id for THIS article so we can re-measure every tick
      rt.statusId = await getStatusIdFromArticle(tabId, artId);
      if (rt.statusId) {
        const m = await measureCellBottomByStatus(tabId, rt.statusId);
        if (m.ok && Number.isFinite(m.bottom) && Number.isFinite(m.vh) && (m.bottom - m.vh) > EPS) {
          rt.speedPxS = await readScrollSpeedPxPerSec(tabId, 200); // reuse UI knob; default 200 px/s
          rt.aligning = true;
          // Defer extraction until aligned
        }
      }
    }

    // If we're in alignment mode, animate over multiple frames (status-id based measurement)
    if (rt.aligning && rt.statusId) {
      const m = await measureCellBottomByStatus(tabId, rt.statusId);
      if (m.ok && Number.isFinite(m.bottom) && Number.isFinite(m.vh)) {
        const remaining = m.bottom - m.vh; // > 0 means cell bottom is below the viewport bottom
        if (remaining > EPS) {
          // Per-frame step with a gentle ease-out
          const dt = (dtPerTick || 16.6) / 1000;
          const base = Math.max(1, rt.speedPxS || 200) * dt;
          const ease = Math.max(0.35, Math.min(1, remaining / (remaining + 120)));
          const step = Math.min(remaining - EPS, base * ease);
          if (step > 0.25) {
            await mouseWheel(tabId, { deltaY: step, x: 0, y: 0 });
            setIdleHint?.(12);
            return false; // keep animating next frame
          }
        }
      }
      // Final micro-nudge if within tolerance
      const m2 = await measureCellBottomByStatus(tabId, rt.statusId);
      const resid = (m2.ok && Number.isFinite(m2.bottom) && Number.isFinite(m2.vh)) ? (m2.bottom - m2.vh) : 0;
      if (resid > 0 && resid <= EPS) {
        await mouseWheel(tabId, { deltaY: resid, x: 0, y: 0 });
        setIdleHint?.(8);
      }
      rt.aligning = false; // proceed to extraction
    }

    // Extract from THAT SAME article
    const val = await extractFromArticle(tabId, artId);
    if (val && val.ok && val.post) {
      // Cache in engine state for downstream jobs (e.g., generate_post_reply)
      try { setLastCapturedPost(tabId, val.post); } catch {}
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