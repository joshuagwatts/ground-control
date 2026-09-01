/** Reach — local lead queue, templates, and dispositions for field outreach. */

export const OUTREACH_STATUS = [
  { id: "queued", label: "Queued" },
  { id: "contacted", label: "Contacted" },
  { id: "callback", label: "Callback" },
  { id: "appointment", label: "Appointment" },
  { id: "won", label: "Won" },
  { id: "lost", label: "Lost" },
  { id: "skip", label: "Skip" },
];

export const OUTREACH_TEMPLATES = [
  { id: "hail_inspection", label: "Hail inspection offer" },
  { id: "storm_followup", label: "Post-storm follow-up" },
  { id: "discontinued_shingle", label: "Discontinued shingle" },
  { id: "commercial_roof", label: "Commercial roof check" },
];

const STATUS_IDS = new Set(OUTREACH_STATUS.map((s) => s.id));
const TEMPLATE_IDS = new Set(OUTREACH_TEMPLATES.map((t) => t.id));

export function leadKey(lead) {
  const lat = Number(lead?.lat);
  const lon = Number(lead?.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon)) return `${lat.toFixed(5)},${lon.toFixed(5)}`;
  return String(lead?.address || "")
    .trim()
    .toLowerCase();
}

export function stormSnippet(data) {
  const hail = Array.isArray(data?.hail) ? data.hail : [];
  if (!hail.length) return "";
  const sorted = [...hail].sort((a, b) => {
    const da = String(a.date || "").slice(0, 10);
    const db = String(b.date || "").slice(0, 10);
    if (da !== db) return db.localeCompare(da);
    return (parseFloat(b.size_in) || 0) - (parseFloat(a.size_in) || 0);
  });
  const top = sorted[0];
  const day = String(top.date || "").slice(0, 10);
  const size = parseFloat(top.size_in);
  const sizeBit = Number.isFinite(size) && size > 0 ? `${size.toFixed(1)}″ hail` : "hail";
  return day ? `${sizeBit} on ${day}` : sizeBit;
}

export function leadFromDossier(data, { source = "hailscope", template = "hail_inspection", now = new Date() } = {}) {
  const ts = now.toISOString();
  const lat = Number(data?.lat);
  const lon = Number(data?.lon);
  return {
    id: "",
    address: String(data?.address || "").trim(),
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    owner_name: String(data?.owner_name || "").trim(),
    owner_phone: String(data?.owner_phone || data?.phone || "").trim(),
    owner_email: String(data?.owner_email || data?.email || "").trim(),
    assessor_record: String(data?.assessor_record || "").trim(),
    storm: stormSnippet(data),
    source: String(source || "hailscope"),
    template: TEMPLATE_IDS.has(template) ? template : "hail_inspection",
    status: "queued",
    notes: "",
    created: ts,
    updated: ts,
    nextFollowUp: "",
  };
}

export function upsertLead(leads, lead, { idGen = () => crypto.randomUUID() } = {}) {
  const rows = Array.isArray(leads) ? [...leads] : [];
  const next = { ...lead };
  if (!next.id) next.id = idGen();
  if (!STATUS_IDS.has(next.status)) next.status = "queued";
  if (!TEMPLATE_IDS.has(next.template)) next.template = "hail_inspection";
  const key = leadKey(next);
  const idx = rows.findIndex((r) => leadKey(r) === key);
  if (idx >= 0) {
    const prev = rows[idx];
    rows[idx] = {
      ...prev,
      ...next,
      id: prev.id,
      created: prev.created || next.created,
      updated: new Date().toISOString(),
    };
    return { list: rows, lead: rows[idx], added: false };
  }
  next.created = next.created || new Date().toISOString();
  next.updated = next.updated || next.created;
  rows.unshift(next);
  return { list: rows, lead: next, added: true };
}

export function updateLead(leads, id, patch) {
  const rows = Array.isArray(leads) ? [...leads] : [];
  const idx = rows.findIndex((r) => String(r.id) === String(id));
  if (idx < 0) return { list: rows, lead: null };
  const prev = rows[idx];
  const next = {
    ...prev,
    ...patch,
    id: prev.id,
    created: prev.created,
    updated: new Date().toISOString(),
  };
  if (patch.status && !STATUS_IDS.has(patch.status)) next.status = prev.status;
  if (patch.template && !TEMPLATE_IDS.has(patch.template)) next.template = prev.template;
  rows[idx] = next;
  return { list: rows, lead: next };
}

