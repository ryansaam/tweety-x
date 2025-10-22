// mouse_move.js

// Job shape: { id, type:"mouse_move", payload:{ xi, yi, xf, yf, speed }, _rt:{} }
export function begin(job, tabId) {
  const p = job.payload || {};
  const xi = Number(p.xi), yi = Number(p.yi), xf = Number(p.xf), yf = Number(p.yf);
  let speed = Number(p.speed);
  if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xf) || !Number.isFinite(yf)) return false;
  if (!Number.isFinite(speed) || speed <= 0) speed = 800; // px/s default
  const dx = xf - xi, dy = yf - yi;
  const dist = Math.hypot(dx, dy);
  const dirX = dist ? dx / dist : 0, dirY = dist ? dy / dist : 0;
  job._rt = {
    tabId,
    xi, yi, xf, yf,
    dirX, dirY, dist,
    speed,                   // px/s
    progressPx: 0,           // advanced in ticks
    placed: false,           // first render puts cursor at start
    lastX: null, lastY: null,
  };
  return true;
}

export function tick(job, dtMs) {
  const rt = job._rt;
  if (!rt) return;
  rt.progressPx = Math.min(rt.progressPx + rt.speed * (dtMs / 1000), rt.dist);
}

export async function render(job, ctx) {
  const { mouseMove, frameAlpha, dtPerTick, tabId } = ctx;
  const rt = job._rt;
  if (!rt) return true;

  // first placement
  if (!rt.placed) {
    await mouseMove(tabId, rt.xi, rt.yi);
    rt.lastX = Math.round(rt.xi);
    rt.lastY = Math.round(rt.yi);
    rt.placed = true;
    if (rt.dist === 0) return true;
  }

  // interpolate within the current tick
  const extra = rt.speed * (frameAlpha * (dtPerTick / 1000));
  const interp = Math.min(rt.progressPx + extra, rt.dist);
  const x = rt.xi + rt.dirX * interp;
  const y = rt.yi + rt.dirY * interp;
  const xi = Math.round(x), yi = Math.round(y);
  if (xi !== rt.lastX || yi !== rt.lastY) {
    await mouseMove(tabId, xi, yi);
    rt.lastX = xi; rt.lastY = yi;
  }

  // complete?
  if (rt.progressPx >= rt.dist) {
    if (xi !== Math.round(rt.xf) || yi !== Math.round(rt.yf)) {
      await mouseMove(tabId, rt.xf, rt.yf);
    }
    return true;
  }
  return false;
}