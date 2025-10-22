// scroll_to_next_post.js
// Scrolls the next tweet (below the timeline anchor) under the tab bar at a given speed (px/s).
import { ensureTimelineAnchor } from "../layout.js";

// Helper: find the closest tweet cell (ancestor `div[data-testid="cellInnerDiv"]`)
// below anchor.bottom and extract its /status/ID
async function findNextPostBelow(tabId, anchorBottom) {
  // Query all tweet articles
  const { root } = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", { depth: -1 });
  const { nodeIds } = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelectorAll", {
    nodeId: root.nodeId,
    selector: 'article[role="article"][data-testid="tweet"]',
  });
  if (!nodeIds || nodeIds.length === 0) {
    console.log("[X-BOT/bg] findNextPostBelow: no tweet articles found");
    return null;
  }
  console.log("[X-BOT/bg] findNextPostBelow: tweet articles:", nodeIds.length, "sample:", nodeIds.slice(0, 8));

  let best = null;
  for (const nodeId of nodeIds) {
    try {
      // Resolve the ARTICLE node to a JS object, then walk up to the closest
      // ancestor with data-testid="cellInnerDiv" (the positioned virtualized cell).
      const { object } = await chrome.debugger.sendCommand({ tabId }, "DOM.resolveNode", { nodeId });
      if (!object?.objectId) {
        console.log("[X-BOT/bg] findNextPostBelow: resolveNode returned no object for article", nodeId);
        continue;
      }
      const { result: ancRes } = await chrome.debugger.sendCommand({ tabId }, "Runtime.callFunctionOn", {
        objectId: object.objectId,
        // walk parents until we find the virtual list cell
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
      if (!ancRes?.objectId) {
        // No cell ancestor -> skip (ads, odd layouts, etc.)
        console.log("[X-BOT/bg] findNextPostBelow: no cellInnerDiv ancestor for article", nodeId);
        continue;
      }
      const { nodeId: cellId } = await chrome.debugger.sendCommand({ tabId }, "DOM.requestNode", {
        objectId: ancRes.objectId,
      });
      if (!cellId) {
        console.log("[X-BOT/bg] findNextPostBelow: requestNode failed for ancestor (article)", nodeId);
        continue;
      }

      // Measure the ancestor cell's box; this owns the real layout.
      const { model } = await chrome.debugger.sendCommand({ tabId }, "DOM.getBoxModel", { nodeId: cellId });
      const c = model?.content || [];
      if (c.length < 8) {
        console.log("[X-BOT/bg] findNextPostBelow: cellInnerDiv had invalid content box", cellId);
        continue;
      }
      const top = Math.min(c[1], c[3], c[5], c[7]);
      if (top <= anchorBottom) continue; // only below anchor
      const dy = Math.round(top - anchorBottom);
      console.log("[X-BOT/bg] findNextPostBelow: candidate cell", cellId, "from article", nodeId, "top-offset", dy);

      // === Plan A: query the anchor directly inside the article ===
      // We look for the tweet's permalink anchor: <a role="link" href="/.../status/123...">
      const { nodeId: anchorNode } = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
        nodeId,
        selector: 'a[role="link"][href*="/status/"]',
      });
      if (!anchorNode) {
        console.log("[X-BOT/bg] findNextPostBelow: no status anchor in article", nodeId);
        continue;
      }

      const { attributes } = await chrome.debugger.sendCommand({ tabId }, "DOM.getAttributes", { nodeId: anchorNode });
      let href = "";
      for (let i = 0; i < attributes.length; i += 2) {
        if (attributes[i] === "href") { href = attributes[i + 1] || ""; break; }
      }
      if (!href) {
        console.log("[X-BOT/bg] findNextPostBelow: anchor missing href in article", nodeId);
        continue;
      }
      const m = href.match(/\/status\/(\d+)/);
      if (!m) {
        console.log("[X-BOT/bg] findNextPostBelow: href didn't match /status/…", href);
        continue;
      }
      const id = m[1];

      if (!best || top < best.top) {
        best = { nodeId, cellId, top, id, href };
        console.log(`[X-BOT/bg] candidate tweet: id=${id} href=${href} top=${Math.round(top)} (new best via cell ${cellId})`);
      }
    } catch (err) {
      // Ignore failures for individual nodes, but log for visibility
      console.warn("[X-BOT/bg] findNextPostBelow: error probing article", nodeId, err && (err.data || err.message || err));
    }
  }
  if (!best) console.log("[X-BOT/bg] findNextPostBelow: no candidate found below anchor");
  return best;
}

