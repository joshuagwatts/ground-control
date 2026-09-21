/**
 * Field Video — record on the job, auto-upload to High Ground's Google Drive.
 *
 * No per-phone Google login. The phone talks to a tiny Google Apps Script
 * Web App (runs as High Ground's Google account). The script brokers a Drive
 * resumable-upload session; video bytes go straight from the phone to Google.
 * Handles big files (chunked), retries, and progress.
 *
 * Setup (Joshua, once): deploy workers/drive-upload.gs as a Web App
 * (script.google.com, Execute as: Me, Who has access: Anyone) and paste the
 * /exec URL + secret below. DONE 2026-09-21 — baked in as built-in defaults.
 *
 * Crew flow: Lens → Field video → Record clips (in-app recorder) or Pick from
 * phone → clips auto-upload in sequence → progress + Drive links on the
 * Lens video screen.
 * Files land in High Ground's shared Drive folder (TARGET_FOLDER_ID in the
 * script), named "Field <timestamp>.mp4".
 */

const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB chunks to Google
const MAX_RETRIES = 3;

// Built-in bridge credentials — the holomuse Web App deployed 2026-09-21,
// so Field Videos works on every phone with zero setup. DATA → Field Videos
// fields still override these if a phone ever needs a different bridge.
const BUILTIN_BRIDGE_URL =
  "https://script.google.com/macros/s/AKfycbzJleNLlxV8-VHqaU5UT8Bot26W5dwiqg68rA2VBQm7_Z8IOI8H7nWH0my-1wUNhR2h/exec";
const BUILTIN_BRIDGE_SECRET = "yf4flCzVvZSPgNSWNKb8LWzX9LJrZoJ-IdLMkao-G4c";

