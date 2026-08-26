/** Proton VPN companion — system VPN detect, open Proton, Wi‑Fi bind for LAN, keepalive. */

function bridge() {
  return window.Capacitor?.Plugins?.VpnBridge || null;
}

export async function vpnSystemActive() {
  const b = bridge();
  if (!b?.isActive) return false;
  try {
    const hit = await b.isActive();
    return Boolean(hit && hit.active);
  } catch {
    return false;
  }
}

/** Bind process to Wi‑Fi so LAN reaches desktop while Proton is up. */
export async function bindLanWifi() {
  const b = bridge();
  if (!b?.bindWifi) return false;
  try {
    const hit = await b.bindWifi();
    return Boolean(hit && hit.ok);
  } catch {
    return false;
  }
}

export async function unbindLanNetwork() {
  const b = bridge();
  if (!b?.unbindNetwork) return;
  try {
    await b.unbindNetwork();
  } catch {
    /* ignore */
  }
}

/** Run fn with Wi‑Fi preferred when a VPN is active (Proton-friendly LAN). */
export async function withLanBypass(fn) {
  let bound = false;
  try {
    if (await vpnSystemActive()) {
      bound = await bindLanWifi();
    }
    return await fn();
  } finally {
    if (bound) await unbindLanNetwork();
  }
}

export async function openProtonVpn() {
  const b = bridge();
  if (!b?.openProton) return false;
  try {
    await b.openProton();
    return true;
  } catch {
    try {
      window.open("https://play.google.com/store/apps/details?id=ch.protonvpn.android", "_system");
    } catch {
      /* ignore */
    }
    return false;
  }
}

export async function setKeepAlive(on) {
  const b = bridge();
  if (!b?.setKeepAlive) return false;
  try {
    await b.setKeepAlive({ on: Boolean(on) });
    return true;
  } catch {
    return false;
  }
}

export function protonPairHint(settings) {
  const url = String(settings.vpn_url || settings.proton_url || "").trim();
  if (url) return url;
  const note = String(settings.vpn_note || "").trim();
  if (/proton/i.test(note)) {
    const m = note.match(/https?:\/\/[^\s]+/);
    if (m) return m[0];
  }
  return "";
}

/** Retry desktop pairing when VPN comes up (Proton running in background). */
export async function pairWhenVpnUp(settings, { pairAtUrl, findAndPair, onStatus } = {}) {
  if (!(await vpnSystemActive())) return null;
  const hint = protonPairHint(settings);
  if (hint && pairAtUrl) {
    onStatus?.("VPN UP · PAIRING…");
    try {
      return await pairAtUrl(settings, hint);
    } catch {
      /* try scan */
    }
  }
  if (findAndPair) {
    onStatus?.("VPN UP · FIND DESKTOP…");
    try {
      return await findAndPair(settings);
    } catch {
      return null;
    }
  }
  return null;
}
