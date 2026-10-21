// @ts-nocheck — 격리 복제 DB 전용 통합 시나리오 검증(§3~§7). SCRATCH_DB_URL(=scratch_merge)에서만 실행. 운영 DB 미접촉.
//  시나리오: 강보성 대표 #2406 ← 통합(숨김) #2407, #2408.
//  검증: ①대표 유지·중복 운영목록 제외 ②수행이력 중복집계 없음·판매/정산/지급 건수·금액 불변 ③통합이력·감사로그 ④되돌리기 정확 복구.
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { runMergeExecute, revertMerge, expectedConfirmToken } from "./services/translatorMergeExecute";
import { buildMergePreview } from "./services/translatorMerge";

const url = process.env.SCRATCH_DB_URL;
if (!url || !/scratch/i.test(url)) { console.error("SCRATCH_DB_URL(=scratch_merge)만 허용 — 운영 DB 차단. 현재:", url); process.exit(1); }
const pool = new Pool({ connectionString: url });
const db = drizzle(pool);
const rows = (q) => q.rows;
const one = async (q) => Number(rows(await db.execute(q))[0]?.v ?? 0);
const REP = 2406, MERGED = [2407, 2408], ALL = [REP, ...MERGED];
const A = sql.raw(`ARRAY[${ALL.join(",")}]::int[]`);

