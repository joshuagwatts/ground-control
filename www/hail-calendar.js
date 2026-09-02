/** Parse hail/storm timestamps into YYYY-MM-DD (calendar day, no timezone shift). */
export function parseStormDay(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slash = s.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
  if (slash) return `${slash[1]}-${slash[2]}-${slash[3]}`;
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return "";
}

/**
 * Storm calendar day in America/Chicago.
 * Evening OK storms after ~19:00 CDT are next-day UTC — HailTrace / SPC use local day.
 */
export function centralStormDay(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (!/T\d{2}:|Z$|[+-]\d{2}:?\d{2}$|\d{2}:\d{2}/.test(s)) return parseStormDay(s);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return parseStormDay(s);
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return parseStormDay(s);
  }
}

export const HAIL_EXTREME_IN = 2;
export const HAIL_PIN_CALENDAR_IN = 1;

/** Build a month grid (Sun–Sat weeks). Cells: { day, inMonth, iso }. */
export function calendarWeeks(year, monthIndex) {
  const y = Number(year);
  const m = Number(monthIndex);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return [];
  const first = new Date(y, m, 1);
  const last = new Date(y, m + 1, 0);
  const daysInMonth = last.getDate();
  const startPad = first.getDay();
  const cells = [];
  const padIso = (yy, mm, dd) =>
    `${yy}-${String(mm + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;

  const prevLast = new Date(y, m, 0).getDate();
  for (let i = startPad - 1; i >= 0; i--) {
    const d = prevLast - i;
    const pm = m - 1;
    const py = pm < 0 ? y - 1 : y;
    const pmi = pm < 0 ? 11 : pm;
    cells.push({ day: d, inMonth: false, iso: padIso(py, pmi, d) });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, inMonth: true, iso: padIso(y, m, d) });
  }
  let tail = 1;
  while (cells.length % 7 !== 0) {
    const nm = m + 1;
    const ny = nm > 11 ? y + 1 : y;
    const nmi = nm > 11 ? 0 : nm;
    cells.push({ day: tail, inMonth: false, iso: padIso(ny, nmi, tail) });
    tail++;
  }
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function renderStormCalendar(
  {
    year,
    month,
    highlightDays = new Set(),
    stormDays = new Set(),
    selectedDays = new Set(),
    subtitle = "",
    esc = (s) => String(s ?? ""),
  },
) {
  const y = Number(year);
  const m = Number(month);
  const weeks = calendarWeeks(y, m);
  const monthLabel = new Date(y, m, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const hi = highlightDays instanceof Set ? highlightDays : new Set(highlightDays || []);
  const storms = stormDays instanceof Set ? stormDays : new Set(stormDays || []);
  const sel = selectedDays instanceof Set ? selectedDays : new Set(selectedDays || []);
  const head = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]
    .map((d) => `<span class="hs-cal-dow">${d}</span>`)
    .join("");
  const rows = weeks
    .map((week) => {
      const cells = week
        .map((c) => {
          const strong = hi.has(c.iso);
          const storm = storms.has(c.iso);
          const on = sel.has(c.iso);
          const pickable = c.inMonth;
          const cls = [
            "hs-cal-day",
            c.inMonth ? "in-month" : "out-month",
            strong ? "hs-cal-hail" : storm ? "hs-cal-storm" : "",
            on ? "hs-cal-on" : "",
            pickable ? "hs-cal-pick" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return `<button type="button" class="${cls}" data-cal-day="${esc(c.iso)}"${
            pickable ? "" : " disabled tabindex=\"-1\""
          } aria-pressed="${on ? "true" : "false"}">${c.day}</button>`;
        })
        .join("");
      return `<div class="hs-cal-week">${cells}</div>`;
    })
    .join("");
  return `<div class="hs-cal-inner">
    <header class="hs-cal-head">
      <button type="button" class="hs-cal-nav" data-cal-nav="prev" aria-label="Previous month">‹</button>
      <span class="hs-cal-title">${esc(monthLabel)}</span>
      <button type="button" class="hs-cal-nav" data-cal-nav="next" aria-label="Next month">›</button>
    </header>
    <div class="hs-cal-dows">${head}</div>
    <div class="hs-cal-grid">${rows}</div>
    ${subtitle ? `<p class="hs-cal-legend muted">${esc(subtitle)}</p>` : ""}
  </div>`;
}

export function bindStormCalendar(root, { onDay, onNav } = {}) {
  if (!root) return;
  root.querySelectorAll("[data-cal-day].hs-cal-pick").forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      onDay?.(btn.getAttribute("data-cal-day"));
    };
  });
  root.querySelectorAll("[data-cal-nav]").forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      onNav?.(btn.getAttribute("data-cal-nav"));
    };
  });
}

export function defaultCalendarMonth(highlightDays) {
  const hi = highlightDays instanceof Set ? [...highlightDays] : [...(highlightDays || [])];
  if (hi.length) {
    const sorted = hi.sort((a, b) => b.localeCompare(a));
    const d = parseStormDay(sorted[0]);
    if (d) {
      const [y, mo] = d.split("-").map(Number);
      return { year: y, month: mo - 1 };
    }
  }
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() };
}
