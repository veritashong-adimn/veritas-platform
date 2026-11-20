// ─── 명부 제외(soft delete·excluded) 통번역사 — 신규 등록 이메일 충돌 안내 · 기존 기록 복원 ─────────────
//
// 배경(2026-11 중앙대 김주희 건):
//   2026-10-20 '통번역사 기존 중복 Master 정리'(delete-execute)가 **이름만 같은** 신규 명부 Master 가 있으면
//   기존 CRM 이관 Master 를 soft-delete(deleted_at) + 운영상태 excluded 로 비활성화했다. 동명이인(다른 인물)도 함께 제외돼
//   목록·검색에서 사라지고, 그 사람의 이메일은 삭제된 계정에 남아 신규 등록 시 '이미 등록된 이메일' 오류가 난다.
//
// 확정 이관 규칙: 공식 식별정보(주민번호) 또는 수행이력(CRM 진행관리·플랫폼 수행/지급)이 있으면 명부에 포함,
//   둘 다 없을 때만 제외. → 규칙상 포함 대상인 제외 기록은 '복원'으로 되살린다(신규 계정 중복 생성·이메일 이동 금지).
//
// 원칙
//   · 동명 활성 Master 와 병합하지 않는다(다른 인물일 수 있음). 복원은 그 제외 기록 1건만 되살린다.
//   · 다른 활성 계정이 이미 같은 이메일을 쓰면 복원하지 않는다(이메일·계정 이동 금지).
//   · 수행·지급·정산·CRM 연결 데이터는 건드리지 않는다(기존 id 그대로 복원되므로 연결이 그대로 살아난다).
//   · 응답·감사로그에 주민번호·계좌 등 민감정보를 넣지 않는다(보유 여부 boolean 만).
import { sql } from "drizzle-orm";

type Dbx = any;
const rows = async (dbx: Dbx, q: any) => (await dbx.execute(q)).rows as any[];

export type ExcludedTranslatorInfo = {
  translatorId: number;
  name: string | null;
  languagePairs: string | null;
  excludedNote: string | null;
  hasOfficialId: boolean;          // 주민번호 보유(값은 반환하지 않음)
  crmHistoryCount: number;         // CRM 진행관리 원본 수행행(이관 매핑 이름 기준)
  platformHistoryCount: number;    // 플랫폼 수행정보·지급회차 항목
  eligible: boolean;               // 확정 이관 규칙상 명부 포함 대상(식별정보 또는 수행이력)
  emailInUseByOther: boolean;      // 같은 이메일을 쓰는 다른 활성 계정 존재 → 복원 불가
};

/** 이메일이 '명부 제외(삭제) 통번역사' 계정의 것이면 그 정보를, 아니면 null */
export async function findExcludedTranslatorByEmail(dbx: Dbx, normEmail: string): Promise<ExcludedTranslatorInfo | null> {
  const [u] = await rows(dbx, sql`SELECT u.id FROM users u WHERE lower(u.email) = ${normEmail} AND u.role = 'translator' AND u.deleted_at IS NOT NULL ORDER BY u.id LIMIT 1`);
  return u ? describeExcludedTranslator(dbx, Number(u.id)) : null;
}

export async function describeExcludedTranslator(dbx: Dbx, id: number): Promise<ExcludedTranslatorInfo | null> {
  const [r] = await rows(dbx, sql`
    SELECT u.id, u.name, lower(u.email) AS email, p.language_pairs, p.operational_note,
      (s.resident_number IS NOT NULL AND s.resident_number <> '') AS has_rrn,
      (SELECT count(*)::int FROM legacy_archive_rows r WHERE r.is_effective AND r.source_type = 'progress'
         AND btrim(r.source_raw->>'통번역사명') IN (SELECT btrim(m.legacy_id) FROM legacy_master_mappings m
           WHERE m.entity_type = 'translator' AND m.entity_id = u.id AND m.status <> 'rolled_back')
         -- 행 단위로 다른 통번역사에 연결된 행(동명이인)은 제외
         AND NOT EXISTS (SELECT 1 FROM legacy_master_mappings rl WHERE rl.source_system = 'old_crm' AND rl.entity_type = 'translator_row'
           AND rl.status <> 'rolled_back' AND rl.legacy_id = 'progress:' || r.id AND rl.entity_id <> u.id)) AS crm_rows,
      ((SELECT count(*) FROM performance_assignments pa WHERE pa.individual_user_id = u.id)
       + (SELECT count(*) FROM payout_round_items pri WHERE pri.payee_type = 'individual' AND pri.payee_id = u.id))::int AS platform_rows,
      EXISTS (SELECT 1 FROM users o WHERE o.id <> u.id AND o.deleted_at IS NULL AND lower(o.email) = lower(u.email)) AS email_taken
    FROM users u
    LEFT JOIN translator_profiles p ON p.user_id = u.id
    LEFT JOIN translator_sensitive s ON s.translator_id = u.id
    WHERE u.id = ${id} AND u.role = 'translator' AND u.deleted_at IS NOT NULL`);
  if (!r) return null;
  const hasOfficialId = r.has_rrn === true;
  const crm = Number(r.crm_rows ?? 0), plat = Number(r.platform_rows ?? 0);
  return {
    translatorId: Number(r.id), name: r.name ?? null, languagePairs: r.language_pairs ?? null, excludedNote: r.operational_note ?? null,
    hasOfficialId, crmHistoryCount: crm, platformHistoryCount: plat,
    eligible: hasOfficialId || crm > 0 || plat > 0,
    emailInUseByOther: r.email_taken === true,
  };
}

