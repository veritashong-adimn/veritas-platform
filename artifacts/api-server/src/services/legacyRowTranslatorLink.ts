// ─── 과거 CRM 수행행(progress) ↔ 통번역사 '행 단위' 연결 — 동명이인 수행이력 분리 ─────────────────────
//
// 배경(2026-11 김주희 건): 과거 CRM 수행이력은 인물 단위 매핑(legacy_master_mappings, entity_type='translator',
//   legacy_id = CRM 통번역사명)으로 Master 에 붙는다. 같은 CRM 이름을 쓰는 동명이인(중앙대 영어 김주희 / 독일어 김주희)의
//   수행행이 한 Master 에 모두 붙고, 특정 행만 다른 인물로 옮길 방법이 없었다.
//
// 행 단위 연결(이 모듈) — 스키마 변경 없이 기존 매핑 테이블을 사용:
//   source_system='old_crm', entity_type='translator_row', legacy_id='progress:<legacy_archive_rows.id>', entity_id=통번역사 id
//   · 유니크키(source_system, entity_type, legacy_id)로 행당 1건. 행 연결이 있으면 이름 매핑보다 우선한다.
//   · 원본 수행행(legacy_archive_rows)·지급·정산·판매 연결은 수정/삭제하지 않는다(조회 귀속만 바뀜).
//   · 자동 생성 금지 — 담당자가 근거(사유)를 남기고 명시적으로 지정할 때만. 감사로그(logs) 기록.
import { sql } from "drizzle-orm";

type Dbx = any;
const rows = async (dbx: Dbx, q: any) => (await dbx.execute(q)).rows as any[];
export const ROW_LINK_ENTITY = "translator_row";
export const rowLinkKey = (progressRowId: number) => `progress:${progressRowId}`;

/** 행 연결 SQL 조각 — legacy_archive_rows 별칭(alias)의 행에 대해 행 단위 연결된 통번역사 id(없으면 NULL) */
export const rowLinkedTranslatorSql = (alias: string) => sql.raw(`(SELECT rl.entity_id FROM legacy_master_mappings rl
  WHERE rl.source_system = 'old_crm' AND rl.entity_type = '${ROW_LINK_ENTITY}' AND rl.status <> 'rolled_back'
    AND rl.legacy_id = 'progress:' || ${alias}.id LIMIT 1)`);

/** 행 단위 연결 맵(progressRowId → 통번역사 id) */
export async function loadRowLinks(dbx: Dbx, progressRowIds: number[]): Promise<Map<number, number>> {
  if (!progressRowIds.length) return new Map();
  const keys = progressRowIds.map(rowLinkKey);
  const r = await rows(dbx, sql`SELECT legacy_id, entity_id FROM legacy_master_mappings
    WHERE source_system = 'old_crm' AND entity_type = ${ROW_LINK_ENTITY} AND status <> 'rolled_back'
      AND legacy_id IN (${sql.join(keys.map(k => sql`${k}`), sql`, `)})`);
  return new Map(r.map(x => [Number(String(x.legacy_id).slice(9)), Number(x.entity_id)]));
}

export class RowLinkError extends Error { constructor(public status: number, msg: string, public code: string) { super(msg); } }

/**
 * 과거 CRM 수행행 1건을 지정 통번역사에 행 단위로 연결(재연결). 트랜잭션 안에서 호출.
 *  · 대상: 유효한 progress 행 + 삭제되지 않은 통번역사. 사유 필수.
 *  · 이미 운영 수행정보로 전환된 행(import_row_sources progress:<id>)은 운영 수행정보의 수행자로 관리하므로 거부.
 */
export async function linkProgressRowToTranslator(tx: Dbx, progressRowId: number, translatorId: number, ctx: { userId: number | null; userEmail: string | null; reason: string }) {
  if (!ctx.reason?.trim()) throw new RowLinkError(400, "재연결 사유를 입력해 주세요(근거 기록 필수).", "REASON_REQUIRED");
  const [row] = await rows(tx, sql`SELECT id, btrim(source_raw->>'통번역사명') AS nm FROM legacy_archive_rows WHERE id = ${progressRowId} AND source_type = 'progress' AND is_effective`);
  if (!row) throw new RowLinkError(404, "과거 CRM 수행행을 찾을 수 없습니다(유효 행만 가능).", "ROW_NOT_FOUND");
  const [t] = await rows(tx, sql`SELECT id FROM users WHERE id = ${translatorId} AND role IN ('translator','linguist') AND deleted_at IS NULL`);
  if (!t) throw new RowLinkError(404, "연결할 통번역사를 찾을 수 없습니다(삭제되지 않은 통번역사만).", "TRANSLATOR_NOT_FOUND");
  const [converted] = await rows(tx, sql`SELECT 1 FROM import_row_sources WHERE row_key = ${rowLinkKey(progressRowId)} LIMIT 1`);
  if (converted) throw new RowLinkError(409, "운영 수행정보로 전환된 행입니다. 판매관리 수행정보에서 수행자를 변경하세요.", "ALREADY_CONVERTED");
  // 이전 귀속(행 연결 > 이름 매핑) — 감사로그용
  const [prevLink] = await rows(tx, sql`SELECT entity_id FROM legacy_master_mappings WHERE source_system='old_crm' AND entity_type=${ROW_LINK_ENTITY} AND legacy_id=${rowLinkKey(progressRowId)} AND status <> 'rolled_back'`);
  const [prevName] = await rows(tx, sql`SELECT entity_id FROM legacy_master_mappings WHERE source_system='old_crm' AND entity_type='translator' AND status <> 'rolled_back' AND btrim(legacy_id) = ${row.nm ?? ''} LIMIT 1`);
  const before = prevLink ? Number(prevLink.entity_id) : (prevName ? Number(prevName.entity_id) : null);
  if (before === translatorId) return { progressRowId, translatorId, before, changed: false };
  await tx.execute(sql`INSERT INTO legacy_master_mappings (source_system, entity_type, legacy_id, entity_id, match_method, status, created_by, created_at)
    VALUES ('old_crm', ${ROW_LINK_ENTITY}, ${rowLinkKey(progressRowId)}, ${translatorId}, 'manual', 'confirmed', ${ctx.userId}, now())
    ON CONFLICT (source_system, entity_type, legacy_id) DO UPDATE SET entity_id = EXCLUDED.entity_id, status = 'confirmed', match_method = 'manual', created_by = EXCLUDED.created_by, created_at = now()`);
  await tx.execute(sql`INSERT INTO logs (entity_type, entity_id, action, performed_by, performed_by_email, metadata)
    VALUES ('translator', ${translatorId}, 'legacy_row_relinked', ${ctx.userId}, ${ctx.userEmail}, ${JSON.stringify({
      progressRowId, fromTranslatorId: before, toTranslatorId: translatorId, reason: ctx.reason.trim(),
      note: "과거 CRM 수행행 행 단위 재연결(원본·지급·판매 연결 불변)",
    })})`);
  return { progressRowId, translatorId, before, changed: true };
}
