/**
 * Field Video — record on the job, auto-upload to High Ground's Google Drive.
 *
 * No per-phone Google login. The phone talks to a tiny Google Apps Script
 * Web App (runs as High Ground's Google account). The script brokers a Drive
 * resumable-upload session; video bytes go straight from the phone to Google.
 * Handles big files (chunked), retries, and progress.
 *
 * Setup (Joshua, once):
 *  1. script.google.com → New project → paste workers/drive-upload.gs
 *  2. Project Settings → enable Drive scope, Deploy → New deployment → Web app
 *     (Execute as: Me, Who has access: Anyone)
 *  3. In Ground Control → DATA → Field Videos: paste the Web App URL + secret.
 *
 * Crew flow: Jobs → job card → 🎥 Upload video → pick one or more clips
 * from the phone (camera or gallery) → upload starts automatically →
 * progress bar → Drive links saved on the job.
 * Files land in High Ground's shared Drive folder (TARGET_FOLDER_ID in the
 * script), named "<job address> <timestamp>.mp4".
 */

const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB chunks to Google
const MAX_RETRIES = 3;

function settingsOk(settings) {
  const url = String(settings?.drive_upload_url || "").trim();
  const secret = String(settings?.drive_upload_secret || "").trim();
  return url && secret ? { url, secret } : null;
}

export function driveVideosConfigured(settings) {
  return Boolean(settingsOk(settings));
}

/**
 * Video picker — returns an array of Files, or throws on cancel.
 *
 * Deliberately NO `capture` attribute: Android shows a "Camera / Files"
 * chooser, so the crew can either shoot new footage or pick clips they
 * already recorded, then upload. `multiple` lets them batch a whole shoot.
 */
export function pickVideoFiles({ multiple = true } = {}) {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/*";
    if (multiple) input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);
    const cleanup = () => {
      try {
        input.remove();
      } catch {
        /* ignore */
      }
    };
    input.onchange = () => {
      const files = Array.from(input.files || []);
      cleanup();
      if (!files.length) reject(new Error("cancelled"));
      else resolve(files);
    };
    input.oncancel = () => {
      cleanup();
      reject(new Error("cancelled"));
    };
    setTimeout(() => input.click(), 0);
  });
}

/** Single-file wrapper for callers that only want one clip. */
export function pickVideoFile() {
  return pickVideoFiles({ multiple: false }).then((files) => files[0]);
}

/** In-browser recorder fallback (MediaRecorder) — returns a File when stopped. */
export function recordVideoInBrowser({ maxSeconds = 120, onTick } = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: true,
      });
      const mime = MediaRecorder.isTypeSupported("video/mp4")
        ? "video/mp4"
        : "video/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
      const parts = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size) parts.push(e.data);
      };
      const stopAll = () => {
        try {
          stream.getTracks().forEach((t) => t.stop());
        } catch {
          /* ignore */
        }
      };
      rec.onstop = () => {
        stopAll();
        const blob = new Blob(parts, { type: mime });
        const ext = mime.includes("mp4") ? "mp4" : "webm";
        resolve(new File([blob], `field-${Date.now()}.${ext}`, { type: mime }));
      };
      rec.onerror = (e) => {
        stopAll();
        reject(new Error(String(e.error || "recorder failed")));
      };
      rec.start(1000);
      const started = Date.now();
      const timer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - started) / 1000);
        if (onTick) onTick(elapsed);
        if (elapsed >= maxSeconds) {
          clearInterval(timer);
          try {
            rec.stop();
          } catch {
            /* ignore */
          }
        }
      }, 1000);
      // Return a handle so UI can stop early: attach to promise
      recordVideoInBrowser._stop = () => {
        clearInterval(timer);
        try {
          rec.stop();
        } catch {
          /* ignore */
        }
      };
    } catch (e) {
      reject(e);
    }
  });
}

export function stopBrowserRecording() {
  try {
    recordVideoInBrowser._stop?.();
  } catch {
    /* ignore */
  }
}

