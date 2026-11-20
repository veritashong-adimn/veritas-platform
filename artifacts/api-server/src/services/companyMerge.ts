// ─── 거래처 중복 통합(source → target) — 미리보기(DB 미변경) · 실행(단일 트랜잭션) ─────────────────────
//
// 배경(2026-11 KDI School 건): 같은 기관이 거래처 2곳(정식명 #124 / 'KDI School' #3754)으로 나뉘어 문의·견적·프로젝트가 분산.
//
// 원칙
//   · 사업자등록번호가 둘 다 있고 다르면 통합하지 않는다(BIZNO_MISMATCH). 한쪽만 있으면 통합 가능(유지 거래처 기준).
//   · 금액·견적·판매·청구·입금·정산 값은 바꾸지 않는다 — 거래처 연결 ID(company_id 계열 컬럼)만 target 으로 옮긴다.
//     견적·문의 등에 저장된 거래처명 스냅샷(당시 표기)은 원본 보존을 위해 그대로 둔다.
//   · 거래처 변경 이력(company_change_history·company_name_history)은 원래 거래처(source)의 기록이므로 옮기지 않는다.
//   · 1:1 테이블(정산정보·외주 프로필·고객 제외·등급 지정)은 양쪽에 모두 있으면 충돌로 중단(어느 값을 쓸지 사람이 결정).
//   · 별칭: source 별칭 중 target 에 없는 것만 옮기고, source 거래처명도 target 별칭으로 등록(두 이름 모두 검색).
//   · source 거래처는 삭제하지 않고 soft delete(deleted_at·deletion_reason) — 목록에는 target 한 곳만 표시.
//   · 감사로그(logs, entity_type=company, action=merged)에 테이블별 이동 행 id 를 남겨 되돌리기 근거로 쓴다.
//   · 대상 컬럼은 information_schema 에서 '거래처 id 정수 컬럼'을 자동 수집 → 새 테이블이 생겨도 누락되지 않는다.
import { sql } from "drizzle-orm";
import { normalizeCompanyName } from "../lib/normalizeCompany";
import { buildAliasValues } from "../lib/companyAlias";
import { companyAliasesTable } from "@workspace/db";

type Dbx = any;
const rows = async (dbx: Dbx, q: any) => (await dbx.execute(q)).rows as any[];
const ident = (s: string) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`invalid identifier ${s}`); return sql.raw(`"${s}"`); };

const KEEP_ON_SOURCE = new Set(["company_change_history.company_id", "company_name_history.company_id"]);
const ALIAS_COL = "company_aliases.company_id";
// 1:1(활성 1건) 테이블 — 양쪽 모두 있으면 충돌. where: 활성 행 조건
const ONE_TO_ONE: Record<string, string> = {
  "company_sensitive.company_id": "true",
  "company_vendor_profiles.company_id": "true",
  "customer_list_exclusions.company_id": "restored_at IS NULL",
  "customer_grade_overrides.company_id": "released_at IS NULL",
};
const LEGACY_ENTITY_TYPES = ["company", "vendor_profile"];

export class CompanyMergeError extends Error { constructor(public status: number, msg: string, public code: string, public detail?: any) { super(msg); } }

async function companyRefColumns(dbx: Dbx): Promise<{ table: string; column: string; key: string }[]> {
  const r = await rows(dbx, sql`SELECT c.table_name t, c.column_name col FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.data_type IN ('integer','bigint') AND c.column_name ~ 'compan' AND c.table_name <> 'companies'
    ORDER BY 1, 2`);
  return r.map(x => ({ table: String(x.t), column: String(x.col), key: `${x.t}.${x.col}` }));
}

