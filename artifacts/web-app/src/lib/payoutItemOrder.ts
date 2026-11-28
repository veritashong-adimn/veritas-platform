// ─────────────────────────────────────────────────────────────────────────────
// 금액자료 공통 정렬 원칙(2026-11-28) — 건별 금액자료의 검수용 표시·출력 순서.
//   1순위 납품일 오름차순(납품일 없음 = 맨 뒤)
//   2순위 같은 납품일 안 거래처명 가나다순
//   3순위 같은 거래처 안 판매번호순
//   4순위 같은 판매번호 안 수행자(통번역사·외주업체)명 가나다순
//   5순위 같은 수행자 안 수행정보 등록순(과거 CRM 원본 → 플랫폼 수행정보, 각 등록 id 순)
//  · 같은 거래처·판매건·수행자의 내역이 흩어지지 않도록 각 단계에서 이름이 같아도 식별값으로 묶는다
//    (예: 판매번호 없는 건은 판매 id, 동명이인은 수행자 키로 구분 — 서로 섞이지 않음).
//  · 과거 CRM + 플랫폼을 합친 뒤 최종 정렬한다. 화면·Excel·PDF 는 이 함수로 정렬된 같은 배열을 사용한다.
//  · 정렬 전용 — 건수·금액·지급상태 등 값은 바꾸지 않는다(새 배열 반환, 원본 불변).
//  · 거래처·수행자명 가나다 비교 시 법인 형태 표기((주)·㈜·주식회사 등)와 공백은 무시한다
//    ('주식회사 가나다' → 'ㄱ'). 표기만 다른 두 이름은 인접하되 서로 다른 묶음으로 유지된다.
// ─────────────────────────────────────────────────────────────────────────────

export type PayoutOrderKey = {
  deliveryDate: string | null | undefined;   // 'YYYY-MM-DD'
  client: string | null | undefined;
  saleNo: string | null | undefined;          // 판매번호(표시값)
  saleId?: number | string | null;            // 판매 식별값(판매번호 없음·같은 번호 구분용)
  performer: string | null | undefined;       // 통번역사·외주업체명
  performerKey?: string | number | null;      // 수행자 식별값(동명이인 구분용)
  sourceRank?: number;                        // 0 = 과거 CRM 원본, 1 = 플랫폼 수행정보
  regId: number | string | null | undefined;  // 등록 순번(id)
};

const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
const CORP_MARKS = /\(\s*(주|유|사|재|합)\s*\)|㈜|주식회사|유한회사|유한책임회사|사단법인|재단법인|합자회사|합명회사|\s+/g;

/** 가나다 비교용 이름 키 — 법인 형태 표기·공백 제거. 남는 글자가 없으면 원래 이름. */
export function nameSortKey(name: string | null | undefined): string {
  const raw = String(name ?? '').trim();
  const k = raw.replace(CORP_MARKS, '');
  return k || raw;
}

const blank = (v: unknown) => v == null || String(v).trim() === '';
/** 빈 값은 항상 뒤로. */
function cmpText(a: unknown, b: unknown): number {
  const ea = blank(a), eb = blank(b);
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  return collator.compare(String(a).trim(), String(b).trim());
}
function cmpName(a: string | null | undefined, b: string | null | undefined): number {
  const ea = blank(a), eb = blank(b);
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  return collator.compare(nameSortKey(a), nameSortKey(b)) || String(a).trim().localeCompare(String(b).trim(), 'ko');
}
function cmpDate(a: string | null | undefined, b: string | null | undefined): number {
  const da = blank(a) ? '' : String(a).slice(0, 10), db = blank(b) ? '' : String(b).slice(0, 10);
  if (!da || !db) return da === db ? 0 : !da ? 1 : -1;
  return da < db ? -1 : da > db ? 1 : 0;
}

export function comparePayoutOrder(a: PayoutOrderKey, b: PayoutOrderKey): number {
  return cmpDate(a.deliveryDate, b.deliveryDate)
    || cmpName(a.client, b.client)
    || cmpText(a.saleNo, b.saleNo) || cmpText(a.saleId, b.saleId)
    || cmpName(a.performer, b.performer) || cmpText(a.performerKey, b.performerKey)
    || ((a.sourceRank ?? 0) - (b.sourceRank ?? 0))
    || cmpText(a.regId, b.regId);
}

/** 공통 원칙으로 정렬한 새 배열(원본 불변). keyOf 로 각 화면 자료의 필드를 정렬 키에 맞춘다. */
export function sortByPayoutOrder<T>(rows: readonly T[], keyOf: (r: T) => PayoutOrderKey): T[] {
  return rows.map((r, i) => ({ r, k: keyOf(r), i }))
    .sort((x, y) => comparePayoutOrder(x.k, y.k) || x.i - y.i)
    .map(x => x.r);
}

// ── 지급회차 상세(통합 조회: 과거 CRM + 플랫폼) 건별 자료용 키 ──
export function unifiedPayoutOrderKey(r: {
  deliveryDate?: string | null; client?: string | null; saleNo?: string | null; projectId?: number | null;
  translator?: string | null; masterKey?: string | null; source?: string; id: number;
}): PayoutOrderKey {
  return { deliveryDate: r.deliveryDate, client: r.client, saleNo: r.saleNo, saleId: r.projectId ?? null,
    performer: r.translator, performerKey: r.masterKey ?? null, sourceRank: r.source === 'legacy' ? 0 : 1, regId: r.id };
}