async function scriptPost(scriptUrl, secret, action, payload = {}) {
  const res = await fetch(scriptUrl, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ secret, action, ...payload }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Drive bridge bad reply: ${text.slice(0, 120)}`);
  }
  if (!data.ok) throw new Error(data.error || "Drive bridge failed");
  return data;
}

/**
 * Upload a video File to Drive via the Apps Script bridge.
 * onProgress(0..1, label) — label like "Uploading 12.4 / 48.1 MB".
 */
export async function uploadVideoToDrive(settings, file, { jobLabel = "", onProgress } = {}) {
  const cfg = settingsOk(settings);
  if (!cfg) throw new Error("Field Videos not set up — paste the Drive bridge URL in DATA");
  if (!file || !file.size) throw new Error("Empty video file");

  const safeLabel = String(jobLabel || "Field").replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "Field";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const ext = (file.name.split(".").pop() || "mp4").toLowerCase().slice(0, 4);
  const fileName = `${safeLabel} ${stamp}.${ext}`;

  const say = (p, label) => {
    try {
      onProgress?.(p, label);
    } catch {
      /* ignore */
    }
  };

  // 1. Ask the bridge for a resumable Drive session (auth stays server-side)
  say(0.01, "Connecting to Drive…");
  const start = await scriptPost(cfg.url, cfg.secret, "start", {
    fileName,
    mimeType: file.type || "video/mp4",
    size: file.size,
    folderPath: `High Ground Field Videos/${safeLabel}`,
  });
  const uploadUrl = start.uploadUrl;
  const driveFileId = start.fileId;
  if (!uploadUrl) throw new Error("Drive did not return an upload session");

  // 2. PUT chunks straight to Google
  const total = file.size;
  let offset = 0;
  let attempt = 0;
  while (offset < total) {
    const end = Math.min(offset + CHUNK_SIZE, total);
    const chunk = file.slice(offset, end);
    const buf = await chunk.arrayBuffer();
    let ok = false;
    let lastErr = "";
    for (attempt = 0; attempt < MAX_RETRIES && !ok; attempt++) {
      try {
        const res = await fetch(uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Length": String(buf.byteLength),
            "Content-Range": `bytes ${offset}-${end - 1}/${total}`,
          },
          body: buf,
        });
        // 308 = resume incomplete (more chunks to come); 200/201 = done
        if (res.status === 308 || (res.ok && end >= total)) {
          ok = true;
        } else if (res.ok) {
          ok = true;
        } else {
          lastErr = `HTTP ${res.status}`;
          // Ask Google where to resume from
          if (res.status >= 500 && attempt < MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
            continue;
          }
          throw new Error(`Upload chunk failed: HTTP ${res.status}`);
        }
      } catch (e) {
        lastErr = String(e.message || e);
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
    }
    if (!ok) throw new Error(`Upload stalled at ${Math.round((offset / total) * 100)}% — ${lastErr}`);
    offset = end;
    const mb = (n) => (n / 1048576).toFixed(1);
    say(offset / total, `Uploading ${mb(offset)} / ${mb(total)} MB`);
  }

  // 3. Confirm + get the Drive link
  say(0.995, "Finishing…");
  const done = await scriptPost(cfg.url, cfg.secret, "finish", {
    fileId: driveFileId,
    fileName,
  });
  say(1, "Uploaded");
  return {
    fileId: driveFileId,
    fileName,
    webViewLink: done.webViewLink || "",
    size: total,
    at: new Date().toISOString(),
  };
}

/** One-tap flow: pick clips → auto-upload each → return Drive records. */
export async function captureAndUpload(settings, { jobLabel = "", onProgress, onFile } = {}) {
  const files = await pickVideoFiles();
  const records = [];
  for (const file of files) {
    try {
      onFile?.(file);
    } catch {
      /* ignore */
    }
    records.push(await uploadVideoToDrive(settings, file, { jobLabel, onProgress }));
  }
  return records;
}

export function formatBytes(n) {
  const x = Number(n) || 0;
  if (x < 1048576) return `${Math.max(1, Math.round(x / 1024))} KB`;
  return `${(x / 1048576).toFixed(1)} MB`;
}