function settingsOk(settings) {
  const url = String(settings?.drive_upload_url || BUILTIN_BRIDGE_URL).trim();
  const secret = String(settings?.drive_upload_secret || BUILTIN_BRIDGE_SECRET).trim();
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

/**
 * Bottom sheet: record fresh clips in-app, or pick existing footage.
 * Resolves "record" | "pick"; rejects on cancel.
 */
export function chooseVideoSource() {
  return new Promise((resolve, reject) => {
    const sheet = document.createElement("div");
    sheet.className = "fv-sheet";
    sheet.innerHTML = `
      <div class="fv-sheet-card">
        <button type="button" data-src="record" class="primary">🎬 Record clips</button>
        <button type="button" data-src="pick">📁 Pick from phone</button>
        <button type="button" data-src="" class="fv-cancel">Cancel</button>
      </div>`;
    const done = (val) => {
      sheet.remove();
      if (val) resolve(val);
      else reject(new Error("cancelled"));
    };
    sheet.addEventListener("click", (e) => {
      if (e.target === sheet) return done(null); // tap backdrop = cancel
      const btn = e.target.closest("[data-src]");
      if (btn) done(btn.getAttribute("data-src"));
    });
    document.body.appendChild(sheet);
  });
}

/**
 * Pro in-app multi-clip recorder. Shoot clip after clip without leaving the
 * app, then hit Upload once. Returns File[]; throws on cancel.
 *
 * Default-camera-grade controls (via the web camera API — Galaxy-class
 * phones support all of these):
 *   tap-to-focus with exposure slider · pinch-to-zoom + zoom stops · torch ·
 *   pause/resume · rule-of-thirds grid · 720p/1080p + 30/60fps · mic toggle ·
 *   clip tray with per-clip delete · mirrored selfie preview
 */
const FV_PREFS_KEY = "hg_fv_cam";

function fvLoadPrefs() {
  let p = {};
  try {
    p = JSON.parse(localStorage.getItem(FV_PREFS_KEY) || "{}");
  } catch {
    /* ignore */
  }
  return {
    quality: p.quality === "720p" ? "720p" : "1080p",
    fps: p.fps === 60 ? 60 : 30,
    grid: p.grid === true,
    mic: p.mic !== false,
  };
}

function fvSavePrefs(p) {
  try {
    localStorage.setItem(FV_PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

export function recordClipsSession({ maxSecondsPerClip = 180 } = {}) {
  return new Promise(async (resolve, reject) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      reject(new Error("camera unavailable"));
      return;
    }
    const prefs = fvLoadPrefs();
    const mime = MediaRecorder.isTypeSupported("video/mp4") ? "video/mp4" : "video/webm";
    const ext = mime.includes("mp4") ? "mp4" : "webm";
    let facingMode = "environment";
    let stream = null;
    let videoTrack = null;
    let caps = {};
    let zoom = 1;
    let torchOn = false;

    const dimsFor = () => (prefs.quality === "720p" ? { w: 1280, h: 720 } : { w: 1920, h: 1080 });
    const bitrateFor = () => (prefs.quality === "720p" ? 8_000_000 : prefs.fps === 60 ? 20_000_000 : 14_000_000);
    const trimZoom = (z) => (z < 10 ? z.toFixed(1) : String(Math.round(z)));

    const openStream = async () => {
      const d = dimsFor();
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode,
          width: { ideal: d.w },
          height: { ideal: d.h },
          frameRate: { ideal: prefs.fps },
        },
        audio: prefs.mic,
      });
      videoTrack = stream.getVideoTracks()[0] || null;
      try {
        caps = videoTrack?.getCapabilities?.() || {};
      } catch {
        caps = {};
      }
      zoom = 1;
      torchOn = false;
    };

    try {
      await openStream();
    } catch (e) {
      reject(new Error("camera unavailable"));
      return;
    }

    const clips = [];
    const urlByClip = new Map();
    const overlay = document.createElement("div");
    overlay.className = "fv-rec";
    overlay.innerHTML = `
      <video class="fv-view" muted playsinline autoplay></video>
      <div class="fv-grid"></div>
      <div class="fv-reticle" hidden><input type="range" class="fv-exp" aria-label="Exposure" tabindex="-1"></div>
      <div class="fv-top">
        <span class="fv-count">0 clips</span>
        <div class="fv-topbtns">
          <button type="button" class="fv-gear" aria-label="Camera settings">⚙</button>
          <button type="button" class="fv-x" aria-label="Cancel">✕</button>
        </div>
      </div>
      <div class="fv-timer">0:00</div>
      <div class="fv-side">
        <button type="button" class="fv-tool fv-torch" aria-label="Flash" hidden>🔦</button>
      </div>
      <button type="button" class="fv-zoom" hidden>1.0×</button>
      <div class="fv-tray"></div>
      <div class="fv-bottom">
        <button type="button" class="fv-flip" aria-label="Flip camera">🔄</button>
        <button type="button" class="fv-pausebtn" aria-label="Pause" hidden>⏸</button>
        <button type="button" class="fv-shutter" aria-label="Record"></button>
        <button type="button" class="fv-done" disabled>Upload</button>
      </div>
      <div class="fv-settings" hidden>
        <div class="fv-set-card">
          <div class="fv-set-row"><span>Quality</span><div class="fv-seg" data-k="quality">
            <button type="button" data-v="720p">720p</button><button type="button" data-v="1080p">1080p</button>
          </div></div>
          <div class="fv-set-row"><span>Frame rate</span><div class="fv-seg" data-k="fps">
            <button type="button" data-v="30">30</button><button type="button" data-v="60">60</button>
          </div></div>
          <div class="fv-set-row"><span>Grid</span><button type="button" class="fv-toggle" data-k="grid">Off</button></div>
          <div class="fv-set-row"><span>Mic</span><button type="button" class="fv-toggle" data-k="mic">On</button></div>
          <button type="button" class="fv-set-close">Done</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const video = overlay.querySelector(".fv-view");
    const grid = overlay.querySelector(".fv-grid");
    const reticle = overlay.querySelector(".fv-reticle");
    const expSlider = overlay.querySelector(".fv-exp");
    const countEl = overlay.querySelector(".fv-count");
    const timerEl = overlay.querySelector(".fv-timer");
    const shutter = overlay.querySelector(".fv-shutter");
    const pauseBtn = overlay.querySelector(".fv-pausebtn");
    const doneBtn = overlay.querySelector(".fv-done");
    const flipBtn = overlay.querySelector(".fv-flip");
    const torchBtn = overlay.querySelector(".fv-torch");
    const zoomPill = overlay.querySelector(".fv-zoom");
    const tray = overlay.querySelector(".fv-tray");
    const gearBtn = overlay.querySelector(".fv-gear");
    const settingsSheet = overlay.querySelector(".fv-settings");
    video.srcObject = stream;

    let rec = null;
    let parts = [];
    let recording = false;
    let paused = false;
    let saveOnStop = false;
    let pendingFinish = false;
    let elapsedBase = 0;
    let segmentStart = 0;
    let tickTimer = null;
    let focusTimer = null;

    const revokeAllUrls = () => {
      urlByClip.forEach((u) => {
        try {
          URL.revokeObjectURL(u);
        } catch {
          /* ignore */
        }
      });
      urlByClip.clear();
    };
    const cleanup = () => {
      try { clearInterval(tickTimer); } catch { /* ignore */ }
      try { clearTimeout(focusTimer); } catch { /* ignore */ }
      revokeAllUrls();
      saveOnStop = false;
      try { rec && rec.state !== "inactive" && rec.stop(); } catch { /* ignore */ }
      try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      overlay.remove();
    };
    const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s) % 60).padStart(2, "0")}`;
    const elapsed = () => elapsedBase + (recording && !paused ? (Date.now() - segmentStart) / 1000 : 0);

    const refreshCount = () => {
      countEl.textContent = `${clips.length} clip${clips.length === 1 ? "" : "s"}`;
      doneBtn.disabled = clips.length === 0;
      doneBtn.textContent = clips.length ? `Upload ${clips.length} clip${clips.length === 1 ? "" : "s"}` : "Upload";
    };

    const refreshTray = () => {
      revokeAllUrls();
      tray.innerHTML = "";
      clips.forEach((file) => {
        const url = URL.createObjectURL(file);
        urlByClip.set(file, url);
        const cell = document.createElement("div");
        cell.className = "fv-clip";
        const v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.preload = "metadata";
        v.src = url;
        const del = document.createElement("button");
        del.type = "button";
        del.textContent = "✕";
        del.setAttribute("aria-label", "Delete clip");
        del.onclick = (e) => {
          e.stopPropagation();
          const i = clips.indexOf(file);
          if (i >= 0) clips.splice(i, 1);
          refreshTray();
          refreshCount();
        };
        cell.appendChild(v);
        cell.appendChild(del);
        tray.appendChild(cell);
      });
      tray.style.display = clips.length ? "flex" : "none";
    };

    const applyZoom = async (z) => {
      if (!videoTrack || !caps.zoom) return;
      const zc = caps.zoom;
      const min = zc.min ?? 1;
      const max = zc.max ?? 1;
      const step = zc.step ?? 0.1;
      let nz = Math.min(max, Math.max(min, z));
      if (step > 0) nz = Math.round(nz / step) * step;
      zoom = nz;
      try {
        await videoTrack.applyConstraints({ advanced: [{ zoom: nz }] });
      } catch {
        /* ignore */
      }
      zoomPill.textContent = `${trimZoom(nz)}×`;
    };

    const zoomStops = () => {
      const max = caps.zoom?.max ?? 1;
      const stops = [1, 2, 5].filter((s) => s <= max + 1e-6);
      return stops.length ? stops : [1];
    };

    const setTorch = async (on) => {
      if (!videoTrack || !caps.torch) return;
      try {
        await videoTrack.applyConstraints({ advanced: [{ torch: on }] });
        torchOn = on;
        torchBtn.classList.toggle("on", on);
      } catch {
        /* ignore */
      }
    };

    const syncControls = () => {
      const showTorch = Boolean(caps.torch) && facingMode === "environment";
      torchBtn.hidden = !showTorch;
      torchBtn.classList.toggle("on", torchOn);
      const zmax = caps.zoom?.max ?? 1;
      zoomPill.hidden = !(zmax > 1.01);
      zoomPill.textContent = `${trimZoom(zoom)}×`;
      grid.classList.toggle("show", prefs.grid);
      video.classList.toggle("mirror", facingMode === "user");
      overlay.querySelectorAll(".fv-seg").forEach((seg) => {
        const k = seg.dataset.k;
        const cur = String(prefs[k]);
        seg.querySelectorAll("button").forEach((b) => b.classList.toggle("sel", b.dataset.v === cur));
      });
      const gridT = overlay.querySelector('[data-k="grid"]');
      gridT.textContent = prefs.grid ? "On" : "Off";
      gridT.classList.toggle("sel", prefs.grid);
      const micT = overlay.querySelector('[data-k="mic"]');
      micT.textContent = prefs.mic ? "On" : "Off";
      micT.classList.toggle("sel", prefs.mic);
    };

    const reopen = async () => {
      try {
        stream?.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
      try {
        await openStream();
        video.srcObject = stream;
        await applyZoom(1);
        syncControls();
      } catch {
        /* ignore */
      }
    };

    // ---- tap-to-focus + exposure slider ----
    const hideReticle = () => {
      reticle.hidden = true;
    };
    const focusAt = async (x, y) => {
      reticle.style.left = `${x * 100}%`;
      reticle.style.top = `${y * 100}%`;
      const ec = caps.exposureCompensation;
      if (ec && typeof ec.min === "number") {
        expSlider.min = ec.min;
        expSlider.max = ec.max;
        expSlider.step = ec.step || 0.1;
        try {
          const s = videoTrack?.getSettings?.() || {};
          if (typeof s.exposureCompensation === "number") expSlider.value = s.exposureCompensation;
        } catch {
          /* ignore */
        }
        expSlider.style.display = "";
      } else {
        expSlider.style.display = "none";
      }
      reticle.hidden = false;
      if (videoTrack) {
        const modes = caps.focusMode || [];
        const mode = modes.includes("manual") ? "manual" : modes.includes("single-shot") ? "single-shot" : null;
        if (mode) {
          try {
            await videoTrack.applyConstraints({ advanced: [{ focusMode: mode, pointsOfInterest: [{ x, y }] }] });
          } catch {
            /* phone ignored it — reticle still showed */
          }
        }
      }
      clearTimeout(focusTimer);
      focusTimer = setTimeout(async () => {
        try {
          if (videoTrack && (caps.focusMode || []).includes("continuous")) {
            await videoTrack.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
          }
        } catch {
          /* ignore */
        }
        hideReticle();
      }, 5000);
    };
    expSlider.addEventListener("input", async () => {
      if (!videoTrack || !caps.exposureCompensation) return;
      clearTimeout(focusTimer);
      try {
        await videoTrack.applyConstraints({ advanced: [{ exposureCompensation: Number(expSlider.value) }] });
      } catch {
        /* ignore */
      }
      focusTimer = setTimeout(hideReticle, 5000);
    });

    // ---- tap vs pinch on the viewfinder ----
    const pointers = new Map();
    let pinchD0 = 0;
    let pinchZ0 = 1;
    let downAt = 0;
    let downX = 0;
    let downY = 0;
    let tapId = null;
    const pdist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    video.addEventListener("pointerdown", (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        downAt = Date.now();
        downX = e.clientX;
        downY = e.clientY;
        tapId = e.pointerId;
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchD0 = pdist(a, b);
        pinchZ0 = zoom;
        tapId = null;
      }
    });
    video.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && pinchD0 > 0) {
        const [a, b] = [...pointers.values()];
        applyZoom((pinchZ0 * pdist(a, b)) / pinchD0);
      } else if (tapId === e.pointerId && Math.hypot(e.clientX - downX, e.clientY - downY) > 14) {
        tapId = null; // it was a drag, not a tap
      }
    });
    const pointerEnd = (e) => {
      const wasTap = tapId === e.pointerId && Date.now() - downAt < 350;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchD0 = 0;
      if (wasTap && pointers.size === 0) {
        const r = video.getBoundingClientRect();
        focusAt(
          Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
          Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
        );
      }
      if (pointers.size === 0) tapId = null;
    };
    video.addEventListener("pointerup", pointerEnd);
    video.addEventListener("pointercancel", pointerEnd);

    zoomPill.onclick = () => {
      const stops = zoomStops();
      const i = stops.findIndex((s) => Math.abs(s - zoom) < 0.05);
      applyZoom(stops[(i + 1) % stops.length]);
    };
    torchBtn.onclick = () => setTorch(!torchOn);

    // ---- recording: pause/resume, clip tray ----
    const stopRecording = (save) => {
      if (!recording) return;
      recording = false;
      paused = false;
      clearInterval(tickTimer);
      shutter.classList.remove("on");
      pauseBtn.hidden = true;
      flipBtn.style.visibility = "";
      timerEl.classList.remove("is-paused");
      timerEl.textContent = "0:00";
      saveOnStop = save !== false;
      try {
        rec.stop();
      } catch {
        saveOnStop = false;
        parts = [];
      }
    };
    const makeRecorder = () => {
      parts = [];
      saveOnStop = false;
      const r = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrateFor() });
      r.ondataavailable = (e) => {
        if (e.data && e.data.size) parts.push(e.data);
      };
      r.onstop = () => {
        if (saveOnStop) {
          const blob = new Blob(parts, { type: mime });
          if (blob.size > 0) {
            clips.push(new File([blob], `clip-${clips.length + 1}-${Date.now()}.${ext}`, { type: mime }));
            refreshTray();
            refreshCount();
          }
        }
        parts = [];
        saveOnStop = false;
        elapsedBase = 0;
        if (pendingFinish) {
          pendingFinish = false;
          cleanup();
          resolve(clips);
        }
      };
      r.onerror = () => stopRecording(false);
      return r;
    };
    shutter.onclick = () => {
      if (recording) {
        stopRecording(true);
        return;
      }
      try {
        rec = makeRecorder();
      } catch (e) {
        return;
      }
      rec.start(1000);
      recording = true;
      paused = false;
      elapsedBase = 0;
      segmentStart = Date.now();
      shutter.classList.add("on");
      pauseBtn.hidden = false;
      pauseBtn.textContent = "⏸";
      flipBtn.style.visibility = "hidden";
      timerEl.classList.remove("is-paused");
      tickTimer = setInterval(() => {
        const s = elapsed();
        timerEl.textContent = fmt(s);
        if (s >= maxSecondsPerClip) stopRecording(true);
      }, 500);
    };
    pauseBtn.onclick = () => {
      if (!recording || !rec) return;
      try {
        if (paused) {
          if (typeof rec.resume === "function") rec.resume();
          paused = false;
          segmentStart = Date.now();
          pauseBtn.textContent = "⏸";
          timerEl.classList.remove("is-paused");
        } else {
          if (typeof rec.pause !== "function") return;
          rec.pause();
          paused = true;
          elapsedBase = elapsed();
          pauseBtn.textContent = "▶";
          timerEl.classList.add("is-paused");
        }
      } catch {
        /* ignore */
      }
    };
    flipBtn.onclick = async () => {
      if (recording) return;
      facingMode = facingMode === "environment" ? "user" : "environment";
      await reopen();
    };

    // ---- settings sheet ----
    gearBtn.onclick = () => {
      syncControls();
      settingsSheet.hidden = false;
    };
    settingsSheet.querySelector(".fv-set-close").onclick = () => {
      settingsSheet.hidden = true;
    };
    settingsSheet.addEventListener("click", (e) => {
      if (e.target === settingsSheet) settingsSheet.hidden = true;
    });
    settingsSheet.querySelectorAll(".fv-seg button").forEach((b) => {
      b.onclick = async () => {
        const k = b.closest(".fv-seg").dataset.k;
        prefs[k] = k === "fps" ? Number(b.dataset.v) : b.dataset.v;
        fvSavePrefs(prefs);
        syncControls();
        if (!recording) await reopen();
      };
    });
    settingsSheet.querySelectorAll(".fv-toggle").forEach((b) => {
      b.onclick = async () => {
        const k = b.dataset.k;
        prefs[k] = !prefs[k];
        fvSavePrefs(prefs);
        syncControls();
        if (k === "mic" && !recording) await reopen();
      };
    });

    overlay.querySelector(".fv-x").onclick = () => {
      cleanup();
      reject(new Error("cancelled"));
    };
    doneBtn.onclick = () => {
      if (!clips.length && !recording) return;
      if (recording) {
        pendingFinish = true;
        stopRecording(true);
        return;
      }
      cleanup();
      resolve(clips);
    };

    refreshCount();
    refreshTray();
    syncControls();
    applyZoom(1);
  });
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
 * Vision via the High Ground bridge (zero setup on the phone): the Apps Script
 * runs Gemini with its own key. Used by the shingle identifier when the phone
 * has no vision key of its own. Local keys still take precedence — see vision.js.
 */
export async function bridgeVision(settings, { prompt, images, maxTokens = 1200, temperature = 0.2 } = {}) {
  const cfg = settingsOk(settings);
  if (!cfg) throw new Error("Field Videos bridge not configured");
  const data = await scriptPost(cfg.url, cfg.secret, "vision", {
    prompt: String(prompt || ""),
    images: Array.isArray(images) ? images : [images].filter(Boolean),
    maxTokens,
    temperature,
  });
  if (!data.text) throw new Error("bridge vision: empty reply");
  return { text: String(data.text), provider: data.provider || "gemini", model: data.model || "", leaked: true };
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
