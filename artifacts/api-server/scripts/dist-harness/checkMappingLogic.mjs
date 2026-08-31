// src/lib/inquirySourceFields.ts
var INTERPRET_TYPES = [
  "\uB3D9\uC2DC\uD1B5\uC5ED",
  "\uC21C\uCC28\uD1B5\uC5ED",
  "\uC704\uC2A4\uD37C\uB9C1\uD1B5\uC5ED",
  "\uC218\uD589\uD1B5\uC5ED",
  "VIP\uC218\uD589\uD1B5\uC5ED",
  "\uAC00\uC774\uB4DC\uD1B5\uC5ED",
  "\uBBF8\uD305\uD1B5\uC5ED",
  "\uC804\uC2DC\uD68C\uD1B5\uC5ED",
  "\uD654\uC0C1\uD1B5\uC5ED",
  "\uC804\uD654\uD1B5\uC5ED",
  "\uAE30\uD0C0\uD1B5\uC5ED"
];
var DOCUMENT_TYPES = ["Word", "Excel", "PowerPoint", "PDF", "\uD55C\uAE00", "\uC774\uBBF8\uC9C0", "\uAE30\uD0C0"];
var LABEL_DICT = [
  { key: "companyName", labels: ["\uD68C\uC0AC\uBA85", "\uD68C\uC0AC", "\uAC70\uB798\uCC98", "\uAC70\uB798\uCC98\uBA85", "\uC5C5\uCCB4\uBA85", "\uC5C5\uCCB4", "\uAE30\uAD00\uBA85", "\uAE30\uAD00", "\uACE0\uAC1D\uC0AC", "company", "companyname"] },
  { key: "department", labels: ["\uBD80\uC11C", "\uBD80\uC11C\uBA85", "\uC18C\uC18D", "\uD300", "department"] },
  { key: "contactName", labels: ["\uB2F4\uB2F9\uC790", "\uB2F4\uB2F9\uC790\uBA85", "\uB2F4\uB2F9", "\uC131\uBA85", "\uC774\uB984", "\uC5F0\uB77D\uB2F4\uB2F9", "\uC2E0\uCCAD\uC790", "contact", "name"] },
  { key: "contactPosition", labels: ["\uC9C1\uD568", "\uC9C1\uAE09", "\uC9C1\uC704", "position", "title"] },
  { key: "contactPhone", labels: ["\uC804\uD654", "\uC804\uD654\uBC88\uD638", "\uC720\uC120", "\uC720\uC120\uC804\uD654", "\uC0AC\uBB34\uC2E4", "\uC0AC\uBB34\uC2E4\uC804\uD654", "\uB300\uD45C\uBC88\uD638", "tel", "phone", "\uC5F0\uB77D\uCC98"] },
  { key: "contactMobile", labels: ["\uD734\uB300\uD3F0", "\uD734\uB300\uC804\uD654", "\uD578\uB4DC\uD3F0", "\uD578\uB4DC\uD3F0\uBC88\uD638", "\uD734\uB300\uD3F0\uBC88\uD638", "\uBAA8\uBC14\uC77C", "mobile", "hp", "cell"] },
  { key: "contactEmail", labels: ["\uC774\uBA54\uC77C", "\uBA54\uC77C", "\uC774\uBA54\uC77C\uC8FC\uC18C", "e-mail", "email", "mail"] },
  // 통역할 언어(단일 셀) — 이후 방향(출발/도착) 분해. 별도 라벨이면 languageFrom/To 로 직접 매핑.
  { key: "languages", labels: ["\uD1B5\uC5ED\uD560\uC5B8\uC5B4", "\uD1B5\uC5ED\uC5B8\uC5B4", "\uC5B8\uC5B4", "\uBC88\uC5ED\uC5B8\uC5B4", "\uC5B8\uC5B4\uC30D", "language", "languages", "\uC5B8\uC5B4\uD398\uC5B4"] },
  { key: "languageFrom", labels: ["\uCD9C\uBC1C\uC5B8\uC5B4", "\uC6D0\uBCF8\uC5B8\uC5B4", "\uCD9C\uBC1C\uC5B4", "\uCD9C\uBC1C", "\uC6D0\uBB38\uC5B8\uC5B4", "source", "sourcelanguage"] },
  { key: "languageTo", labels: ["\uB3C4\uCC29\uC5B8\uC5B4", "\uBAA9\uD45C\uC5B8\uC5B4", "\uB3C4\uCC29\uC5B4", "\uB3C4\uCC29", "target", "targetlanguage"] },
  { key: "interpretType", labels: ["\uD1B5\uC5ED\uC758\uD615\uD0DC", "\uD1B5\uC5ED\uD615\uD0DC", "\uD1B5\uC5ED\uC885\uB958", "\uD1B5\uC5ED\uBC29\uC2DD", "\uD1B5\uC5ED\uC720\uD615", "interpretationtype"] },
  { key: "interpretDuration", labels: ["1\uC77C\uD1B5\uC5ED\uC2DC\uAC04", "\uC77C\uD1B5\uC5ED\uC2DC\uAC04", "\uD1B5\uC5ED\uC2DC\uAC04", "\uC18C\uC694\uC2DC\uAC04", "\uD1B5\uC5ED\uC18C\uC694\uC2DC\uAC04", "\uD1B5\uC5ED\uC2DC\uAC04\uB300"] },
  { key: "schedule", labels: ["\uD1B5\uC5ED\uC77C\uC815\uBC0F\uAE30\uAC04", "\uD1B5\uC5ED\uC77C\uC815", "\uD1B5\uC5ED\uC77C\uC2DC", "\uD589\uC0AC\uC77C\uC2DC", "\uD589\uC0AC\uC77C\uC815", "\uC77C\uC815", "\uAE30\uAC04", "\uC77C\uC815\uBC0F\uAE30\uAC04", "\uD1B5\uC5ED\uAE30\uAC04", "\uBC88\uC5ED\uAE30\uAC04", "\uD589\uC0AC\uAE30\uAC04", "schedule", "date"] },
  { key: "place", labels: ["\uD1B5\uC5ED\uC218\uD589\uC7A5\uC18C", "\uD1B5\uC5ED\uC7A5\uC18C", "\uC7A5\uC18C", "\uD589\uC0AC\uC7A5", "\uC218\uD589\uC7A5\uC18C", "\uD589\uC0AC\uC7A5\uC18C", "venue", "location", "place"] },
  { key: "subject", labels: ["\uD1B5\uC5ED\uD560\uC8FC\uC81C", "\uD1B5\uC5ED\uC8FC\uC81C", "\uC8FC\uC81C", "\uD68C\uC758\uBA85", "\uD589\uC0AC\uBA85", "\uBC88\uC5ED\uBD84\uC57C", "\uBD84\uC57C", "\uC8FC\uC81C\uBC0F\uB0B4\uC6A9", "\uD68C\uC758\uC8FC\uC81C", "subject", "topic"] },
  { key: "requirements", labels: ["\uC694\uAD6C\uBC0F\uC8FC\uC758\uC0AC\uD56D", "\uC694\uAD6C\uBC0F\uC8FC\uC758", "\uC694\uAD6C\uC0AC\uD56D", "\uC694\uCCAD\uC0AC\uD56D", "\uD2B9\uC774\uC0AC\uD56D", "\uBE44\uACE0", "\uAE30\uD0C0", "\uCC38\uACE0\uC0AC\uD56D", "\uC694\uCCAD\uB0B4\uC6A9", "\uBA54\uBAA8", "note", "notes", "requirements", "remarks"] },
  { key: "documentType", labels: ["\uC6D0\uBB38\uC11C\uD615\uD0DC", "\uBB38\uC11C\uD615\uD0DC", "\uD30C\uC77C\uD615\uC2DD", "\uBB38\uC11C\uD615\uC2DD", "documenttype"] },
  { key: "documentUsage", labels: ["\uC0AC\uC6A9\uC6A9\uB3C4", "\uC6A9\uB3C4", "\uBC88\uC5ED\uC6A9\uB3C4", "\uC81C\uCD9C\uCC98", "usage"] },
  { key: "volume", labels: ["\uBD84\uB7C9", "\uC218\uB7C9", "\uD398\uC774\uC9C0", "\uD398\uC774\uC9C0\uC218", "\uB2E8\uC5B4\uC218", "volume", "pages"] },
  { key: "desiredCompletionDate", labels: ["\uB0A9\uAE30", "\uD76C\uB9DD\uB0A9\uAE30", "\uC644\uB8CC\uC77C", "\uD76C\uB9DD\uC644\uB8CC\uC77C", "\uB9C8\uAC10\uC77C", "\uB0A9\uD488\uC77C", "duedate", "deadline"] },
  { key: "quoteDueDate", labels: ["\uACAC\uC801\uC694\uCCAD\uC77C", "\uACAC\uC801\uB9C8\uAC10", "\uACAC\uC801\uD76C\uB9DD\uC77C", "\uACAC\uC801\uC694\uCCAD\uB9C8\uAC10"] },
  { key: "channelHint", labels: ["\uC811\uC218\uACBD\uB85C", "\uC811\uC218\uCC44\uB110", "\uBB38\uC758\uACBD\uB85C", "\uCC44\uB110", "channel"] },
  { key: "serviceHint", labels: ["\uC11C\uBE44\uC2A4\uC720\uD615", "\uC11C\uBE44\uC2A4", "\uC758\uB8B0\uC720\uD615", "\uC694\uCCAD\uC11C\uBE44\uC2A4", "servicetype"] }
];
function normalizeLabel(s) {
  return s.replace(/[\s　]+/g, "").replace(/^[-*·•▶◆■○◦▪▷»♦※\d.)\]]+/, "").replace(/[:：*)\]\-]+$/, "").toLowerCase();
}
var DICT_MAP = (() => {
  const m = /* @__PURE__ */ new Map();
  for (const { key, labels } of LABEL_DICT) {
    for (const lb of labels) m.set(normalizeLabel(lb), key);
  }
  return m;
})();
var SYNONYMS = LABEL_DICT.flatMap(({ key, labels }) => labels.map((lb) => ({ norm: normalizeLabel(lb), key }))).filter((s) => s.norm.length >= 2).sort((a, b) => b.norm.length - a.norm.length);
function matchLabelKey(label) {
  const n = normalizeLabel(label);
  if (!n) return null;
  const exact = DICT_MAP.get(n);
  if (exact) return exact;
  for (const s of SYNONYMS) {
    if (n.includes(s.norm)) return s.key;
  }
  return null;
}
var MULTILINE_KEYS = /* @__PURE__ */ new Set(["requirements", "subject", "schedule"]);
function stripHelperText(value) {
  if (!value) return "";
  let v = value;
  v = v.replace(/[（(]\s*(?:ex|e\.?g\.?|예시|예|참고|보기)\b[^)）]*[)）]/gi, " ");
  v = v.replace(/(?:^|[\s,/·|(])(?:ex|예시|예)\s*[)\]:：.][^\n]*/gi, " ");
  return v.replace(/[ \t]{2,}/g, " ").trim();
}
function sourceFieldsFromLabelValueRows(rows2, origin = "document") {
  const sf2 = {};
  for (const r of rows2) {
    const label = typeof r?.label === "string" ? r.label.trim() : "";
    const rawIn = typeof r?.value === "string" ? r.value : "";
    if (!label) continue;
    const key = matchLabelKey(label);
    if (!key) continue;
    if (sf2[key]?.raw.trim()) continue;
    const raw = MULTILINE_KEYS.has(key) ? rawIn.trim() : stripHelperText(rawIn).trim();
    if (!raw) continue;
    sf2[key] = { raw, sourceLabel: label, origin };
  }
  return sf2;
}
function splitLanguages(raw) {
  const src = (raw || "").trim();
  if (!src) return { from: "", to: "", ambiguous: false };
  const sub = src.match(/출발\s*[:：]?\s*(.+?)\s*(?:도착|→|->)\s*[:：]?\s*(.+)$/);
  if (sub) return { from: sub[1].trim(), to: sub[2].trim(), ambiguous: false };
  const D = "";
  const normalized = src.replace(/에서/g, D).replace(/(?:->|=>|~>|→|⇒|↔|⇄|~|∼|>|\/|\||、|,|…|\.{2,}|―|—|-)/g, D);
  const parts = normalized.split(D).map((s) => s.replace(/(?:으로|로)\s*$/, "").trim()).filter(Boolean);
  if (parts.length === 0) return { from: src, to: "", ambiguous: true };
  if (parts.length === 1) return { from: parts[0], to: "", ambiguous: true };
  return { from: parts[0], to: parts.slice(1).join(" "), ambiguous: false };
}
function matchInterpretType(raw) {
  const s = (raw || "").replace(/\s+/g, "");
  let best = "";
  let bestIdx = Infinity;
  for (const t of INTERPRET_TYPES) {
    const idx = s.indexOf(t.replace(/\s+/g, ""));
    if (idx >= 0 && (idx < bestIdx || idx === bestIdx && t.length > best.length)) {
      best = t;
      bestIdx = idx;
    }
  }
  return best;
}
function matchDocumentType(raw) {
  const s = (raw || "").toLowerCase();
  const hit = DOCUMENT_TYPES.find((t) => s.includes(t.toLowerCase()));
  return hit ?? "";
}
function kstYear() {
  return Number((/* @__PURE__ */ new Date()).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }).slice(0, 4));
}
function pad2(n) {
  return String(n).padStart(2, "0");
}
function parseDate(raw) {
  const s = (raw || "").trim();
  if (!s) return null;
  let m = s.match(/(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`;
  m = s.match(/(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*일?/);
  if (m) return `${kstYear()}-${pad2(+m[1])}-${pad2(+m[2])}`;
  return null;
}
function parseTime(raw) {
  const s = (raw || "").trim();
  let m = s.match(/(오전|오후)?\s*(\d{1,2})\s*시\s*(\d{1,2})?\s*분?/);
  if (m) {
    let h = +m[2];
    if (m[1] === "\uC624\uD6C4" && h < 12) h += 12;
    if (m[1] === "\uC624\uC804" && h === 12) h = 0;
    return `${pad2(h)}:${pad2(m[3] ? +m[3] : 0)}`;
  }
  m = s.match(/(\d{1,2}):(\d{2})/);
  if (m) return `${pad2(+m[1])}:${m[2]}`;
  return null;
}
function parseSchedule(raw) {
  const s = (raw || "").trim();
  if (!s) return { from: "", to: "", parsed: false };
  const rangeParts = s.replace(/부터|까지/g, " ").split(/\s*(?:~|∼|—|―|·)\s*|\s+-\s+|\s+to\s+/i).map((p) => p.trim()).filter(Boolean);
  const build = (part, fallbackDate) => {
    const d = parseDate(part) ?? fallbackDate ?? null;
    if (!d) return "";
    const t = parseTime(part) ?? "09:00";
    return `${d}T${t}`;
  };
  if (rangeParts.length >= 2) {
    const from2 = build(rangeParts[0]);
    const toDate = parseDate(rangeParts[1]);
    const to = build(rangeParts[1], toDate ? void 0 : from2 ? from2.slice(0, 10) : void 0);
    return { from: from2, to, parsed: !!(from2 || to) };
  }
  const from = build(s);
  return { from, to: "", parsed: !!from };
}
var CHANNEL_WORDS = {
  \uC804\uD654: "phone",
  \uC720\uC120: "phone",
  \uC774\uBA54\uC77C: "email",
  \uBA54\uC77C: "email",
  email: "email",
  \uD648\uD398\uC774\uC9C0: "homepage",
  \uC6F9\uC0AC\uC774\uD2B8: "homepage",
  homepage: "homepage",
  \uCE74\uCE74\uC624: "kakao",
  \uCE74\uD1A1: "kakao",
  kakao: "kakao"
};
function mapSourceFieldsToForm(sf2, channelDefault = "") {
  const fields2 = {};
  const warnings2 = [];
  const evidence = {};
  const inferredLabels = [];
  const take = (key, formKey, label) => {
    const f = sf2[key];
    if (!f || !f.raw.trim()) return;
    fields2[formKey] = f.raw;
    evidence[formKey] = `${f.sourceLabel}: ${f.raw}`.slice(0, 200);
    if (f.origin === "inferred") inferredLabels.push(label);
  };
  take("companyName", "customerCompanyName", "\uD68C\uC0AC\uBA85");
  take("department", "department", "\uBD80\uC11C");
  take("contactName", "contactName", "\uB2F4\uB2F9\uC790");
  take("contactPosition", "contactPosition", "\uC9C1\uD568");
  take("contactPhone", "contactPhone", "\uC804\uD654\uBC88\uD638");
  take("contactMobile", "contactMobile", "\uD734\uB300\uD3F0");
  take("contactEmail", "contactEmail", "\uC774\uBA54\uC77C");
  take("interpretDuration", "interpretDuration", "1\uC77C \uD1B5\uC5ED\uC2DC\uAC04");
  take("place", "place", "\uD1B5\uC5ED\uC7A5\uC18C");
  take("subject", "subject", "\uD1B5\uC5ED\uC8FC\uC81C");
  take("requirements", "requirements", "\uC694\uAD6C\uC0AC\uD56D");
  take("documentUsage", "documentUsage", "\uC0AC\uC6A9\uC6A9\uB3C4");
  take("volume", "volume", "\uBD84\uB7C9");
  if (sf2.languageFrom?.raw.trim() || sf2.languageTo?.raw.trim()) {
    take("languageFrom", "languageFrom", "\uCD9C\uBC1C\uC5B8\uC5B4");
    take("languageTo", "languageTo", "\uB3C4\uCC29\uC5B8\uC5B4");
  } else if (sf2.languages?.raw.trim()) {
    const langEv = `${sf2.languages.sourceLabel}: ${sf2.languages.raw}`.slice(0, 200);
    const { from, to, ambiguous } = splitLanguages(sf2.languages.raw);
    if (from) {
      fields2.languageFrom = from;
      evidence.languageFrom = langEv;
    }
    if (to) {
      fields2.languageTo = to;
      evidence.languageTo = langEv;
    }
    if (sf2.languages.origin === "inferred") inferredLabels.push("\uC5B8\uC5B4");
    if (ambiguous) warnings2.push(`\uC5B8\uC5B4 \uBC29\uD5A5(\uCD9C\uBC1C/\uB3C4\uCC29) \uD655\uC778\uD544\uC694 \u2014 \uC6D0\uBB38: "${sf2.languages.raw}"`);
  }
  if (sf2.interpretType?.raw.trim()) {
    const matched = matchInterpretType(sf2.interpretType.raw);
    if (matched) {
      fields2.interpretType = matched;
      evidence.interpretType = `${sf2.interpretType.sourceLabel}: ${sf2.interpretType.raw}`.slice(0, 200);
      if (sf2.interpretType.origin === "inferred") inferredLabels.push("\uD1B5\uC5ED\uD615\uD0DC");
    } else {
      warnings2.push(`\uD1B5\uC5ED\uD615\uD0DC \uD655\uC778\uD544\uC694 \u2014 \uC6D0\uBB38 "${sf2.interpretType.raw}" \uC774(\uAC00) \uACE0\uC815 \uD56D\uBAA9\uACFC \uC77C\uCE58\uD558\uC9C0 \uC54A\uC74C`);
    }
  }
  if (sf2.documentType?.raw.trim()) {
    const matched = matchDocumentType(sf2.documentType.raw);
    if (matched) {
      fields2.documentType = matched;
      evidence.documentType = `${sf2.documentType.sourceLabel}: ${sf2.documentType.raw}`.slice(0, 200);
    } else warnings2.push(`\uBB38\uC11C\uD615\uD0DC \uD655\uC778\uD544\uC694 \u2014 \uC6D0\uBB38 "${sf2.documentType.raw}"`);
  }
  if (sf2.schedule?.raw.trim()) {
    const { from, to, parsed } = parseSchedule(sf2.schedule.raw);
    if (from) fields2.scheduleFrom = from;
    if (to) fields2.scheduleTo = to;
    evidence.schedule = `${sf2.schedule.sourceLabel}: ${sf2.schedule.raw}`.slice(0, 200);
    if (sf2.schedule.origin === "inferred") inferredLabels.push("\uD1B5\uC5ED\uC77C\uC815");
    if (!parsed) warnings2.push(`\uD1B5\uC5ED\uC77C\uC815 \uD655\uC778\uD544\uC694(\uC790\uB3D9 \uD30C\uC2F1 \uC2E4\uD328) \u2014 \uC6D0\uBB38: "${sf2.schedule.raw}"`);
  }
  if (sf2.desiredCompletionDate?.raw.trim()) {
    const d = parseDate(sf2.desiredCompletionDate.raw);
    if (d) {
      fields2.desiredCompletionDate = d;
      evidence.desiredCompletionDate = `${sf2.desiredCompletionDate.sourceLabel}: ${sf2.desiredCompletionDate.raw}`.slice(0, 200);
    } else warnings2.push(`\uB0A9\uAE30 \uD655\uC778\uD544\uC694 \u2014 \uC6D0\uBB38: "${sf2.desiredCompletionDate.raw}"`);
  }
  if (sf2.quoteDueDate?.raw.trim()) {
    const d = parseDate(sf2.quoteDueDate.raw);
    if (d) {
      fields2.quoteDueDate = d;
      evidence.quoteDueDate = `${sf2.quoteDueDate.sourceLabel}: ${sf2.quoteDueDate.raw}`.slice(0, 200);
    }
  }
  const has = (k) => !!sf2[k]?.raw.trim();
  let serviceType = "";
  if (sf2.serviceHint?.raw.trim()) {
    const v = sf2.serviceHint.raw;
    if (/통역/.test(v)) serviceType = "interpretation";
    else if (/번역/.test(v)) serviceType = "translation";
    else if (/장비/.test(v)) serviceType = "equipment";
  }
  if (!serviceType) {
    if (has("interpretType") || has("interpretDuration") || has("languages") || has("languageFrom") || has("place")) serviceType = "interpretation";
    else if (has("documentType") || has("volume") || has("documentUsage")) serviceType = "translation";
  }
  if (serviceType) fields2.serviceType = serviceType;
  if (sf2.channelHint?.raw.trim()) {
    const v = sf2.channelHint.raw.toLowerCase();
    const found = Object.keys(CHANNEL_WORDS).find((w) => v.includes(w.toLowerCase()));
    if (found) fields2.channel = CHANNEL_WORDS[found];
  }
  if (!fields2.channel && channelDefault) fields2.channel = channelDefault;
  if (inferredLabels.length > 0) {
    warnings2.push(`AI \uCD94\uB860 \uAC12(\uC6D0\uBB38 \uB77C\uBCA8 \uC5C6\uC74C) \u2014 \uD655\uC778\uD544\uC694: ${[...new Set(inferredLabels)].join(", ")}`);
  }
  return { fields: fields2, warnings: warnings2, evidence };
}

// scripts/checkMappingLogic.ts
var rows = [
  { label: "\uD68C\uC0AC\uBA85", value: "\uD55C\uAD6D\uBDF0\uB85C\uBCA0\uB9AC\uD0C0\uC2A4" },
  { label: "\uBD80\uC11C", value: "CER" },
  { label: "\uB2F4\uB2F9\uC790", value: "\uC870\uC608\uB9AC" },
  { label: "\uC9C1\uD568", value: "\uC0AC\uC6D0" },
  { label: "\uC804\uD654\uBC88\uD638", value: "02-6925-5805" },
  { label: "\uD734\uB300\uD3F0", value: "010-2240-4330" },
  { label: "\uD68C\uC0AC E-mail", value: "ye-ri.cho@bureauveritas.com" },
  { label: "\uC11C\uBE44\uC2A4 \uC720\uD615", value: "\uD1B5\uC5ED" },
  { label: "\uCD9C\uBC1C\uC5B8\uC5B4", value: "\uD55C\uAD6D\uC5B4" },
  { label: "\uB3C4\uCC29\uC5B8\uC5B4", value: "\uB9D0\uB808\uC774\uC2DC\uC544\uC5B4" },
  { label: "\uD1B5\uC5ED\uC758 \uD615\uD0DC", value: "\uB3D9\uC2DC\uD1B5\uC5ED ex) \uB3D9\uC2DC\uD1B5\uC5ED, \uC21C\uCC28\uD1B5\uC5ED" },
  { label: "\uD1B5\uC5ED \uC77C\uC815", value: "2026-09-02" },
  { label: "1\uC77C \uD1B5\uC5ED\uC2DC\uAC04", value: "9\uC2DC\uAC04 ex) 8\uC2DC\uAC04" },
  { label: "\uD1B5\uC5ED\uD560 \uC8FC\uC81C", value: "\uC77C\uBC18\uD1B5\uC5ED ex) \uC758\uD559,\uBC95\uD559" },
  { label: "\uD1B5\uC5ED \uC218\uD589 \uC7A5\uC18C", value: "\uB9D0\uB808\uC774\uC2DC\uC544 ex) \uB9D0\uB808\uC774\uC2DC\uC544, \uC2F1\uAC00\uD3EC\uB974" },
  { label: "\uC694\uAD6C \uBC0F \uC8FC\uC758\uC0AC\uD56D", value: "\uD589\uC0AC \uB2F9\uC77C \uC624\uC804 8\uC2DC\uAE4C\uC9C0 \uD604\uC7A5 \uB3C4\uCC29 \uC694\uB9DD.\n\uD1B5\uC5ED\uC0AC 2\uBA85 \uD544\uC694, \uBCF5\uC7A5 \uC815\uC7A5." }
];
var expected = {
  customerCompanyName: "\uD55C\uAD6D\uBDF0\uB85C\uBCA0\uB9AC\uD0C0\uC2A4",
  department: "CER",
  contactName: "\uC870\uC608\uB9AC",
  contactPosition: "\uC0AC\uC6D0",
  contactPhone: "02-6925-5805",
  contactMobile: "010-2240-4330",
  contactEmail: "ye-ri.cho@bureauveritas.com",
  serviceType: "interpretation",
  languageFrom: "\uD55C\uAD6D\uC5B4",
  languageTo: "\uB9D0\uB808\uC774\uC2DC\uC544\uC5B4",
  interpretType: "\uB3D9\uC2DC\uD1B5\uC5ED",
  scheduleFrom: "2026-09-02T09:00",
  interpretDuration: "9\uC2DC\uAC04",
  subject: "\uC77C\uBC18\uD1B5\uC5ED ex) \uC758\uD559,\uBC95\uD559",
  place: "\uB9D0\uB808\uC774\uC2DC\uC544"
};
var sf = sourceFieldsFromLabelValueRows(rows, "document");
var { fields, warnings } = mapSourceFieldsToForm(sf);
var rowsOut = [];
var labelByFk = {
  customerCompanyName: "\uD68C\uC0AC\uBA85",
  department: "\uBD80\uC11C",
  contactName: "\uB2F4\uB2F9\uC790",
  contactPosition: "\uC9C1\uD568",
  contactPhone: "\uC804\uD654\uBC88\uD638",
  contactMobile: "\uD734\uB300\uD3F0",
  contactEmail: "\uC774\uBA54\uC77C",
  serviceType: "\uC11C\uBE44\uC2A4\uC720\uD615",
  languageFrom: "\uCD9C\uBC1C\uC5B8\uC5B4",
  languageTo: "\uB3C4\uCC29\uC5B8\uC5B4",
  interpretType: "\uD1B5\uC5ED\uD615\uD0DC",
  scheduleFrom: "\uD1B5\uC5ED\uC77C\uC815",
  interpretDuration: "1\uC77C \uD1B5\uC5ED\uC2DC\uAC04",
  subject: "\uD1B5\uC5ED\uC8FC\uC81C",
  place: "\uD1B5\uC5ED\uC7A5\uC18C"
};
var pass = 0;
for (const [fk, exp] of Object.entries(expected)) {
  const got = fields[fk] ?? "";
  const ok = got.trim() === exp.trim();
  if (ok) pass++;
  rowsOut.push([labelByFk[fk] ?? fk, exp, got, "", ok]);
}
var cell = (s, n = 30) => {
  const t = (s ?? "").replace(/\n/g, " \u23CE ");
  return t.length > n ? t.slice(0, n - 1) + "\u2026" : t;
};
console.log("| \uD544\uB4DC | \uC815\uB2F5\uAC12 | \uB9E4\uD551 \uACB0\uACFC | \uC77C\uCE58 |");
console.log("|---|---|---|---|");
for (const [label, exp, got, , ok] of rowsOut) {
  console.log(`| ${label} | ${cell(exp)} | ${cell(got)} | ${ok ? "\u2705" : "\u274C"} |`);
}
console.log(`
\uC694\uC57D: ${pass}/${Object.keys(expected).length} \uC77C\uCE58`);
if (warnings.length) {
  console.log("\n[warnings]");
  warnings.forEach((w) => console.log(" - " + w));
}
console.log("\n[\uC694\uAD6C\uC0AC\uD56D \uBCF4\uC874 \uD655\uC778]");
console.log("  raw:", JSON.stringify(sf.requirements?.raw));
console.log("  form:", JSON.stringify(fields.requirements));
