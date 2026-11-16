// ─── 판매건 식별정보(판매번호 · 프로젝트명) — 판매관리 목록 · 판매 Excel 공용 (READ-ONLY) ──────────
// 저장 구조(스키마 변경 없음, 새 번호 생성 없음):
//   · 신규 판매  : 판매번호 = 대표 유효 견적의 견적번호를 플랫폼 표시형(Q+견적일 YYMMDD-일련번호)으로 표기.
//                  견적번호(quote_number)는 DB unique → 판매번호도 판매건마다 고유. 변경견적 접미사(-R2 등)는 보존.
//                  프로젝트명 = projects.title(판매명, 판매 상세 '견적서명 / 판매명').
//   · 과거 CRM 전환 판매 : 판매번호 = 원본 판매번호(legacy_master_mappings 'sale' 의 legacy_id, 판매 ID 로 연결).
//                  프로젝트명 = projects.title. 단 원본 '영업기회명'이 없어 전환 시 상품명으로 채워진 제목이면
//                  실제 프로젝트명이 아니므로 대체값(projectNameFallback=true)으로 구분한다.
//   · 과거 CRM 원본(미전환) : salesHistory 의 legacy 조회에서 원본 '판매번호' · '영업기회명' 을 그대로 사용.
// 대표 견적 = 유효본(is_current)·미삭제 중 원견적(relation_type 없음) 우선 → 가장 작은 id (판매 1건당 1개, 행 중복 없음).
import { sql } from "drizzle-orm";

export interface SaleIdentity {
  projectId: number;
  quoteId: number | null;
  quoteNumber: string | null;      // 원 견적번호(저장값 그대로)
  issueDate: string | null;        // 견적일(= 운영 판매일, date 컬럼 문자열)
  saleNumber: string | null;       // 화면·Excel 공통 판매번호
  legacySaleNumber: string | null; // 과거 CRM 전환 판매의 원본 판매번호
  projectName: string | null;
  projectNameFallback: boolean;    // true = 실제 프로젝트명이 아닌 대체 표시값(상품명)
}

// 견적번호 → 플랫폼 표시형(Q261111-007). 판매 상세 '견적번호'(formatDocNumber)와 같은 규칙이되,
//  변경견적 접미사(-R2)는 숫자에 섞지 않고 그대로 붙여 다른 견적번호와 겹치지 않게 한다. 해석 불가 시 저장값 그대로.
export function formatSaleQuoteNumber(quoteNumber: string | null | undefined, issueDate: string | null | undefined): string | null {
  if (!quoteNumber) return null;
  const m = String(quoteNumber).match(/^([A-Za-z]*)(\d+)((?:-[A-Za-z]*\d+)*)$/);
  const ymd = String(issueDate ?? "").replace(/\D/g, "").slice(2, 8);
  if (!m || ymd.length < 6) return String(quoteNumber);
  return `${m[1] || "Q"}${ymd}-${String(Number(m[2])).padStart(3, "0")}${m[3] ?? ""}`;
}

export async function loadSaleIdentities(dbx: any, projectIds: number[]): Promise<Map<number, SaleIdentity>> {
  const out = new Map<number, SaleIdentity>();
  const ids = [...new Set(projectIds.filter((v) => Number.isFinite(v)))];
  if (!ids.length) return out;
  const rows = (await dbx.execute(sql`
    SELECT p.id AS project_id, p.title, q.id AS quote_id, q.quote_number, q.issue_date::text AS issue_date,
      m.legacy_id, la.opportunity, la.raw_product
    FROM projects p
    LEFT JOIN LATERAL (
      SELECT q1.id, q1.quote_number, q1.issue_date FROM quotes q1
      WHERE q1.project_id = p.id AND q1.is_current = true AND q1.deleted_at IS NULL
      ORDER BY (q1.relation_type IS NULL) DESC, q1.id ASC LIMIT 1
    ) q ON true
    LEFT JOIN LATERAL (
      SELECT btrim(m1.legacy_id) AS legacy_id FROM legacy_master_mappings m1
      WHERE m1.source_system = 'old_crm' AND m1.entity_type = 'sale' AND m1.status = 'active' AND m1.entity_id = p.id
      ORDER BY m1.id DESC LIMIT 1
    ) m ON true
    LEFT JOIN LATERAL (
      SELECT nullif(btrim(l.source_raw ->> '영업기회명'), '') AS opportunity, nullif(btrim(l.source_raw ->> '상품명'), '') AS raw_product
      FROM legacy_archive_rows l
      WHERE m.legacy_id IS NOT NULL AND l.source_type = 'sales_list' AND l.is_effective AND l.source_raw ->> '판매번호' = m.legacy_id
      ORDER BY l.id DESC LIMIT 1
    ) la ON true
    WHERE p.id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)).rows as any[];
  for (const r of rows) {
    const title = (r.title ?? "").trim() || null;
    const legacy = r.legacy_id ? String(r.legacy_id) : null;
    // 과거 CRM 전환: 영업기회명이 없고 제목이 원본 상품명과 같으면(전환 시 자동 채움) 실제 프로젝트명 아님 → 대체값
    const fallback = !!legacy && !r.opportunity && !!title && !!r.raw_product && title === String(r.raw_product).trim();
    out.set(Number(r.project_id), {
      projectId: Number(r.project_id),
      quoteId: r.quote_id != null ? Number(r.quote_id) : null,
      quoteNumber: r.quote_number ?? null,
      issueDate: r.issue_date ?? null,
      saleNumber: legacy ?? formatSaleQuoteNumber(r.quote_number, r.issue_date),
      legacySaleNumber: legacy,
      projectName: title,
      projectNameFallback: fallback,
    });
  }
  return out;
}

// 판매번호 검색 — 화면 판매번호·저장 견적번호·원본 판매번호 중 하나라도 포함하면 일치(대소문자 무시).
export function saleIdentityMatches(idn: SaleIdentity | undefined, term: string): boolean {
  if (!idn) return false;
  const t = term.trim().toLowerCase();
  if (!t) return false;
  return [idn.saleNumber, idn.quoteNumber, idn.legacySaleNumber].some((v) => !!v && v.toLowerCase().includes(t));
}