export async function previewCompanyMerge(dbx: Dbx, targetId: number, sourceId: number) {
  if (targetId === sourceId) throw new CompanyMergeError(400, "같은 거래처는 통합할 수 없습니다.", "SAME_COMPANY");
  const cs = await rows(dbx, sql`SELECT id, name, business_number, deleted_at FROM companies WHERE id IN (${targetId}, ${sourceId})`);
  const target = cs.find(c => Number(c.id) === targetId), source = cs.find(c => Number(c.id) === sourceId);
  if (!target || !source) throw new CompanyMergeError(404, "거래처를 찾을 수 없습니다.", "NOT_FOUND");
  if (target.deleted_at || source.deleted_at) throw new CompanyMergeError(409, "삭제된 거래처는 통합할 수 없습니다.", "DELETED");
  const bn = (v: unknown) => String(v ?? "").replace(/\D/g, "");
  const conflicts: { code: string; detail: string }[] = [];
  if (bn(target.business_number) && bn(source.business_number) && bn(target.business_number) !== bn(source.business_number))
    conflicts.push({ code: "BIZNO_MISMATCH", detail: "사업자등록번호가 서로 다릅니다 — 통합하지 않습니다." });

  const moves: { key: string; table: string; column: string; sourceRows: number; targetRows: number; action: "move" | "keep_on_source" | "alias" | "one_to_one" }[] = [];
  for (const c of await companyRefColumns(dbx)) {
    const [n] = await rows(dbx, sql`SELECT count(*) FILTER (WHERE ${ident(c.column)} = ${sourceId})::int s, count(*) FILTER (WHERE ${ident(c.column)} = ${targetId})::int t FROM ${ident(c.table)}`);
    if (!n.s && !n.t) continue;
    const action = KEEP_ON_SOURCE.has(c.key) ? "keep_on_source" : c.key === ALIAS_COL ? "alias" : ONE_TO_ONE[c.key] ? "one_to_one" : "move";
    moves.push({ ...c, sourceRows: Number(n.s), targetRows: Number(n.t), action });
    if (action === "one_to_one" && n.s > 0) {
      const [a] = await rows(dbx, sql`SELECT
        (SELECT count(*) FROM ${ident(c.table)} WHERE ${ident(c.column)} = ${sourceId} AND ${sql.raw(ONE_TO_ONE[c.key])})::int s,
        (SELECT count(*) FROM ${ident(c.table)} WHERE ${ident(c.column)} = ${targetId} AND ${sql.raw(ONE_TO_ONE[c.key])})::int t`);
      if (a.s > 0 && a.t > 0) conflicts.push({ code: "ONE_TO_ONE_CONFLICT", detail: `${c.table}: 두 거래처 모두 값이 있어 어느 쪽을 유지할지 결정이 필요합니다.` });
    }
  }
  const legacy = await rows(dbx, sql`SELECT entity_type, count(*)::int n FROM legacy_master_mappings
    WHERE entity_id = ${sourceId} AND entity_type IN (${sql.join(LEGACY_ENTITY_TYPES.map(t => sql`${t}`), sql`, `)}) AND status <> 'rolled_back' GROUP BY 1`);
  // 담당자 중복(같은 이름 + 같은 이메일/휴대폰) — 자동 병합하지 않고 보고만(연락처 유실 방지: 둘 다 target 에 남김)
  const dupContacts = await rows(dbx, sql`SELECT s.id source_contact_id, t.id target_contact_id FROM contacts s JOIN contacts t
    ON t.company_id = ${targetId} AND t.deleted_at IS NULL AND btrim(t.name) = btrim(s.name)
    AND ((s.email IS NOT NULL AND lower(t.email) = lower(s.email))
      OR (nullif(regexp_replace(coalesce(s.mobile,''),'\\D','','g'),'') IS NOT NULL AND regexp_replace(coalesce(t.mobile,''),'\\D','','g') = regexp_replace(coalesce(s.mobile,''),'\\D','','g')))
    WHERE s.company_id = ${sourceId} AND s.deleted_at IS NULL`);
  const sourceNameKey = normalizeCompanyName(source.name ?? "");
  const [aliasHit] = sourceNameKey ? await rows(dbx, sql`SELECT 1 FROM company_aliases WHERE company_id = ${targetId} AND normalized_alias = ${sourceNameKey}`) : [];
  return {
    target: { id: targetId, name: target.name, businessNumber: target.business_number ?? null },
    source: { id: sourceId, name: source.name, businessNumber: source.business_number ?? null },
    moves, legacyMappings: legacy, duplicateContacts: dupContacts,
    sourceNameAliasExists: !!aliasHit, conflicts, canMerge: conflicts.length === 0,
  };
}

