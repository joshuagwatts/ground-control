import { APP_VERSION, CACHE_BUST } from "../version.js";

const ver = document.getElementById("ho-ver");
if (ver) ver.textContent = `v${APP_VERSION}`;

/** Same SW as field app — required for NOAA SWDI on GitHub Pages. */
async function registerWebProxy() {
  if (!("serviceWorker" in navigator) || window.Capacitor?.isNativePlatform?.()) return true;
  // Scope must be the www/ root so /homeowner/ shares the CORS proxy.
  const swUrl = new URL(`../sw.js?v=${CACHE_BUST}`, import.meta.url);
  const scope = new URL(`../`, import.meta.url);
  const withTimeout = (p, ms) =>
    Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
  try {
    const reg = await withTimeout(
      navigator.serviceWorker.register(swUrl, { scope: scope.href, updateViaCache: "none" }),
      4000,
    );
    if (!reg) return false;
    await withTimeout(reg.update().catch(() => {}), 2000);
    if (reg.waiting && navigator.serviceWorker.controller) {
      reg.waiting.postMessage({ type: "GC_SKIP_WAITING" });
    }
    await withTimeout(navigator.serviceWorker.ready, 3000);
    if (!navigator.serviceWorker.controller) {
      await new Promise((r) => setTimeout(r, 250));
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
