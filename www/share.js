/** Share guided Lens photos into ChatGPT (or any share target) via the phone share sheet. */

async function dataUrlToFile(dataUrl, filename) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type || "image/jpeg" });
}

async function copyText(text) {
  const s = String(text || "");
  try {
    await navigator.clipboard.writeText(s);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = s;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Open the native share sheet with prompt text + roof photos.
 * User picks ChatGPT from the list — iOS/Android attach images + text together.
 */
export async function shareToChatGpt({ text, photos }) {
  const rows = (Array.isArray(photos) ? photos : []).filter((p) => p?.url);
  if (!rows.length) throw new Error("No photos to share");

  const files = await Promise.all(
    rows.map((p, i) => dataUrlToFile(p.url, `roof-${String(i + 1).padStart(2, "0")}-${p.shot || "shot"}.jpg`)),
  );

  const payload = {
    title: "Roof shingle ID",
    text: String(text || "").trim(),
    files,
  };

  if (navigator.share) {
    try {
      if (!navigator.canShare || navigator.canShare(payload)) {
        await navigator.share(payload);
        return { ok: true, method: "share", count: files.length };
      }
    } catch (e) {
      if (/abort|cancel/i.test(String(e.message || e))) throw e;
    }
    try {
      await navigator.share({ title: payload.title, text: payload.text, files });
      return { ok: true, method: "share", count: files.length };
    } catch (e) {
      if (/abort|cancel/i.test(String(e.message || e))) throw e;
    }
  }

  await copyText(payload.text);
  return {
    ok: false,
    method: "clipboard",
    count: files.length,
    message: "Prompt copied — open ChatGPT and attach photos from your gallery",
  };
}