export async function executeCompanyMerge(tx: Dbx, targetId: number, sourceId: number, ctx: { userId: number | null; userEmail: string | null; reason: string }) {
  if (!ctx.reason?.trim()) throw new CompanyMergeError(400, "통합 사유를 입력해 주세요.", "REASON_REQUIRED");
  // 동시 변경 방지 — 두 거래처 행 잠금 후 미리보기 재계산
  await tx.execute(sql`SELECT id FROM companies WHERE id IN (${targetId}, ${sourceId}) FOR UPDATE`);
  const plan = await previewCompanyMerge(tx, targetId, sourceId);
  if (!plan.canMerge) throw new CompanyMergeError(409, "통합할 수 없습니다: " + plan.conflicts.map(c => c.detail).join(" / "), "CONFLICT", plan.conflicts);
  const moved: Record<string, number[]> = {};
  for (const m of plan.moves) {
    if (m.sourceRows === 0 || m.action === "keep_on_source") continue;
    if (m.action === "alias") {
      // target 에 없는 별칭만 이동(같은 normalized_alias 는 source 에 남김 — 유니크키 충돌 방지)
      const r = await rows(tx, sql`UPDATE company_aliases a SET company_id = ${targetId}, is_primary = false, updated_at = now()
        WHERE a.company_id = ${sourceId} AND NOT EXISTS (SELECT 1 FROM company_aliases b WHERE b.company_id = ${targetId} AND b.normalized_alias = a.normalized_alias) RETURNING a.id`);
      moved[m.key] = r.map(x => Number(x.id));
      continue;
    }
    const hasId = (await rows(tx, sql`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=${m.table} AND column_name='id'`)).length > 0;
    const r = await rows(tx, sql`UPDATE ${ident(m.table)} SET ${ident(m.column)} = ${targetId} WHERE ${ident(m.column)} = ${sourceId} ${hasId ? sql`RETURNING id` : sql``}`);
    moved[m.key] = hasId ? r.map(x => Number(x.id)) : [];
  }
  const lm = await rows(tx, sql`UPDATE legacy_master_mappings SET entity_id = ${targetId}
    WHERE entity_id = ${sourceId} AND entity_type IN (${sql.join(LEGACY_ENTITY_TYPES.map(t => sql`${t}`), sql`, `)}) AND status <> 'rolled_back' RETURNING id`);
  moved["legacy_master_mappings.entity_id"] = lm.map(x => Number(x.id));
  // source 거래처명을 target 별칭으로(두 이름 모두 검색)
  let aliasAdded = false;
  if (!plan.sourceNameAliasExists && normalizeCompanyName(plan.source.name ?? "")) {
    await tx.insert(companyAliasesTable).values(buildAliasValues(targetId, String(plan.source.name), false));
    aliasAdded = true;
  }
  await tx.execute(sql`UPDATE companies SET deleted_at = now(), deleted_by = ${ctx.userId},
    deletion_reason = ${`거래처 통합: #${sourceId} → #${targetId} (${ctx.reason.trim()})`}, updated_at = now() WHERE id = ${sourceId}`);
  await tx.execute(sql`INSERT INTO logs (entity_type, entity_id, action, performed_by, performed_by_email, metadata)
    VALUES ('company', ${targetId}, 'merged', ${ctx.userId}, ${ctx.userEmail}, ${JSON.stringify({
      sourceCompanyId: sourceId, targetCompanyId: targetId, reason: ctx.reason.trim(), moved, aliasAdded,
      duplicateContacts: plan.duplicateContacts, note: "거래처 연결 ID만 이동 — 금액·스냅샷·변경이력 불변, source 는 soft delete",
    })})`);
  return { targetId, sourceId, moved: Object.fromEntries(Object.entries(moved).map(([k, v]) => [k, v.length])), aliasAdded, duplicateContacts: plan.duplicateContacts.length };
}
