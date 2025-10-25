// generate_post_reply.js
import { getTabState, setLastGeneratedReply } from "../engine.js";

// Normalize stored server URL to a base host (back-compat if someone saved `/generate`)
function normalizeServerBase(serverUrl) {
  try {
    if (!serverUrl) return "http://localhost:11000";
    const u = new URL(serverUrl);
    // If user previously saved the full /generate endpoint, trim it to the host root.
    if (u.pathname === "/generate" || u.pathname.endsWith("/generate")) {
      u.pathname = "/";
    }
    // Ensure no trailing slash
    return u.origin + (u.pathname && u.pathname !== "/" ? u.pathname.replace(/\/$/, "") : "");
  } catch {
    return "http://localhost:11000";
  }
}

// job.payload: {}
export function begin(job, tabId) {
  const st = getTabState(tabId);
  const post = st.lastCapturedPost;
  if (!post || (!post.text && (!post.image_urls || post.image_urls.length === 0))) {
    job._rt = { phase: "error", error: "No captured post available" };
    return true; // finish immediately with error; render() will emit
  }

  job._rt = {
    tabId,
    phase: "requesting",
    doneOk: null,
    error: null,
    result: null,
    idleDelayMs: 80, // hint the engine to relax while we wait
  };

  // Kick off fetch without blocking the job
  (async () => {
    try {
      // Prefer storing the BASE in settings now; still tolerate older `/generate` value.
      const { serverUrl } = await chrome.storage.sync.get({ serverUrl: "http://localhost:11000" });
      const base = normalizeServerBase(serverUrl);
      const url = `${base}/generate_reply`;

      const body = JSON.stringify({
        platform: "x",
        post: {
          post_id: post.post_id,
          post_href: post.post_href,
          timestamp_iso: post.timestamp_iso,
          author_name: post.author_name,
          username: post.username,
          text: post.text,
          image_urls: post.image_urls || [],
        },
      });

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      job._rt.result = json; // { reply, why, id }
      job._rt.phase = "done";
      job._rt.doneOk = true;
    } catch (e) {
      job._rt.error = e?.message || String(e);
      job._rt.phase = "error";
      job._rt.doneOk = false;
    }
  })();

  return true;
}

export function tick(_job, _dt) {
  // no-op: network is in-flight
}

export async function render(job, { tabId, postToContent, setIdleHint }) {
  const rt = job._rt;
  if (!rt) return true;

  if (rt.phase === "requesting") {
    // Ask engine loop to idle gently this iteration
    setIdleHint?.(rt.idleDelayMs || 80);
    return false; // still waiting
  }

  if (rt.phase === "done" && rt.doneOk) {
    try {
      // cache result in engine state
      setLastGeneratedReply(tabId, rt.result || null);
      // notify content for UI
      postToContent?.({ type: "XBOT_REPLY_READY", payload: rt.result || {} });
    } catch {}
    return true;
  }

  if (rt.phase === "error") {
    try {
      postToContent?.({ type: "XBOT_DEBUG", tag: "reply_error", payload: { error: rt.error } });
    } catch {}
    return true;
  }

  return true;
}
