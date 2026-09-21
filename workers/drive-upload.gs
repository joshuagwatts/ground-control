/**
 * High Ground Field Videos — Google Drive upload bridge.
 *
 * Runs as High Ground's Google account. The Ground Control app POSTs here;
 * this script creates a Drive resumable-upload session (using the account's
 * own OAuth token — no secrets on crew phones), and the phone uploads video
 * bytes DIRECTLY to Google. This script never sees the video bytes.
 * Files land in High Ground's shared field-videos folder (TARGET_FOLDER_ID),
 * named "<job address> <timestamp>.mp4".
 *
 * SETUP (once, ~5 min):
 *  1. https://script.google.com → New project → paste this file.
 *  2. Add appsscript.json manifest (same folder in the repo) so the
 *     Drive scope is declared: Project Settings → "Show appsscript.json".
 *  3. Deploy → New deployment → type: Web app
 *     - Execute as: Me
 *     - Who has access: Anyone
 *  4. Copy the Web App URL (/exec) into Ground Control → DATA → Field Videos,
 *     along with the SHARED_SECRET below (change it first!).
 *
 * ACTIONS (POST JSON: {secret, action, ...}):
 *  - start:  {fileName, mimeType, size, folderPath} → {uploadUrl, fileId}
 *  - finish: {fileId} → {webViewLink}
 *  - vision: {prompt, images[], maxTokens, temperature} → {text, provider, model}
 *    Shingle identifier via Gemini. The GEMINI_API_KEY lives in the project's
 *    Script Properties (never on crew phones, never in the repo).
 */

var SHARED_SECRET = "CHANGE_ME_TO_A_LONG_RANDOM_STRING";
// High Ground's shared field-videos folder — Joshua's pick 2026-09-19.
// The josh@highgroundokc.com account running this script needs Editor access.
var TARGET_FOLDER_ID = "1y-EPkLANnmlpOgTDhFWFERd7EHPQtR2D";

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents || "{}");
    if (String(body.secret || "") !== SHARED_SECRET) {
      return json({ ok: false, error: "bad secret" });
    }
    var action = String(body.action || "");
    if (action === "start") return handleStart(body);
    if (action === "finish") return handleFinish(body);
    if (action === "vision") return handleVision(body);
    return json({ ok: false, error: "unknown action: " + action });
  } catch (err) {
    return json({ ok: false, error: "bridge error: " + String(err).slice(0, 200) });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

/** The shared High Ground folder every video lands in. */
function targetFolder() {
  return DriveApp.getFolderById(TARGET_FOLDER_ID);
}

function handleStart(body) {
  var fileName = String(body.fileName || "field-video.mp4").slice(0, 120);
  var mimeType = String(body.mimeType || "video/mp4").slice(0, 80);
  var size = Number(body.size || 0);
  if (!(size > 0)) return json({ ok: false, error: "bad size" });
  var folder = targetFolder();

  // Ask Drive for a resumable upload session.
  var token = ScriptApp.getOAuthToken();
  var meta = {
    name: fileName,
    mimeType: mimeType,
    parents: [folder.getId()],
  };
  var resp = UrlFetchApp.fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
    {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(meta),
      headers: {
        Authorization: "Bearer " + token,
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(size),
      },
      muteHttpExceptions: true,
    }
  );
  var code = resp.getResponseCode();
  if (code !== 200) {
    return json({
      ok: false,
      error: "Drive session failed: HTTP " + code + " " + String(resp.getContentText()).slice(0, 160),
    });
  }
  var uploadUrl = resp.getHeaders()["Location"] || resp.getHeaders()["location"];
  if (!uploadUrl) return json({ ok: false, error: "Drive gave no upload URL" });

  // Pre-create the file entry so we have an ID to finish with.
  // (The resumable session creates it on first byte; we track via session.)
  return json({ ok: true, uploadUrl: uploadUrl, fileId: "" });
}

function handleFinish(body) {
  var fileName = String(body.fileName || "");
  // Find the most recent file with this name (just uploaded).
  var files = DriveApp.getFilesByName(fileName);
  var latest = null;
  while (files.hasNext()) {
    var f = files.next();
    if (!latest || f.getDateCreated() > latest.getDateCreated()) latest = f;
  }
  if (!latest) return json({ ok: false, error: "uploaded file not found: " + fileName });
  // Anyone with the link can view — crew shares links with adjusters/homeowners.
  try {
    latest.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (err) {
    // Sharing may be restricted by Workspace policy — link still works in-Drive.
  }
  return json({
    ok: true,
    fileId: latest.getId(),
    webViewLink: "https://drive.google.com/file/d/" + latest.getId() + "/view",
  });
}

/** Gemini key from Script Properties — set once in the Apps Script editor. */
function geminiKey() {
  return String(
    PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY") || ""
  );
}

function stripDataUrl(u) {
  var s = String(u || "");
  var i = s.indexOf("base64,");
  return i >= 0 ? s.slice(i + 7) : s;
}

/**
 * Vision via Gemini (shingle identifier). The phone POSTs the prompt +
 * images; the key never leaves this script.
 */
function handleVision(body) {
  var key = geminiKey();
  if (!key) return json({ ok: false, error: "no GEMINI_API_KEY in Script Properties" });
  var prompt = String(body.prompt || "").slice(0, 20000);
  var images = Array.isArray(body.images) ? body.images.slice(0, 8) : [];
  if (!prompt || !images.length) return json({ ok: false, error: "need prompt + images" });
  var maxTokens = Math.min(Math.max(Number(body.maxTokens) || 1200, 100), 4000);
  var temperature =
    body.temperature == null ? 0.2 : Math.min(Math.max(Number(body.temperature), 0), 1);

  var parts = [{ text: prompt }];
  for (var i = 0; i < images.length; i++) {
    parts.push({ inline_data: { mime_type: "image/jpeg", data: stripDataUrl(images[i]) } });
  }
  var resp = UrlFetchApp.fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=" +
      encodeURIComponent(key),
    {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        contents: [{ role: "user", parts: parts }],
        generationConfig: { temperature: temperature, maxOutputTokens: maxTokens },
      }),
      muteHttpExceptions: true,
    }
  );
  var code = resp.getResponseCode();
  var data = null;
  try {
    data = JSON.parse(resp.getContentText());
  } catch (e) {
    data = null;
  }
  if (code !== 200 || !data) {
    var msg =
      data && data.error ? String(data.error.message || "").slice(0, 160) : "HTTP " + code;
    return json({ ok: false, error: "gemini: " + msg });
  }
  var text = "";
  try {
    text = data.candidates[0].content.parts
      .map(function (p) {
        return p.text || "";
      })
      .join("");
  } catch (e) {
    text = "";
  }
  if (!text.trim()) return json({ ok: false, error: "empty gemini reply" });
  return json({ ok: true, text: text.trim(), provider: "gemini", model: "gemini-3.6-flash", leaked: true });
}
