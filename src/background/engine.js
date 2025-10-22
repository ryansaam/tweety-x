import * as JobRunner from "./jobs/runner.js";

// engine.js — game loop + per-tab state + FPS
export const DEBUG_LOG_STEPS = true;

export const engine = {
  frameCount: 0,
  lastFpsTime: 0,
  lastFrameCount: 0,
  fps: 0,
  _frameAlpha: 0,    // 0..1 (set each frame in run())
  ticker: null,
};

const stateByTab = new Map();
// shape per tab: { running:boolean, attached:boolean, locks:number, engineTicking:boolean }
export function getTabState(tabId) {
  if (!stateByTab.has(tabId)) {
    stateByTab.set(tabId, { running: false, attached: false, locks: 0, engineTicking: false });
  }
  return stateByTab.get(tabId);
}

export function updateFps(now) {
  if (!engine.lastFpsTime) {
    engine.lastFpsTime = now;
    engine.lastFrameCount = engine.frameCount;
    return;
  }
  const dt = now - engine.lastFpsTime;
  if (dt >= 1000) {
    const df = engine.frameCount - engine.lastFrameCount;
    engine.fps = Math.round((df / dt) * 1000);
    engine.lastFpsTime = now;
    engine.lastFrameCount = engine.frameCount;
  }
}

// Fixed tick config (simulation)
export const TICK_HZ = 120;                 // ticks per second
export const TICK_DT_MS = 1000 / TICK_HZ;   // ~8.33ms
export const MAX_TICKS_PER_FRAME = 8;       // panic cap

// Simple fixed-timestep controller
class FixedTicker {
  constructor(hz, maxTicks) {
    this.dt = 1000 / hz;
    this.maxTicks = maxTicks;
    this.last = 0;
    this.acc = 0;
  }
  reset(now) { this.last = now; this.acc = 0; }
  step(now) {
    let dt = now - this.last;
    if (dt < 0) dt = 0;
    if (dt > 250) dt = 250; // clamp long stalls
    this.last = now;
    this.acc += dt;
    let ticks = 0;
    while (this.acc >= this.dt && ticks < this.maxTicks) {
      this.acc -= this.dt;
      ticks++;
    }
    const alpha = Math.min(Math.max(this.acc / this.dt, 0), 1);
    return { ticks, alpha, dtPerTick: this.dt };
  }
}

// One frame of work: run fixed-timestep simulation ticks, then render once.
export async function run(tabId, now) {
  if (!engine.ticker) engine.ticker = new FixedTicker(TICK_HZ, MAX_TICKS_PER_FRAME);
  if (engine.ticker.last === 0) engine.ticker.reset(now);

  const { ticks, alpha, dtPerTick } = engine.ticker.step(now);
  for (let i = 0; i < ticks; i++) {
    await JobRunner.tick(tabId, dtPerTick); // simulation only (no CDP I/O if possible)
  }
  engine._frameAlpha = alpha;
  await JobRunner.render(tabId, alpha, dtPerTick); // can perform CDP I/O (mouse, etc.)

  engine.frameCount++;
  updateFps(now);
}