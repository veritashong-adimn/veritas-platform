// 고객용 문서(견적서·거래명세서) 출력 문구 — 내부 관리 문구와 고객용 비고 분리
//
//   · 과거 CRM 판매 전환(legacySaleActivation)은 예전에 이관 경위를 견적 비고(quotes.note)·상품 비고(quote_items.memo)에
//     고정 문구로 기록했다. 이 정보는 이관 이력(legacy_master_mappings·import_row_sources)과 원본(legacy_archive_rows)에
//     이미 보존되어 있으므로, 이제 전환 시에는 이관 이력에만 기록하고 고객용 필드에는 쓰지 않는다.
//   · 이미 전환된 건의 저장값은 수정하지 않는다(원본 보존·사용자 수정 비고 덮어쓰기 금지). 대신 고객용 출력값을 따로 만든다:
//     이관 이력으로 '전환 건'임이 확인된 견적에서만, 시스템이 만든 문구와 정확히 같은 줄·구간만 뺀다.
//     직원이 고쳐 쓴 문장이나 함께 적은 고객 안내는 그대로 남는다.
import { sql } from "drizzle-orm";
import { ACTIVATION_MODULE } from "./legacyActivationLineage";

/** 전환 시 예전에 견적 비고에 기록하던 문구(내부 이관 경위) */
export const legacyActivationNote = (saleNo: string) => `과거 CRM 판매 전환 (판매번호 ${saleNo})`;
/** 전환 시 예전에 상품 비고에 기록하던 문구(원본 데이터 특성) */
export const LEGACY_ACTIVATION_ITEM_MEMO = "과거 CRM 원본 상품명·총액 그대로(원본에 공급가·부가세 구분 없음)";

export interface LegacyOrigin {
  source: "old_crm";
  saleNo: string;
  /** 과거 판매목록은 총액만 있어 공급가·부가세 구분이 확인되지 않은 금액이다 — 임의 분리·역산 금지 */
  taxBreakdown: "unknown";
}

type Dbx = { execute: (q: any) => Promise<{ rows: unknown[] }> };

/** 견적의 판매(프로젝트)가 과거 CRM 판매 전환으로 만들어졌는지 — 이관 이력(활성 매핑 + 전환 계보)으로만 판정 */
export async function legacyOriginOfProject(dbx: Dbx, projectId: number | null | undefined): Promise<LegacyOrigin | null> {
  if (!projectId) return null;
  const r = (await dbx.execute(sql`SELECT m.legacy_id FROM legacy_master_mappings m
    WHERE m.source_system = 'old_crm' AND m.entity_type = 'sale' AND m.status = 'active' AND m.entity_id = ${projectId}
      AND EXISTS (SELECT 1 FROM import_row_sources s WHERE s.module = ${ACTIVATION_MODULE} AND s.entity_id = ${projectId} AND s.row_key = 'sale:' || m.legacy_id)
    LIMIT 1`)).rows as Array<{ legacy_id: string }>;
  return r.length ? { source: "old_crm", saleNo: r[0].legacy_id, taxBreakdown: "unknown" } : null;
}

// 시스템 문구와 정확히 같은 줄 / ' / ' 구간만 제거(앞뒤 공백 무시). 나머지 문장은 순서·줄바꿈 그대로 둔다.
function removeExact(text: string | null | undefined, generated: string): string | null {
  if (text == null) return null;
  const lines = text.split("\n").flatMap(line => {
    if (line.trim() === generated) return [];
    if (!line.includes(" / ")) return [line];
    const kept = line.split(" / ").filter(seg => seg.trim() !== generated);
    return kept.length ? [kept.join(" / ")] : [];
  });
  const out = lines.join("\n").trim();
  return out ? out : null;
}

/** 고객용 견적 비고 */
export function customerNoteOf(note: string | null | undefined, origin: LegacyOrigin | null): string | null {
  return origin ? removeExact(note, legacyActivationNote(origin.saleNo)) : (note ?? null);
}

/** 고객용 상품 비고(원본 memo 형식 유지 — 화면의 비고 해석 규칙은 그대로 적용된다) */
export function customerMemoOf(memo: string | null | undefined, origin: LegacyOrigin | null): string | null {
  return origin ? removeExact(memo, LEGACY_ACTIVATION_ITEM_MEMO) : (memo ?? null);
}
