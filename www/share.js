/** Share guided Lens photos via native Android share or Web Share API. */

function dataUrlBase64(dataUrl) {
  const s = String(dataUrl || "");
  const i = s.indexOf("base64,");
  return i >= 0 ? s.slice(i + 7) : s;
}

async function dataUrlToFile(dataUrl, filename) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type || "image/jpeg" });
}

function capPlugins() {
  return window.Capacitor?.Plugins || null;
}

/** Built-in Android plugin — writes JPEGs to cache and opens the real share sheet. */
async function shareViaLensShare({ text, photos }) {
  const LensShare = capPlugins()?.LensShare;
  if (!LensShare?.sharePhotos) return null;

  const rows = (Array.isArray(photos) ? photos : []).filter((p) => p?.url);
  if (!rows.length) throw new Error("No photos to share");

  const out = await LensShare.sharePhotos({
    text: String(text || "").trim(),
    photos: rows.map((p, i) => ({
      base64: dataUrlBase64(p.url),
      name: `roof-${String(i + 1).padStart(2, "0")}-${p.shot || "shot"}.jpg`,
    })),
  });
  const count = Number(out?.count) || rows.length;
  return { ok: true, method: "native", count };
}

async function shareViaWeb({ text, photos }) {
  const rows = (Array.isArray(photos) ? photos : []).filter((p) => p?.url);
  if (!rows.length) throw new Error("No photos to share");
  if (!navigator.share) return null;

  const files = await Promise.all(
    rows.map((p, i) => dataUrlToFile(p.url, `roof-${String(i + 1).padStart(2, "0")}-${p.shot || "shot"}.jpg`)),
  );
  const payload = { title: "Roof shingle ID", text: String(text || "").trim(), files };

  if (!navigator.canShare || navigator.canShare(payload)) {
    await navigator.share(payload);
    return { ok: true, method: "web", count: files.length };
  }
  if (navigator.canShare?.({ files })) {
    await navigator.share({ title: payload.title, files });
    return { ok: true, method: "web-files", count: files.length };
  }
  return null;
}

/**
 * Share sheet with all photos + shingle prompt. Never clipboard-only.
 */
export async function shareToChatGpt({ text, photos }) {
  const native = await shareViaLensShare({ text, photos }).catch((e) => {
    if (/abort|cancel/i.test(String(e.message || e))) throw e;
    return null;
  });
  if (native) return native;

  const web = await shareViaWeb({ text, photos });
  if (web) return web;

  throw new Error("Rebuild the APK — share needs the latest Ground Control install");
}
