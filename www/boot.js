import { APP_VERSION, CACHE_BUST } from "./version.js";

const ver = document.getElementById("app-version");
if (ver) ver.textContent = `v${APP_VERSION}`;

async function registerWebProxy() {
  if (!("serviceWorker" in navigator) || window.Capacitor?.isNativePlatform?.()) return true;
  const swUrl = new URL(`./sw.js?v=${CACHE_BUST}`, import.meta.url);
  const scope = new URL("./", import.meta.url);
  try {
    const reg = await navigator.serviceWorker.register(swUrl, { scope: scope.href, updateViaCache: "none" });
    await reg.update().catch(() => {});
    if (reg.waiting && navigator.serviceWorker.controller) {
      reg.waiting.postMessage({ type: "GC_SKIP_WAITING" });
    }
    await navigator.serviceWorker.ready;
    await new Promise((r) => setTimeout(r, 250));
    return Boolean(navigator.serviceWorker.controller);
  } catch (err) {
    console.warn("service worker registration failed", err);
    return false;
  }
}

window.__gcWebProxy = await registerWebProxy();

await import(`./app.js?v=${CACHE_BUST}`).catch((err) => {
  const root = document.getElementById("view");
  const msg = String(err?.message || err || "boot failed");
  if (root) {
    root.innerHTML = `<h3>GC BOOT ERROR</h3><p class="muted">${msg.replace(/</g, "&lt;")}</p>`;
  }
  const st = document.getElementById("status");
  if (st) st.textContent = "BOOT FAILED";
  console.error(err);
});
