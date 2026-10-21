// 통번역사 기존 중복 Master 정리 "실행" — 단일 트랜잭션·실패 시 롤백. DRY-RUN 기본.
//  · 대상: 신규(batch 182)와 이름 동일(정규화)한 기존(비-batch182) Master.
//  · 물리삭제: 참조 전무(재확인) 계정만. 그 외(CRM 원본연결 등 과거기록 보유)는 비활성화(soft-delete + 제외상태).
//  · 보존: 진행관리표/판매목록/지급·정산/CRM 원본자료/legacy 매핑 불변. 신규·동명없는 기존 불변.
//  · 사용법: node dist/delete-execute.mjs            → DRY-RUN(검증·계획만, 미변경)
//            node dist/delete-execute.mjs --commit   → 실제 실행(트랜잭션). 반드시 백업 후.
//  · 안전장치: 재계산 대상 수가 승인치(874/3/871)와 다르면 즉시 중단(쓰기 없음).
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { normalizeCompanyName } from "./lib/normalizeCompany";

const BATCH = 182;
const COMMIT = process.argv.includes("--commit");
const EXPECT = { targets: 874, hard: 3, deactivate: 871, newMasters: 1035, oldMasters: 1302, afterList: 1463, keptOld: 428 };
const EXCLUDE_NOTE = `중복정리제외: 동명 신규(batch${BATCH}) 존재·CRM연결 보존 비활성화 (2026-10-20)`;

