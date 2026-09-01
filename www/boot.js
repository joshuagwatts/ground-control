import { APP_VERSION, CACHE_BUST } from "./version.js";

const ver = document.getElementById("app-version");
if (ver) ver.textContent = `v${APP_VERSION}`;

if ("serviceWorker" in navigator && !window.Capacitor?.isNativePlatform?.()) {
  try {
    await navigator.serviceWorker.register(new URL("./sw.js", import.meta.url), { scope: "./" });
    await navigator.serviceWorker.ready;
  } catch {
    /* SW optional — dev-server /proxy or native HTTP still work */
  }
}

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
