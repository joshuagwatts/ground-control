import { APP_VERSION, CACHE_BUST } from "../version.js";

const ver = document.getElementById("ho-ver");
if (ver) ver.textContent = `v${APP_VERSION}`;

/** Same SW as field app — required for NOAA SWDI on GitHub Pages. */
async function registerWebProxy() {
  if (!("serviceWorker" in navigator) || window.Capacitor?.isNativePlatform?.()) return true;
  // Scope must be the www/ root so /homeowner/ shares the CORS proxy.
  const swUrl = new URL(`../sw.js?v=${CACHE_BUST}`, import.meta.url);
  const scope = new URL(`../`, import.meta.url);
  try {
    const reg = await navigator.serviceWorker.register(swUrl, { scope: scope.href, updateViaCache: "none" });
    await reg.update().catch(() => {});
    if (reg.waiting && navigator.serviceWorker.controller) {
      reg.waiting.postMessage({ type: "GC_SKIP_WAITING" });
    }
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((r) => setTimeout(r, 300));
    }
    return Boolean(navigator.serviceWorker.controller);
  } catch (err) {
    console.warn("[HomeScope] service worker registration failed", err);
    return false;
  }
}

window.__gcWebProxy = await registerWebProxy();

await import(`./app.js?v=${CACHE_BUST}`).catch((err) => {
  const main = document.querySelector(".ho-main");
  const msg = String(err?.message || err || "boot failed");
  if (main) {
    main.innerHTML = `<section class="ho-panel"><h2>HomeScope boot error</h2><p class="lead">${msg.replace(/</g, "&lt;")}</p></section>`;
  }
  console.error(err);
});