async function main() {
  const rows = (q: any) => (q as any).rows as any[];
  const anyArr = (ids: number[]) => sql.raw(`ARRAY[${ids.length ? ids.join(",") : "-1"}]::int[]`);
  const fail = (msg: string) => { console.error(`ABORT: ${msg} — 쓰기 없음, 중단합니다.`); };

  // ── 재계산(DRY-RUN 로직과 동일) ──
  const newIds = new Set<number>(rows(await db.execute(sql`SELECT entity_id FROM import_row_sources WHERE batch_id=${BATCH}`)).map((r) => Number(r.entity_id)));
  const users = rows(await db.execute(sql`SELECT id, name FROM users WHERE role='translator' AND deleted_at IS NULL`));
  const all = users.map((u) => ({ id: Number(u.id), name: u.name ?? "", norm: normalizeCompanyName(u.name ?? ""), isNew: newIds.has(Number(u.id)) }));
  const news = all.filter((m) => m.isNew);
  const olds = all.filter((m) => !m.isNew);
  const newNames = new Set<string>(news.map((m) => m.norm).filter(Boolean));
  const targets = olds.filter((m) => m.norm && newNames.has(m.norm));
  const targetIds = targets.map((m) => m.id);

  // ── 참조 점검(블로커) — 보유 시 비활성화, 전무 시 물리삭제 후보 ──
  const refIds = new Set<number>();
  const A = anyArr(targetIds);
  const scan = async (q: any) => { for (const r of rows(await db.execute(q))) refIds.add(Number(r.id)); };
  await scan(sql`SELECT DISTINCT translator_id id FROM tasks WHERE translator_id = ANY(${A})`);
  await scan(sql`SELECT DISTINCT translator_id id FROM settlements WHERE translator_id = ANY(${A})`);
  await scan(sql`SELECT DISTINCT individual_user_id id FROM performance_assignments WHERE individual_user_id = ANY(${A})`);
  await scan(sql`SELECT DISTINCT payee_id id FROM payout_round_items WHERE payee_type='individual' AND payee_id = ANY(${A})`);
  await scan(sql`SELECT DISTINCT payee_id id FROM payout_transfers WHERE payee_type='individual' AND payee_id = ANY(${A})`);
  await scan(sql`SELECT DISTINCT entity_id id FROM legacy_master_mappings WHERE entity_type='translator' AND status<>'rolled_back' AND entity_id = ANY(${A})`);
  await scan(sql`SELECT DISTINCT translator_id id FROM translation_units WHERE translator_id = ANY(${A})`);
  await scan(sql`SELECT DISTINCT author_id id FROM board_posts WHERE author_id = ANY(${A})`);
  await scan(sql`SELECT DISTINCT admin_id id FROM notes WHERE admin_id = ANY(${A})`);
  await scan(sql`SELECT DISTINCT uid id FROM (SELECT user_id uid FROM projects WHERE user_id = ANY(${A}) UNION SELECT admin_id FROM projects WHERE admin_id = ANY(${A}) UNION SELECT customer_user_id FROM projects WHERE customer_user_id = ANY(${A})) x`);
  await scan(sql`SELECT DISTINCT uid id FROM (SELECT requested_by uid FROM product_requests WHERE requested_by = ANY(${A}) UNION SELECT approved_by FROM product_requests WHERE approved_by = ANY(${A})) x`);
  await scan(sql`SELECT DISTINCT uid id FROM (SELECT created_by uid FROM project_payments WHERE created_by = ANY(${A}) UNION SELECT updated_by FROM project_payments WHERE updated_by = ANY(${A})) x`);
  await scan(sql`SELECT DISTINCT uid id FROM (SELECT created_by uid FROM payout_rounds WHERE created_by = ANY(${A}) UNION SELECT completed_by FROM payout_rounds WHERE completed_by = ANY(${A})) x`);
  await scan(sql`SELECT DISTINCT uid id FROM (SELECT created_by uid FROM payment_transactions WHERE created_by = ANY(${A}) UNION SELECT updated_by FROM payment_transactions WHERE updated_by = ANY(${A})) x`);
  await scan(sql`SELECT DISTINCT uid id FROM (SELECT created_by uid FROM performance_assignments WHERE created_by = ANY(${A}) UNION SELECT updated_by FROM performance_assignments WHERE updated_by = ANY(${A}) UNION SELECT delivery_confirmed_by FROM performance_assignments WHERE delivery_confirmed_by = ANY(${A}) UNION SELECT pay_date_changed_by FROM performance_assignments WHERE pay_date_changed_by = ANY(${A})) x`);

  const hardIds = targetIds.filter((id) => !refIds.has(id));
  const deactivateIds = targetIds.filter((id) => refIds.has(id));

  // ── 승인치 정합 검증(불일치 시 중단) ──
  console.log(`재계산: 신규 ${news.length} · 기존 ${olds.length} · 삭제대상 ${targets.length} · 물리삭제 ${hardIds.length} · 비활성화 ${deactivateIds.length}`);
  const checks: [string, boolean][] = [
    [`신규 ${news.length}=${EXPECT.newMasters}`, news.length === EXPECT.newMasters],
    [`기존 ${olds.length}=${EXPECT.oldMasters}`, olds.length === EXPECT.oldMasters],
    [`삭제대상 ${targets.length}=${EXPECT.targets}`, targets.length === EXPECT.targets],
    [`물리삭제 ${hardIds.length}=${EXPECT.hard}`, hardIds.length === EXPECT.hard],
    [`비활성화 ${deactivateIds.length}=${EXPECT.deactivate}`, deactivateIds.length === EXPECT.deactivate],
  ];
  for (const [label, ok] of checks) if (!ok) { fail(`승인치 불일치(${label})`); await pool.end(); process.exit(1); }
  console.log("✓ 승인치 정합(874/3/871, 신규1035/기존1302) — 대상 동일 확인");
  console.log(`  물리삭제 ID: [${hardIds.join(", ")}]`);

  if (!COMMIT) {
    console.log("\n[DRY-RUN] --commit 미지정 → DB 미변경. 위 대상이 승인치와 동일하면 --commit 으로 실행하세요.");
    console.log("PLAN " + JSON.stringify({ dryRun: true, committed: false, targets: targets.length, hard: hardIds, deactivate: deactivateIds.length }));
    await pool.end(); process.exit(0);
  }

  // ── 실행(단일 트랜잭션) ──
  let result: any = null;
  try {
    await db.transaction(async (tx: any) => {
      const exec = (q: any) => tx.execute(q);
      const HA = anyArr(hardIds), DA = anyArr(deactivateIds);

      // (1) 물리삭제 직전 참조 0 재확인(트랜잭션 내부)
      const reCheck = Number(rows(await exec(sql`
        SELECT count(*)::int n FROM (
          SELECT translator_id id FROM tasks WHERE translator_id = ANY(${HA})
          UNION SELECT translator_id FROM settlements WHERE translator_id = ANY(${HA})
          UNION SELECT individual_user_id FROM performance_assignments WHERE individual_user_id = ANY(${HA})
          UNION SELECT payee_id FROM payout_round_items WHERE payee_type='individual' AND payee_id = ANY(${HA})
          UNION SELECT payee_id FROM payout_transfers WHERE payee_type='individual' AND payee_id = ANY(${HA})
          UNION SELECT entity_id FROM legacy_master_mappings WHERE entity_type='translator' AND status<>'rolled_back' AND entity_id = ANY(${HA})
          UNION SELECT translator_id FROM translation_units WHERE translator_id = ANY(${HA})
        ) z`))[0].n);
      if (reCheck !== 0) throw new Error(`물리삭제 대상에 참조 ${reCheck}건 발견 — 롤백`);

      // (2) 비활성화 871: soft-delete + 제외상태(명확 구분) + CRM연결 보존(미변경)
      await exec(sql`UPDATE users SET deleted_at = now(), is_active = false WHERE id = ANY(${DA}) AND role='translator'`);
      await exec(sql`UPDATE translator_profiles SET operational_status = 'excluded', operational_note = ${EXCLUDE_NOTE}, updated_at = now() WHERE user_id = ANY(${DA})`);

      // (3) 물리삭제 3: 종속정보 선삭제(NO ACTION) 후 user 삭제(CASCADE가 나머지 종속정보 제거)
      await exec(sql`DELETE FROM translator_rates WHERE translator_id = ANY(${HA})`);
      await exec(sql`DELETE FROM translator_profiles WHERE user_id = ANY(${HA})`);
      await exec(sql`DELETE FROM users WHERE id = ANY(${HA}) AND role='translator'`);

      // (4) 트랜잭션 내부 검증 — 실패 시 throw → 롤백
      const q1 = Number(rows(await exec(sql`SELECT count(*)::int n FROM users WHERE role='translator' AND deleted_at IS NULL`))[0].n);
      const qNew = Number(rows(await exec(sql`SELECT count(*)::int n FROM users u JOIN (SELECT DISTINCT entity_id eid FROM import_row_sources WHERE batch_id=${BATCH}) b ON b.eid=u.id WHERE u.role='translator' AND u.deleted_at IS NULL`))[0].n);
      const qExcluded = Number(rows(await exec(sql`SELECT count(*)::int n FROM users u JOIN translator_profiles p ON p.user_id=u.id WHERE u.role='translator' AND u.deleted_at IS NOT NULL AND p.operational_status='excluded'`))[0].n);
      const qHardGone = Number(rows(await exec(sql`SELECT count(*)::int n FROM users WHERE id = ANY(${HA})`))[0].n);
      const qCrmPreserved = Number(rows(await exec(sql`SELECT count(DISTINCT entity_id)::int n FROM legacy_master_mappings WHERE entity_type='translator' AND status<>'rolled_back' AND entity_id = ANY(${DA})`))[0].n);

      const asserts: [string, boolean][] = [
        [`운영목록 ${q1}=${EXPECT.afterList}`, q1 === EXPECT.afterList],
        [`신규유지 ${qNew}=${EXPECT.newMasters}`, qNew === EXPECT.newMasters],
        [`중복정리제외 ${qExcluded}=${EXPECT.deactivate}`, qExcluded === EXPECT.deactivate],
        [`물리삭제완료 ${qHardGone}=0`, qHardGone === 0],
      ];
      for (const [label, ok] of asserts) if (!ok) throw new Error(`사후검증 실패(${label}) — 롤백`);

      result = { afterList: q1, keptNew: qNew, keptOld: q1 - qNew, excluded: qExcluded, hardDeleted: hardIds.length, crmPreservedOnDeactivated: qCrmPreserved };
    });
  } catch (e: any) {
    console.error("ROLLBACK:", e?.message ?? e);
    await pool.end(); process.exit(1);
  }

  console.log("\n✓ COMMIT 완료(단일 트랜잭션)");
  console.log("RESULT " + JSON.stringify({ committed: true, ...result }));
  await pool.end().catch(() => {});
  process.exit(0);
}
main().catch(async (e) => { console.error("FATAL", e); try { await pool.end(); } catch { /* ignore */ } process.exit(1); });
