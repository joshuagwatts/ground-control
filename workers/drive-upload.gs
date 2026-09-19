/**
 * High Ground Field Videos — Google Drive upload bridge.
 *
 * Runs as High Ground's Google account. The Ground Control app POSTs here;
 * this script creates a Drive resumable-upload session (using the account's
 * own OAuth token — no secrets on crew phones), and the phone uploads video
 * bytes DIRECTLY to Google. This script never sees the video bytes.
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
 */

var SHARED_SECRET = "CHANGE_ME_TO_A_LONG_RANDOM_STRING";
var ROOT_FOLDER = "High Ground Field Videos";

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents || "{}");
    if (String(body.secret || "") !== SHARED_SECRET) {
      return json({ ok: false, error: "bad secret" });
    }
    var action = String(body.action || "");
    if (action === "start") return handleStart(body);
    if (action === "finish") return handleFinish(body);
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

/** Find-or-create a folder path like "High Ground Field Videos/123 Main St". */
function ensureFolder(path) {
  var parts = String(path || ROOT_FOLDER)
    .split("/")
    .map(function (p) { return p.trim(); })
    .filter(Boolean);
  if (!parts.length) parts = [ROOT_FOLDER];
  var parent = null;
  var folder = null;
  for (var i = 0; i < parts.length; i++) {
    var name = parts[i];
    var it;
    if (!parent) {
      it = DriveApp.getFoldersByName(name);
    } else {
      it = parent.getFoldersByName(name);
    }
    if (it.hasNext()) {
      folder = it.next();
    } else {
      folder = parent ? parent.createFolder(name) : DriveApp.createFolder(name);
    }
    parent = folder;
  }
  return folder;
}

function handleStart(body) {
  var fileName = String(body.fileName || "field-video.mp4").slice(0, 120);
  var mimeType = String(body.mimeType || "video/mp4").slice(0, 80);
  var size = Number(body.size || 0);
  if (!(size > 0)) return json({ ok: false, error: "bad size" });
  var folder = ensureFolder(body.folderPath);

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
