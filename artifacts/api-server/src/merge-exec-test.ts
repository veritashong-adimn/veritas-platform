// @ts-nocheck — 격리 테스트 전용 하네스(앱 빌드 비포함, esbuild 번들로 실행). pg 직접 연결 사용.
// 통번역사 통합 엔진 — 격리 테스트(§15). SCRATCH_DB_URL(임시 복원 DB)에서만 실행. 운영 DB 미접촉.
//  · 통제 시나리오: 동명 신규 2계정(식별자 없음) + merged 측에 CRM매핑 1건 시드 → 통합(commit) → 검증 → 되돌리기 → 검증.
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { runMergeExecute, revertMerge, expectedConfirmToken } from "./services/translatorMergeExecute";

const url = process.env.SCRATCH_DB_URL;
if (!url) { console.error("SCRATCH_DB_URL 필요"); process.exit(1); }
const pool = new Pool({ connectionString: url });
const db = drizzle(pool);
const rows = (q: any) => (q as any).rows as any[];
const one = async (q: any) => Number(rows(await db.execute(q))[0]?.v ?? 0);

async function snapshotTotals() {
  return {
    legacyMap: await one(sql`SELECT count(*) v FROM legacy_master_mappings`),
    progress: await one(sql`SELECT count(*) v FROM legacy_archive_rows WHERE source_type='progress'`),
    sales: await one(sql`SELECT count(*) v FROM legacy_archive_rows WHERE source_type='sales_list'`),
    operList: await one(sql`SELECT count(*) v FROM users WHERE role='translator' AND deleted_at IS NULL`),
  };
}

async function main() {
  const REP = 1639, MERGED = 1734;   // 동명 '김세나' 신규 2계정
  console.log("=== 격리 테스트 시작(SCRATCH) ===");
  // 시드: merged 측 CRM 매핑 1건(없으면 생성) — 재지정 검증용
  await db.execute(sql`INSERT INTO legacy_master_mappings (source_system, entity_type, legacy_id, entity_id, match_method, status)
    VALUES ('test_crm','translator',${"TESTKEY-" + MERGED}, ${MERGED}, 'legacy', 'active') ON CONFLICT DO NOTHING`);

  const t0 = await snapshotTotals();
  console.log("시드 후 총계:", JSON.stringify(t0));
  const mapBefore = rows(await db.execute(sql`SELECT entity_id FROM legacy_master_mappings WHERE legacy_id=${"TESTKEY-" + MERGED}`))[0]?.entity_id;

  // ── DRY-RUN ──
  const dry = await runMergeExecute(db, { masterIds: [REP, MERGED], representativeId: REP, samePersonConfirmed: false, commit: false });
  console.log("\n[DRY-RUN] blocked:", dry.blocked, "| reasons:", JSON.stringify(dry.reasons), "| plan:", JSON.stringify(dry.plan), "| token:", dry.confirmToken, "| requiresConfirm:", dry.requiresSamePersonConfirm);

  // ── 동일인 확인 없이 commit 시도 → 차단되어야 ──
  const noConfirm = await runMergeExecute(db, { masterIds: [REP, MERGED], representativeId: REP, samePersonConfirmed: false, commit: true, confirmToken: expectedConfirmToken(REP, [MERGED]) });
  console.log("[가드] 확인체크 없이 commit → blocked:", noConfirm.blocked, "| reasons:", JSON.stringify(noConfirm.reasons));

  // ── 실제 통합(commit) ──
  const run = await runMergeExecute(db, { masterIds: [REP, MERGED], representativeId: REP, samePersonConfirmed: true, commit: true, confirmToken: expectedConfirmToken(REP, [MERGED]), performedBy: 1, note: "격리테스트" });
  console.log("\n[COMMIT] committed:", run.committed, "| mergeIds:", JSON.stringify(run.mergeIds), "| invariantsOk:", run.invariantsOk);

  // 검증
  const mergedExcluded = await one(sql`SELECT count(*) v FROM users WHERE id=${MERGED} AND deleted_at IS NOT NULL`);
  const repAlive = await one(sql`SELECT count(*) v FROM users WHERE id=${REP} AND deleted_at IS NULL`);
  const opStatus = rows(await db.execute(sql`SELECT operational_status FROM translator_profiles WHERE user_id=${MERGED}`))[0]?.operational_status;
  const mapAfter = rows(await db.execute(sql`SELECT entity_id FROM legacy_master_mappings WHERE legacy_id=${"TESTKEY-" + MERGED}`))[0]?.entity_id;
  const mergeRow = rows(await db.execute(sql`SELECT id,status FROM translator_merges WHERE merged_master_id=${MERGED} AND status='active'`))[0];
  const auditCnt = await one(sql`SELECT count(*) v FROM translator_merge_audit WHERE merge_id=${mergeRow?.id}`);
  const t1 = await snapshotTotals();
  console.log("통합 후: merged제외", mergedExcluded, "| 대표생존", repAlive, "| merged.opStatus", opStatus, "| CRM매핑 entity_id", mapBefore, "→", mapAfter, "| 감사", auditCnt, "건");
  console.log("불변식(legacyMap/progress/sales 총수):", JSON.stringify(t1), "| 운영목록 변화:", t0.operList, "→", t1.operList, "(merged 1 제외 기대)");
  const invOk = t0.legacyMap === t1.legacyMap && t0.progress === t1.progress && t0.sales === t1.sales && t1.operList === t0.operList - 1;

  // ── 되돌리기 ──
  const rev = await revertMerge(db, Number(mergeRow.id), 1);
  console.log("\n[REVERT]", JSON.stringify(rev));
  const mergedBack = await one(sql`SELECT count(*) v FROM users WHERE id=${MERGED} AND deleted_at IS NULL`);
  const mapReverted = rows(await db.execute(sql`SELECT entity_id FROM legacy_master_mappings WHERE legacy_id=${"TESTKEY-" + MERGED}`))[0]?.entity_id;
  const t2 = await snapshotTotals();
  console.log("되돌린 후: merged복구(목록노출)", mergedBack, "| CRM매핑 entity_id 복원", mapReverted, "(=", MERGED, "기대) | 운영목록", t2.operList, "(=", t0.operList, "기대)");

  const allOk = run.committed && run.invariantsOk && mergedExcluded === 1 && repAlive === 1 && opStatus === "merged"
    && Number(mapAfter) === REP && invOk && noConfirm.blocked
    && mergedBack === 1 && Number(mapReverted) === MERGED && t2.operList === t0.operList;
  console.log("\n=== 격리 검증 결과:", allOk ? "PASS ✅" : "FAIL ❌", "===");
  await pool.end();
  process.exit(allOk ? 0 : 2);
}
main().catch(async (e) => { console.error("FATAL", e); try { await pool.end(); } catch { /* ignore */ } process.exit(1); });
