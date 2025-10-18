const serverUrlInput = document.getElementById("serverUrl");
const btnCompose = document.getElementById("btnCompose");
const btnComposeAndPost = document.getElementById("btnComposeAndPost");

(async function init() {
  const { serverUrl } = await chrome.storage.sync.get({ serverUrl: "http://localhost:11000/generate" });
  serverUrlInput.value = serverUrl;
})();

serverUrlInput.addEventListener("change", async () => {
  await chrome.storage.sync.set({ serverUrl: serverUrlInput.value.trim() });
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function callGenerate(serverUrl) {
  const res = await fetch(serverUrl, { method: "POST" });
  const line = (await res.text()).trim();
  let obj = null;
  try { obj = JSON.parse(line); } catch (e) {}
  if (!obj || typeof obj.x_post !== "string" || !obj.x_post.trim()) {
    throw new Error("Bad response from /generate. Expected one NDJSON line with { x_post, why }.");
  }
  return obj;
}

async function sendToContentScript(cmd, payload) {
  const tab = await getActiveTab();
  if (!tab || !tab.id) throw new Error("No active tab.");
  return chrome.tabs.sendMessage(tab.id, { cmd, payload });
}

btnCompose.addEventListener("click", async () => {
  try {
    const serverUrl = serverUrlInput.value.trim();
    await chrome.storage.sync.set({ serverUrl });
    const { x_post } = await callGenerate(serverUrl);
    await sendToContentScript("compose", { text: x_post, clickPost: false });
    window.close();
  } catch (err) {
    alert(err.message || String(err));
  }
});

btnComposeAndPost.addEventListener("click", async () => {
  try {
    const serverUrl = serverUrlInput.value.trim();
    await chrome.storage.sync.set({ serverUrl });
    const { x_post } = await callGenerate(serverUrl);
    await sendToContentScript("compose", { text: x_post, clickPost: true });
    window.close();
  } catch (err) {
    alert(err.message || String(err));
  }
});
