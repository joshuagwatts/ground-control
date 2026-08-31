/**
 * Form factor for chrome: phone / tablet keep swipe UI; desktop is mouse + scroll.
 * Detected once at boot (and on orientation/resize) — not a user setting.
 */

let cached = "";

function uaBlob() {
  if (typeof navigator === "undefined") return "";
  return `${navigator.userAgent || ""} ${navigator.platform || ""}`;
}

function isIpadLike() {
  if (typeof navigator === "undefined") return false;
  const ua = uaBlob();
  if (/iPad/i.test(ua)) return true;
  // iPadOS desktop UA
  if (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1) return true;
  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) return true;
  if (/Tablet|Silk|Kindle|PlayBook/i.test(ua)) return true;
  return false;
}

function isPhoneUa() {
  const ua = uaBlob();
  if (isIpadLike()) return false;
  return /iPhone|iPod|Windows Phone|Android.*Mobile|Mobile.*Android|webOS|BlackBerry/i.test(ua);
}

function capacitorPlatform() {
  if (typeof window === "undefined") return "web";
  try {
    return String(window.Capacitor?.getPlatform?.() || "web").toLowerCase();
  } catch {
    return "web";
  }
}

function screenMinMax() {
  if (typeof window === "undefined") return { min: 1024, max: 1024 };
  const w = Math.min(window.screen?.width || window.innerWidth || 0, window.screen?.height || window.innerHeight || 0);
  const h = Math.max(window.screen?.width || window.innerWidth || 0, window.screen?.height || window.innerHeight || 0);
  return { min: w, max: h };
}

/**
 * @returns {"phone"|"tablet"|"desktop"}
 */
export function detectFormFactor({ refresh = false } = {}) {
  if (cached && !refresh) return cached;
  if (typeof window === "undefined") {
    cached = "desktop";
    return cached;
  }
  const cap = capacitorPlatform();
  const { min, max } = screenMinMax();
  const fine = window.matchMedia?.("(pointer: fine)")?.matches === true;
  const coarse = window.matchMedia?.("(pointer: coarse)")?.matches === true;
  const hover = window.matchMedia?.("(hover: hover)")?.matches === true;

  // Native apps: tablets keep phone chrome; phones stay phones.
  if (cap === "ios" || cap === "android") {
    cached = isIpadLike() || min >= 600 ? "tablet" : "phone";
    return cached;
  }

  if (isIpadLike()) {
    cached = "tablet";
    return cached;
  }
  if (isPhoneUa()) {
    cached = "phone";
    return cached;
  }

  // Mouse / trackpad primary → desktop web chrome (tabs + scroll, no swipe shell).
  if (fine && hover && !coarse) {
    cached = "desktop";
    return cached;
  }
  if (fine && !coarse && (window.innerWidth || 0) >= 900) {
    cached = "desktop";
    return cached;
  }

  // Touch-primary large screens → tablet chrome (same swipe UI as phone).
  if (coarse && min >= 600 && max >= 900) {
    cached = "tablet";
    return cached;
  }
  if (coarse) {
    cached = "phone";
    return cached;
  }

  cached = (window.innerWidth || 0) >= 1024 ? "desktop" : "phone";
  return cached;
}

/** Phone + tablet: swipe / peek chrome. */
export function usePhoneChrome() {
  return detectFormFactor() !== "desktop";
}

/** Desktop browser: mouse, tabs, normal scrolling. */
export function useDesktopChrome() {
  return detectFormFactor() === "desktop";
}

/** Browser Pages / Safari without native HTTP — SWDI goes through CORS proxies. */
export function isSlowBrowserNet() {
  if (capacitorPlatform() !== "web") return false;
  try {
    const cap = window.Capacitor;
    if (cap?.Plugins?.CapacitorHttp) return false;
  } catch {
    /* web */
  }
  return true;
}

/** Apply gc-phone | gc-tablet | gc-desktop on <body>. */
export function applyFormFactorClass() {
  const f = detectFormFactor({ refresh: true });
  const body = document.body;
  if (!body) return f;
  body.classList.remove("gc-phone", "gc-tablet", "gc-desktop");
  body.classList.add(`gc-${f}`);
  body.dataset.formFactor = f;
  return f;
}

export function bindFormFactorResize() {
  let t = 0;
  const bump = () => {
    clearTimeout(t);
    t = setTimeout(() => applyFormFactorClass(), 200);
  };
  window.addEventListener("orientationchange", bump);
  window.addEventListener("resize", bump);
}
