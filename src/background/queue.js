// queue.js — tiny in-memory queue (per service worker session)
const q = [];
let nextId = 1;

export function enqueueWork(type, payload = {}) {
  const item = { id: nextId++, type: String(type || "unknown"), payload, enqueuedAt: Date.now() };
  q.push(item);
  return item;
}

export function peek(n = 10) {
  return q.slice(0, n).map(x => ({ id: x.id, type: x.type, age_ms: Date.now() - x.enqueuedAt }));
}

export function size() { return q.length; }

export function dequeue() {
  return q.shift() || null;
}