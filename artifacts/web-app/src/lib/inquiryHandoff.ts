/**
 * inquiryHandoff — 의뢰건 → 견적서 작성 화면으로 정보 전달(1회성 sessionStorage).
 *
 * 의뢰건 상세 [견적서 작성] 클릭 시 회사/담당자/제목/메모 + 서비스별 견적항목(items)을 저장하고
 * 견적 등록 화면으로 이동. QuoteEditorWorkspace 가 신규 견적 진입 시 이 값을 읽어 프리필하고,
 * 저장 성공 후 quoteId 를 의뢰건에 역연결(link-quote)한 뒤 값을 소비/삭제한다.
 * 기존 견적 로직/응답 형태는 변경하지 않는다.
 */

/**
 * QuoteEditorWorkspace 의 QuoteItemForm 부분집합(구조적 타입). 신규 견적 항목 시드용.
 * QuoteEditorWorkspace 에서 { ...defaultItem(), ...item } 으로 병합되므로 필요한 필드만 채운다.
 */
export interface QuoteHandoffItem {
  productType: "translation" | "interpretation" | "equipment" | "expense";
  productName?: string;
  quantity?: string;
  unit?: string;
  memo?: string;
  // 통역 전용
  interpretDate?: string;      // 행사 시작일 (YYYY-MM-DD)
  interpretEndDate?: string;   // 행사 종료일
  interpretHours?: string;
  interpretPlace?: string;
  // 번역 전용
  sourceLanguage?: string;
  fileFormat?: string;
  // 장비 전용
  eventStartDate?: string;     // 사용 시작일 (YYYY-MM-DD)
  eventEndDate?: string;       // 사용 종료일
  itemLocation?: string;
}

export interface QuotePrefillHandoff {
  inquiryId: number;
  inquiryNumber?: string | null;
  companyId?: number | null;
  contactId?: number | null;
  divisionId?: number | null;
  title?: string;
  note?: string;
  items?: QuoteHandoffItem[];
}

const KEY = "veritasQuotePrefill";

export function setQuoteHandoff(h: QuotePrefillHandoff): void {
  try { sessionStorage.setItem(KEY, JSON.stringify(h)); } catch { /* 세션 사용 불가 시 무시 */ }
}

export function readQuoteHandoff(): QuotePrefillHandoff | null {
  try {
    const s = sessionStorage.getItem(KEY);
    return s ? (JSON.parse(s) as QuotePrefillHandoff) : null;
  } catch { return null; }
}

export function clearQuoteHandoff(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* 무시 */ }
}

/** ISO/datetime 문자열 → 'YYYY-MM-DD' (견적 항목 날짜 필드용). 빈 값은 undefined. */
function toDateStr(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (isNaN(d.getTime())) return undefined;
  // KST 기준 날짜
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/** equipmentJson 문자열 파싱 → 장비행 배열(안전) */
export function parseEquipmentJson(s: string | null | undefined): Array<{ kind?: string; quantity?: string; unit?: string; location?: string; note?: string }> {
  if (!s) return [];
  try { const arr = JSON.parse(s); return Array.isArray(arr) ? arr : []; } catch { return []; }
}

/**
 * 의뢰건 상세 데이터 → 견적 항목(QuoteHandoffItem[]) 변환.
 *  · 통역: 통역행 1개 (+「통역장비 필요」 시 장비행들)
 *  · 번역: 번역행 1개
 *  · 장비 단독: 장비행들
 *  · 기타: 항목 없음(고객정보/메모만 전달)
 */
export function buildHandoffItems(d: {
  serviceType: string | null;
  languageFrom: string | null; languageTo: string | null;
  interpretType: string | null; interpretDuration: string | null;
  scheduleFrom: string | null; scheduleTo: string | null; place: string | null;
  documentType: string | null; volume: string | null; subject: string | null;
  equipmentJson: string | null;
}): QuoteHandoffItem[] {
  const items: QuoteHandoffItem[] = [];
  const eqRows = parseEquipmentJson(d.equipmentJson);
  const eqItems = (): QuoteHandoffItem[] => eqRows
    .filter(r => (r.kind && r.kind.trim()) || (r.quantity && r.quantity.trim()))
    .map(r => ({
      productType: "equipment" as const,
      productName: r.kind || "통역장비",
      quantity: r.quantity || "1",
      unit: r.unit || "세트",
      eventStartDate: toDateStr(d.scheduleFrom),
      eventEndDate: toDateStr(d.scheduleTo),
      itemLocation: r.location || d.place || undefined,
      memo: r.note || undefined,
    }));

  if (d.serviceType === "interpretation") {
    items.push({
      productType: "interpretation",
      productName: d.interpretType || "통역",
      interpretDate: toDateStr(d.scheduleFrom),
      interpretEndDate: toDateStr(d.scheduleTo),
      interpretPlace: d.place || undefined,
      memo: [d.interpretDuration ? `1일 통역시간: ${d.interpretDuration}` : "", d.subject || ""].filter(Boolean).join(" / ") || undefined,
    });
    items.push(...eqItems());
  } else if (d.serviceType === "translation") {
    items.push({
      productType: "translation",
      productName: d.subject || "번역",
      sourceLanguage: (d.languageFrom || undefined) as string | undefined,
      fileFormat: d.documentType || undefined,
      memo: d.volume ? `분량: ${d.volume}` : undefined,
    });
  } else if (d.serviceType === "equipment") {
    items.push(...eqItems());
  }
  return items;
}
