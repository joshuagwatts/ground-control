/** Legacy Proton VPN LAN bypass — stubbed (Control Room removed). */

export async function vpnSystemActive() {
  return false;
}

export async function bindLanWifi() {
  return false;
}

export async function unbindLanNetwork() {}

export async function openProtonVpn() {}

export async function withLanBypass(fn) {
  return fn();
}
