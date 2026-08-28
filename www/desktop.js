/** Legacy Control Room / desktop GPU pairing — removed (phone uses cloud keys or ChatGPT share). */

export function normalizeUrl() {
  return "";
}

export function desktopConfigured() {
  return false;
}

export async function desktopReachable() {
  return { ok: false };
}

export async function desktopStatus() {
  return { ok: false };
}

export async function connectDesktop() {
  throw new Error("Control Room removed — use cloud keys or phone Lens → ChatGPT");
}

export async function disconnectDesktop(settings) {
  if (settings) {
    settings.desktop_token = "";
    settings.desktop_paired = false;
    settings.desktop_live = false;
  }
}

export async function ensureControlRoom() {
  return { ok: false, error: "not available" };
}

export async function desktopLens() {
  throw new Error("No local GPU");
}

export async function desktopChat() {
  throw new Error("No local GPU");
}

export async function desktopGpuPing() {
  throw new Error("No local GPU");
}

export async function desktopLogin() {
  throw new Error("No local GPU");
}

export async function desktopDraft() {
  throw new Error("No local GPU");
}