export class RestoreError extends Error { constructor(public status: number, msg: string, public code: string) { super(msg); } }

/**
 * 명부 제외 통번역사 기록 복원(트랜잭션 안에서 호출).
 *  · 삭제 해제(deleted_at=null) + 운영상태 legacy_migrated(과거 CRM 이관 인원과 동일·비활성) — 배정 저장 시 기존 자동 활성화 규칙 적용.
 *  · 동명 Master·이메일·수행/지급 데이터는 변경하지 않는다.
 */
export async function restoreExcludedTranslator(tx: Dbx, id: number, ctx: { userId: number | null; userEmail: string | null; reason: string | null }) {
  const info = await describeExcludedTranslator(tx, id);
  if (!info) throw new RestoreError(404, "복원할 제외 통번역사 기록을 찾을 수 없습니다.", "NOT_FOUND");
  if (!info.eligible) throw new RestoreError(409, "공식 식별정보와 수행이력이 모두 없어 명부 제외 대상입니다. 신규 등록은 다른 이메일로 진행하거나 관리자 확인이 필요합니다.", "NOT_ELIGIBLE");
  if (info.emailInUseByOther) throw new RestoreError(409, "이 이메일은 다른 활성 계정이 사용 중이라 복원할 수 없습니다(이메일·계정 이동 금지).", "EMAIL_IN_USE");
  const [before] = await rows(tx, sql`SELECT u.is_active, p.operational_status FROM users u LEFT JOIN translator_profiles p ON p.user_id = u.id WHERE u.id = ${id}`);
  const upd = await rows(tx, sql`UPDATE users SET deleted_at = NULL, deleted_by = NULL, deletion_reason = NULL, is_active = false
    WHERE id = ${id} AND role = 'translator' AND deleted_at IS NOT NULL RETURNING id, name, email`);
  if (!upd.length) throw new RestoreError(409, "이미 복원되었거나 상태가 변경되었습니다. 새로고침 후 확인하세요.", "CONFLICT");
  const note = `명부 복원(${new Date().toISOString().slice(0, 10)}): 확정 이관 규칙(식별정보·수행이력) 충족 — 동명 Master 와 별도 인물로 유지`;
  await tx.execute(sql`UPDATE translator_profiles SET operational_status = 'legacy_migrated', operational_note = ${note}, updated_at = now() WHERE user_id = ${id}`);
  await tx.execute(sql`INSERT INTO logs (entity_type, entity_id, action, performed_by, performed_by_email, metadata)
    VALUES ('translator', ${id}, 'restored', ${ctx.userId}, ${ctx.userEmail}, ${JSON.stringify({
      trigger: "excluded_translator_restore",
      reason: ctx.reason,
      before: { deleted: true, isActive: before?.is_active ?? null, operationalStatus: before?.operational_status ?? null },
      after: { deleted: false, isActive: false, operationalStatus: "legacy_migrated" },
      basis: { hasOfficialId: info.hasOfficialId, crmHistoryCount: info.crmHistoryCount, platformHistoryCount: info.platformHistoryCount },
    })})`);
  return { id: Number(upd[0].id), name: upd[0].name, email: upd[0].email, restored: true as const, basis: info };
}