// ---- Diagnostics helpers ---------------------------------------------------
async function debugNodeDiagnostics(tabId, nodeId) {
  try {
    // 1) Basic node info (name, attrs)
    const desc = await chrome.debugger.sendCommand({ tabId }, "DOM.describeNode", { nodeId, depth: 0, pierce: true });
    const n = desc?.node || {};
    const shortAttrs = {};
    if (Array.isArray(n.attributes)) {
      for (let i = 0; i < n.attributes.length; i += 2) {
        const k = n.attributes[i]; const v = n.attributes[i + 1] || "";
        if (k === "id" || k === "class" || k === "role" || k === "data-testid") shortAttrs[k] = v;
      }
    }
    console.log("[X-BOT/bg][diag] node:", {
      nodeId,
      nodeName: n.nodeName,
      localName: n.localName,
      attrs: shortAttrs,
      childNodeCount: n.childNodeCount,
    });

    // 2) Computed styles (display/visibility/pointer-events)
    try {
      await chrome.debugger.sendCommand({ tabId }, "CSS.enable");
      const cs = await chrome.debugger.sendCommand({ tabId }, "CSS.getComputedStyleForNode", { nodeId });
      const want = ["display", "visibility", "pointer-events"];
      const map = {};
      for (const e of cs?.computedStyle || []) {
        if (want.includes(e.name)) map[e.name] = e.value;
      }
      console.log("[X-BOT/bg][diag] computedStyle:", map);
    } catch (e) {
      console.log("[X-BOT/bg][diag] CSS.getComputedStyleForNode failed:", e?.message || e);
    }

    // 3) BoundingClientRect fallback via Runtime (works even when BoxModel fails)
    try {
      const { object: obj } = await chrome.debugger.sendCommand({ tabId }, "DOM.resolveNode", { nodeId });
      if (obj?.objectId) {
        const evalRes = await chrome.debugger.sendCommand({ tabId }, "Runtime.callFunctionOn", {
          objectId: obj.objectId,
          functionDeclaration: `
            function() {
              try {
                const r = this.getBoundingClientRect();
                const s = window.getComputedStyle(this);
                return {
                  ok: true,
                  rect: { x: r.x, y: r.y, top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height },
                  style: { display: s.display, visibility: s.visibility, pointerEvents: s.pointerEvents }
                };
              } catch (e) { return { ok:false, error: String(e) }; }
            }
          `,
          returnByValue: true,
        });
        console.log("[X-BOT/bg][diag] BCR:", evalRes?.result?.value || evalRes);
      } else {
        console.log("[X-BOT/bg][diag] DOM.resolveNode returned no objectId");
      }
    } catch (e) {
      console.log("[X-BOT/bg][diag] Runtime.callFunctionOn failed:", e?.message || e);
    }
  } catch (outer) {
    console.log("[X-BOT/bg][diag] debugNodeDiagnostics failed:", outer?.message || outer);
  }
}

// Job lifecycle
// payload: { speed } in px/s
export function begin(job, tabId) {
  job._rt = { tabId, inited: false };
  return true;
}

export function tick(job, dtMs) {
  // pure math accrual only; actual setup done in render when needed
  const rt = job._rt;
  if (!rt) return;
  if (rt.done) return;
  if (!rt.inited) return; // wait for first render to initialize geometry
  rt.progressPx = Math.min(rt.targetDelta, (rt.progressPx || 0) + (rt.speed * (dtMs / 1000)));
}

export async function render(job, { tabId, mouseWheel, frameAlpha, dtPerTick }) {
  const rt = job._rt;
  if (!rt.inited) {
    // Initialize anchor + target distance
    const anchor = await ensureTimelineAnchor(tabId);
    if (!anchor) {
      console.warn("[X-BOT/bg] scroll_to_next_post: anchor not found; abort");
      rt.done = true;
      return true;
    }
    console.log(`[X-BOT/bg] scroll_to_next_post: anchor bottom = ${Math.round(anchor.rect.bottom)}`);
    const next = await findNextPostBelow(tabId, anchor.rect.bottom);
    if (!next) {
      console.warn("[X-BOT/bg] scroll_to_next_post: no post found below anchor; abort");
      rt.done = true;
      return true;
    }
    const p = job.payload || {};
    let speed = Number(p.speed);
    if (!Number.isFinite(speed) || speed <= 0) speed = 1600; // px/s default

    rt.anchorBottom = anchor.rect.bottom;
    // Use the measured top of the cell (not the article) to compute scroll distance.
    rt.targetDelta = Math.max(0, next.top - anchor.rect.bottom);
    rt.speed = speed;
    rt.progressPx = 0;
    rt.inited = true;
    console.log(`[X-BOT/bg] scroll_to_next_post init: id=${next.id} delta=${rt.targetDelta}px speed=${rt.speed} px/s (cellId=${next.cellId})`);
  }

  if (rt.done) return true;

  // Interpolate within current frame for smoother motion
  const extra = rt.speed * (frameAlpha * (dtPerTick / 1000));
  const ideal = Math.min(rt.targetDelta, (rt.progressPx || 0) + extra);

  // Amount to scroll this frame (down = positive deltaY)
  const already = rt.sentPx || 0;
  let thisFrame = Math.max(0, ideal - already);
  if (thisFrame > 0) {
    await mouseWheel(tabId, { deltaY: thisFrame, x: 0, y: 0 });
    rt.sentPx = already + thisFrame;
  }

  // Complete?
  if ((rt.progressPx || 0) >= rt.targetDelta) {
    rt.done = true;
    return true;
  }
  return false;
}