// 운영목록(=translators 목록 쿼리와 동일 조건): role=translator AND deleted_at IS NULL
async function inOperationalList(id) {
  return await one(sql`SELECT count(*) v FROM users WHERE id=${id} AND role='translator' AND deleted_at IS NULL`);
}
// 전역 불변식(건수·금액) — 재지정은 소유자만 바꾸므로 총합 불변이어야 함(§5)
async function globals() {
  return {
    operList: await one(sql`SELECT count(*) v FROM users WHERE role='translator' AND deleted_at IS NULL`),
    tasksCnt: await one(sql`SELECT count(*) v FROM tasks`),
    setlCnt: await one(sql`SELECT count(*) v FROM settlements`),
    setlSum: await one(sql`SELECT coalesce(sum(translator_amount),0) v FROM settlements`),
    trCnt: await one(sql`SELECT count(*) v FROM payout_transfers`),
    trSum: await one(sql`SELECT coalesce(sum(amount),0) v FROM payout_transfers`),
    poiCnt: await one(sql`SELECT count(*) v FROM payout_round_items`),
    perfCnt: await one(sql`SELECT count(*) v FROM performance_assignments`),
    progress: await one(sql`SELECT count(*) v FROM legacy_archive_rows WHERE source_type='progress'`),
    sales: await one(sql`SELECT count(*) v FROM legacy_archive_rows WHERE source_type='sales_list'`),
    legacyMap: await one(sql`SELECT count(*) v FROM legacy_master_mappings`),
  };
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  console.log("=== 격리 복제 DB(scratch_merge) 통합 시나리오 검증 ===");
  console.log("대표 #" + REP + " ← 통합 #" + MERGED.join(", #") + "\n");

  // ── 통합 전 상태 스냅샷 ──
  const before = await globals();
  const opBefore = { "2406": await inOperationalList(2406), "2407": await inOperationalList(2407), "2408": await inOperationalList(2408) };
  // 대상 3계정의 FK 직접참조(수행이력·판매·정산·지급) 분포
  const fk = {
    tasks: await one(sql`SELECT count(*) v FROM tasks WHERE translator_id = ANY(${A})`),
    settlements: await one(sql`SELECT count(*) v FROM settlements WHERE translator_id = ANY(${A})`),
    perf: await one(sql`SELECT count(*) v FROM performance_assignments WHERE individual_user_id = ANY(${A}) AND deleted_at IS NULL`),
    poi: await one(sql`SELECT count(*) v FROM payout_round_items WHERE payee_type='individual' AND payee_id = ANY(${A})`),
    transfers: await one(sql`SELECT count(*) v FROM payout_transfers WHERE payee_type='individual' AND payee_id = ANY(${A})`),
    legacyMap: await one(sql`SELECT count(*) v FROM legacy_master_mappings WHERE entity_type='translator' AND status<>'rolled_back' AND entity_id = ANY(${A})`),
  };
  console.log("[통합 전] 운영목록 노출:", JSON.stringify(opBefore), "| 전체 운영목록:", before.operList);
  console.log("[통합 전] 대상 3계정 FK 직접참조:", JSON.stringify(fk));

  // ── 미리보기(수행이력 record-id dedup) ──
  const pv = await buildMergePreview(db, ALL, REP);
  console.log("[미리보기] 진행관리표 수행이력(dedup):", pv.preview?.finalHistoryCount, "| ambiguous:", pv.preview?.ambiguousHistory,
    "| 판매:", pv.preview?.finalSalesCount, "| 정산:", pv.preview?.settlementCount + "건/" + pv.preview?.settlementAmount,
    "| 실지급:", pv.preview?.payoutTransferCount + "건/" + pv.preview?.totalPaid);

  // ── DRY-RUN (확인 미체크 → 차단 아님, 실행불가) ──
  const dry = await runMergeExecute(db, { masterIds: ALL, representativeId: REP, samePersonConfirmed: false, commit: false });
  console.log("[DRY-RUN·확인X] blocked:", dry.blocked, "| canExecute:", dry.canExecute, "| plan:", JSON.stringify((dry.plan ?? []).filter(x => x.count > 0)));

  // ── 실제 통합(commit) — 동일인 확인 + 토큰 ──
  const token = expectedConfirmToken(REP, MERGED);
  const run = await runMergeExecute(db, { masterIds: ALL, representativeId: REP, samePersonConfirmed: true, commit: true, confirmToken: token, performedBy: 1, note: "강보성 동일인 통합(격리검증)" });
  console.log("\n[COMMIT] committed:", run.committed, "| mergeIds:", JSON.stringify(run.mergeIds), "| invariantsOk:", run.invariantsOk);

  // ── §4 대표 유지 · 중복 운영목록 제외 ──
  const opAfter = { "2406": await inOperationalList(2406), "2407": await inOperationalList(2407), "2408": await inOperationalList(2408) };
  const opStatus = {};
  for (const id of MERGED) opStatus[id] = rows(await db.execute(sql`SELECT operational_status, (deleted_at IS NOT NULL) del FROM translator_profiles p JOIN users u ON u.id=p.user_id WHERE user_id=${id}`))[0];
  console.log("\n[§4 대표유지/중복제외] 운영목록 노출:", JSON.stringify(opAfter), "(2406=1, 2407·2408=0 기대)");
  console.log("  merged 상태:", JSON.stringify(opStatus));

  // ── §6 통합이력 · 감사로그 ──
  const mergeRows = rows(await db.execute(sql`SELECT id, merged_master_id, representative_master_id, same_person_confirmed, basis, status, (snapshot IS NOT NULL) snap FROM translator_merges WHERE representative_master_id=${REP} ORDER BY id`));
  const auditCnt = await one(sql`SELECT count(*) v FROM translator_merge_audit WHERE merge_id = ANY(${sql.raw(`ARRAY[${run.mergeIds.join(",")}]::int[]`)})`);
  const auditByAction = rows(await db.execute(sql`SELECT action, count(*) c FROM translator_merge_audit WHERE merge_id = ANY(${sql.raw(`ARRAY[${run.mergeIds.join(",")}]::int[]`)}) GROUP BY action ORDER BY action`));
  console.log("\n[§6 통합이력/감사] translator_merges:", JSON.stringify(mergeRows));
  console.log("  감사로그:", auditCnt, "건 ·", JSON.stringify(auditByAction));

  // ── §5 수행이력 중복없음 · 판매/정산/지급 건수·금액 불변 ──
  const after = await globals();
  const invariantKeys = ["tasksCnt", "setlCnt", "setlSum", "trCnt", "trSum", "poiCnt", "perfCnt", "progress", "sales", "legacyMap"];
  const invChanged = invariantKeys.filter(k => before[k] !== after[k]);
  console.log("\n[§5 불변식] 통합 전/후 전역 집계:");
  for (const k of invariantKeys) console.log(`   ${k}: ${before[k]} → ${after[k]} ${before[k] === after[k] ? "✓" : "✗ 변경!"}`);
  console.log("  운영목록:", before.operList, "→", after.operList, `(merged ${MERGED.length}건 제외 기대 =${before.operList - MERGED.length})`);

  const commitOk =
    run.committed && run.invariantsOk &&
    opAfter["2406"] === 1 && opAfter["2407"] === 0 && opAfter["2408"] === 0 &&
    MERGED.every(id => opStatus[id]?.operational_status === "merged" && opStatus[id]?.del === true) &&
    mergeRows.length === 2 && mergeRows.every(m => m.status === "active" && m.same_person_confirmed === true && m.snap === true) &&
    auditCnt >= 2 &&
    invChanged.length === 0 &&
    after.operList === before.operList - MERGED.length;
  console.log("\n>> 통합 검증:", commitOk ? "PASS ✅" : "FAIL ❌", invChanged.length ? "(불변식 변경: " + invChanged.join(",") + ")" : "");

  // ── §7 되돌리기(원상복구) ──
  console.log("\n[§7 되돌리기] 모든 통합 취소 → 통합 전 상태 복원");
  for (const mid of run.mergeIds) { const r = await revertMerge(db, mid, 1); console.log("   revert merge#" + mid + ":", JSON.stringify(r)); }

  const opRevert = { "2406": await inOperationalList(2406), "2407": await inOperationalList(2407), "2408": await inOperationalList(2408) };
  const statusRevert = rows(await db.execute(sql`SELECT id, status FROM translator_merges WHERE representative_master_id=${REP} ORDER BY id`));
  const opStatusRevert = {};
  for (const id of MERGED) opStatusRevert[id] = rows(await db.execute(sql`SELECT operational_status FROM translator_profiles WHERE user_id=${id}`))[0]?.operational_status;
  const afterRevert = await globals();
  console.log("  운영목록 노출:", JSON.stringify(opRevert), "(통합 전과 동일 기대:", JSON.stringify(opBefore) + ")");
  console.log("  merged operational_status:", JSON.stringify(opStatusRevert), "| translator_merges status:", JSON.stringify(statusRevert));

  const revertOk =
    eq(opRevert, opBefore) &&
    statusRevert.every(s => s.status === "reverted") &&
    eq(afterRevert, before);
  console.log("  전역 집계 복원:", eq(afterRevert, before) ? "✓ (통합 전과 완전 일치)" : "✗");
  console.log("\n>> 되돌리기 검증:", revertOk ? "PASS ✅ (통합 전 상태로 정확히 복구)" : "FAIL ❌");

  console.log("\n=== 최종:", commitOk && revertOk ? "ALL PASS ✅✅" : "FAIL ❌", "===");
  await pool.end();
  process.exit(commitOk && revertOk ? 0 : 2);
}
main().catch(async (e) => { console.error("FATAL", e); try { await pool.end(); } catch {} process.exit(1); });
