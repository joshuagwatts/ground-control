/**
 * HomeScope → High Ground CRM handoff.
 * Posts lead + hail report HTML so CRM can create the contact and email the file.
 *
 * Set PRODUCT.crm.webhookUrl (or window.HOMESCOPE_CRM_WEBHOOK) to your CRM intake URL.
 */
import { PRODUCT } from "./product.js";

function webhookUrl() {
  const fromWindow = typeof window !== "undefined" ? String(window.HOMESCOPE_CRM_WEBHOOK || "").trim() : "";
  return fromWindow || String(PRODUCT.crm?.webhookUrl || "").trim();
}

export function buildCrmEmailPackage({ lead, reportHtml, reportText, rec } = {}) {
  const b = PRODUCT.brand;
  const to = String(lead?.email || "").trim();
  const name = String(lead?.name || "Homeowner").trim();
  const subject = `${b.company} HomeScope hail report — ${lead?.address || "your home"}`;
  const roofLine = lead?.roofLabel || lead?.roofAgeLabel || "Roof age not provided";
  const body = [
    `Hi ${name.split(/\s+/)[0] || "there"},`,
    "",
    `Here’s your High Ground HomeScope hail report for ${lead?.address || "your Oklahoma home"}.`,
    `Roof age used for the estimate: ${roofLine}.`,
    rec?.headline ? `Recommendation: ${rec.headline}` : "",
    "",
    "A branded HTML report is attached / included so you can save or print it.",
    "",
    `Questions? Call ${b.phone} or visit ${b.webLabel}.`,
    "",
    "— High Ground Roofing & Construction",
  ]
    .filter((x) => x !== "")
    .join("\n");

  return {
    to,
    subject,
    body,
    filename: "highground-homescope-hail-report.html",
    mime: "text/html;charset=utf-8",
    html: reportHtml || "",
    text: reportText || "",
  };
}

/**
 * Submit lead + report to internal CRM for contact create + outbound email.
 * Never blocks the homeowner UI — failures stay local / event-based.
 */
export async function submitHomescopeLeadToCrm(payload) {
  const url = webhookUrl();
  const detail = {
    ...payload,
    product: PRODUCT.name,
    company: PRODUCT.brand.company,
    submittedAt: new Date().toISOString(),
  };

  try {
    window.dispatchEvent(new CustomEvent("homescope:lead", { detail }));
  } catch {
    /* ignore */
  }

  if (!url) {
    console.info("[HomeScope] CRM webhook not configured — lead queued locally for CRM email", detail);
    return { ok: true, status: "queued_local", detail };
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(detail),
      mode: "cors",
      credentials: "omit",
    });
    if (!res.ok) {
      console.warn("[HomeScope] CRM webhook HTTP", res.status);
      return { ok: false, status: "webhook_error", httpStatus: res.status, detail };
    }
    return { ok: true, status: "sent", detail };
  } catch (err) {
    console.warn("[HomeScope] CRM webhook failed", err);
    return { ok: false, status: "webhook_error", error: String(err?.message || err), detail };
  }
}

/**
 * Compact lead text for the "text this to High Ground" fallback.
 * Used when the CRM webhook isn't wired (or the post failed) so the lead
 * still reaches the office as an SMS from the homeowner's own phone.
 * Pure function — safe to unit test.
 */
export function buildLeadSmsBody({ name = "", address = "", phone = "", roofAgeLabel = "", rec = null, storms = [] } = {}) {
  const who = String(name || "Homeowner").trim().slice(0, 40) || "Homeowner";
  const where = String(address || "Oklahoma home").trim().slice(0, 80) || "Oklahoma home";
  const roof = String(roofAgeLabel || "Not sure").trim().slice(0, 24) || "Not sure";
  const list = Array.isArray(storms) ? storms : [];
  const inchPlus = list.filter((s) => Number(s?.maxSizeIn) >= 1).length;
  const stat = list.length
    ? `${list.length} covering storm${list.length === 1 ? "" : "s"}${inchPlus ? `, ${inchPlus} at 1"+` : ""}`
    : "no verified covering storms on record";
  const headline = String(rec?.headline || "").trim().slice(0, 90);
  const parts = [
    `Hi, this is ${who} at ${where}.`,
    `My HomeScope hail report: ${stat}.`,
    `Roof: ${roof}.`,
    headline ? `Verdict: ${headline}.` : "",
    `Please call me about a free inspection — ${String(phone || "").trim()}.`,
  ].filter(Boolean);
  const body = parts.join(" ");
  return body.length > 480 ? `${body.slice(0, 477)}…` : body;
}
