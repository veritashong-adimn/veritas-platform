/**
 * 의뢰건 AI 분석 — 통역장비 행 정리(결정론).
 *
 *  · 원본 견적 품목 표(Service Type / Hr/Day / Quantity / Unit Price / Amount / Note)를 행 단위로 읽는다.
 *  · 장비 수량과 대여일수를 구분한다. 원문에 적힌 값은 그대로, 문맥으로 해석한 값은 inferred 로 표시한다(확인 필요).
 *  · 장비 종류·단위는 등록 화면 선택 목록(web-app constants EQUIPMENT_ITEMS / EQUIPMENT_QUANTITY_UNITS)에 있는 값만 쓴다.
 *    목록에 없으면 '기타 직접입력' + 원문 장비명 보존(목록·상품 Master 를 새로 만들지 않음).
 */

// 등록 화면 장비 종류·단위 목록과 같아야 한다(web-app/src/lib/constants.ts)
export const EQUIPMENT_KIND_OPTIONS = [
  "동시통역장비", "FM장비", "적외선장비", "리시버", "송신기", "가이드수신기", "가이드송신기", "위스퍼링수신기", "위스퍼링송신기",
  "무선마이크", "유선마이크", "핀마이크", "회의용마이크", "오디오인터페이스", "믹서", "음향콘솔", "분배기", "통역부스", "사전설치", "기타 직접입력",
] as const;
export const EQUIPMENT_UNIT_OPTIONS = ["개", "세트", "부스", "건", "대"] as const;
const CUSTOM_KIND = "기타 직접입력";

// 원문에 단위가 없을 때 장비 종류별 기본 단위 — 같은 이름의 상품 Master 단위를 따른다(동시통역장비·FM·적외선=세트, 리시버=개, 송신기·통역부스=대),
// Master 에 없는 마이크·믹서류는 개.
const KIND_DEFAULT_UNIT: Record<string, string> = {
  동시통역장비: "세트", FM장비: "세트", 적외선장비: "세트", 리시버: "개", 송신기: "대", 통역부스: "대",
  위스퍼링수신기: "개", 위스퍼링송신기: "개", 가이드수신기: "개", 가이드송신기: "개",
  무선마이크: "개", 유선마이크: "개", 핀마이크: "개", 회의용마이크: "개", 오디오인터페이스: "개", 믹서: "개", 음향콘솔: "개", 분배기: "개",
};

/** 원문 단위 표기 → 화면 단위(없으면 "") */
export function mapEquipmentUnit(raw: string): string {
  const u = (raw || "").trim();
  if (/^(?:set|sets|세트)$/i.test(u)) return "세트";
  if (/^(?:ea|pcs?|개)$/i.test(u)) return "개";
  return (EQUIPMENT_UNIT_OPTIONS as readonly string[]).includes(u) ? u : "";
}

const norm = (v: string) => v.replace(/\s+/g, "").toLowerCase();
/** 장비명 안의 수량 표기("1 set", "2세트") */
export function namedCount(name: string): { qty: string; unit: string } | null {
  const m = name.match(/(\d+)\s*(set|sets|세트|식|ea|개|대)(?![a-z가-힣])/i);
  return m ? { qty: m[1], unit: m[2] } : null;
}

/**
 * 원문 장비명 → 화면 장비 종류. exact = 목록과 같은 이름, synonym = 정의된 동의어, none = 기타 직접입력.
 *  동의어: "통역장비" → 동시통역장비 — 문서에 동시통역·부스 근거가 있을 때만(가이드·위스퍼링 장비일 수도 있어서 단독으로는 매칭하지 않음).
 */
export function matchEquipmentKind(name: string, docText: string): { kind: string; basis: "exact" | "synonym" | "none" } {
  const base = norm(name.replace(/\(?\d+\s*(?:set|sets|세트|식|ea|개|대)\)?(?![a-z가-힣])/gi, ""));
  const exact = EQUIPMENT_KIND_OPTIONS.find(k => k !== CUSTOM_KIND && norm(k) === base);
  if (exact) return { kind: exact, basis: "exact" };
  if (/^(?:동시)?통역장비(?:세트)?$/.test(base) && /동시\s*통역|부스/.test(docText)) return { kind: "동시통역장비", basis: "synonym" };
  return { kind: name.trim() ? CUSTOM_KIND : "", basis: "none" };
}

export function defaultUnitForKind(kind: string): string { return KIND_DEFAULT_UNIT[kind] ?? ""; }

export interface QuoteTableRow { name: string; hrDay: string; qty: string; unitPrice: string; amount: string; note: string }
export interface QuoteTable { rows: QuoteTableRow[]; hasHrDay: boolean; subTotal?: string; vat?: string; total?: string }

/** 견적 품목 표 — 머리글(단가·금액) 다음 줄부터 합계 줄 전까지. 줄바꿈으로 잘린 비고는 앞 행에 이어 붙인다. */
export function parseQuoteTable(text: string): QuoteTable | null {
  const lines = String(text ?? "").split(/\r?\n/).map(l => l.replace(/\t+/g, " ").replace(/[ ]{2,}/g, " ").trim());
  const head = lines.findIndex(l => /(?:unit\s*price|단가)/i.test(l) && /(?:amount|금액|공급가액)/i.test(l));
  if (head < 0) return null;
  const hasHrDay = /hr\s*\/\s*day|일수|기간/i.test(lines[head]);
  const rows: QuoteTableRow[] = [];
  const out: QuoteTable = { rows, hasHrDay };
  const num = (v?: string) => (v ?? "").replace(/,/g, "").replace(/\.0+$/, "");
  for (const l of lines.slice(head + 1)) {
    if (!l) continue;
    const tot = l.match(/^(sub\s*total|vat(?:\s*\(\s*\d+\s*%\s*\))?|total|공급가액\s*합계|부가세|합계|총액)\s*[:：]?\s*[￦₩]?\s*([\d,]+)/i);
    if (tot) {
      const k = tot[1].toLowerCase();
      if (/sub|공급가액/.test(k)) out.subTotal = tot[2]; else if (/vat|부가세/.test(k)) out.vat = tot[2]; else out.total = tot[2];
      if (/^total|합계|총액/.test(k)) break;
      continue;
    }
    const m = l.match(/^(.+?)\s+(?:(\d[\d,.]*)\s+)?(\d[\d,.]*)\s+[￦₩]?\s*([\d,]+)\s*원?\s+[￦₩]?\s*([\d,]+)\s*원?(?:\s+(.*))?$/);
    if (m) { rows.push({ name: m[1].trim(), hrDay: num(m[2]), qty: num(m[3]), unitPrice: m[4], amount: m[5], note: (m[6] ?? "").trim() }); continue; }
    const last = rows[rows.length - 1];
    if (last) last.note = last.note && /[가-힣]$/.test(last.note) && /^[가-힣)]/.test(l) ? last.note + l : [last.note, l].filter(Boolean).join(" ");
  }
  return rows.length ? out : null;
}

/** 시작~종료일 사이 일수(양끝 포함). 날짜가 없으면 null */
export function eventDays(from?: string, to?: string): number | null {
  const a = from?.slice(0, 10), b = (to || from)?.slice(0, 10);
  if (!a || !b || !/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
  const d = Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;
  return d >= 1 && d <= 60 ? d : null;
}