export function removeLead(leads, id) {
  const rows = Array.isArray(leads) ? leads : [];
  return rows.filter((r) => String(r.id) !== String(id));
}

export function countByStatus(leads) {
  const counts = Object.fromEntries(OUTREACH_STATUS.map((s) => [s.id, 0]));
  for (const row of leads || []) {
    const st = STATUS_IDS.has(row.status) ? row.status : "queued";
    counts[st] = (counts[st] || 0) + 1;
  }
  return counts;
}

function firstName(full) {
  const bit = String(full || "").trim().split(/\s+/)[0];
  return bit || "there";
}

function who(settings = {}) {
  const company = String(settings.company || "Ground Control").trim();
  const operator = String(settings.operator || "").trim();
  return operator ? `${operator} at ${company}` : company;
}

export function renderOutreachMessage(templateId, lead, settings = {}) {
  const company = String(settings.company || "Ground Control").trim();
  const name = firstName(lead.owner_name);
  const addr = lead.address || "your property";
  const storm = lead.storm || "recent severe weather in your area";
  const record = lead.assessor_record ? `\n\nPublic record: ${lead.assessor_record}` : "";
  const sign = who(settings);

  if (templateId === "storm_followup") {
    const body = [
      `Hi ${name},`,
      ``,
      `This is ${sign}. We map storm paths with radar and field verification — ${storm} crossed near ${addr}.`,
      ``,
      `We offer a no-pressure roof and exterior check with photos you can keep. If there is insurable damage, we document it to manufacturer spec.`,
      ``,
      `Reply here or call us to schedule a visit.`,
      record,
      ``,
      `Thank you,`,
      sign,
    ]
      .filter((line, i, arr) => line !== "" || (arr[i - 1] !== "" && arr[i + 1] !== undefined))
      .join("\n");
    return { subject: `${company}: post-storm roof check — ${addr}`, body, channel: "sms" };
  }

  if (templateId === "discontinued_shingle") {
    const body = [
      `Hi ${name},`,
      ``,
      `This is ${sign}. From the street, the roofing on ${addr} looks like a product line that is often discontinued — patch repairs may not match manufacturer spec after storm hits.`,
      ``,
      `We can do a quick look and lay out repair vs. reroof options with no pressure.`,
      record,
      ``,
      `Thank you,`,
      sign,
    ].join("\n");
    return { subject: `${company}: roofing product note — ${addr}`, body, channel: "sms" };
  }

  if (templateId === "commercial_roof") {
    const body = [
      `Hello,`,
      ``,
      `This is ${sign}. We handle commercial roof inspections, maintenance plans, and storm documentation with drone and infrared where useful.`,
      ``,
      `We are scheduling complimentary roof walks near ${addr}. Reply or call if you would like a slot — no obligation.`,
      record,
      ``,
      `Thank you,`,
      sign,
    ].join("\n");
    return { subject: `${company}: commercial roof walk — ${addr}`, body, channel: "email" };
  }

  const body = [
    `Hi ${name},`,
    ``,
    `This is ${sign}. We use hail mapping and on-site inspection to help homeowners after Oklahoma storms — ${storm} affected properties near ${addr}.`,
    ``,
    `Would you like a free roof check with photos? No sales pressure — just a clear report you can use with your insurer or for peace of mind.`,
    record,
    ``,
    `Thank you,`,
    sign,
  ].join("\n");
  return { subject: `${company}: free hail roof check — ${addr}`, body, channel: "sms" };
}

export function phoneDigits(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d.length >= 10 ? `+${d}` : "";
}

export function outreachCsv(leads) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ["address", "owner_name", "owner_phone", "owner_email", "storm", "status", "template", "notes", "created", "updated"];
  const lines = [head.join(",")];
  for (const row of leads || []) {
    lines.push(head.map((k) => esc(row[k])).join(","));
  }
  return lines.join("\n");
}

export function statusLabel(id) {
  return OUTREACH_STATUS.find((s) => s.id === id)?.label || id;
}

export function templateLabel(id) {
  return OUTREACH_TEMPLATES.find((t) => t.id === id)?.label || id;
}
