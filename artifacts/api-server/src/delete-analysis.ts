// 통번역사 기존 중복 Master 삭제 — "분석 전용"(DRY-RUN, DB 미변경·삭제/수정 없음).
//  · 대표 결정: 동일인 판별이 아니라 '이름 기준' 삭제. 오늘 CRM 명부 신규(batch 182)와 이름이 동일한
//    기존(비-batch 182) Master를 삭제 대상으로 선정. 주민번호/전화/이메일은 선정 조건으로 쓰지 않는다.
//  · 기존/신규 구분은 화면 상태가 아니라 '생성 배치(import_row_sources.batch_id=182)'로만 판정.
//  · 이름 정규화는 기존 873그룹 분석과 동일(normalizeCompanyName) — 분석 재사용(§3).
//  · 삭제 안전성: users.id 참조 FK 전수 + soft-link(지급 payee, CRM 매핑) + 과거기록(수행/정산/지급/번역단위)
//    점검. 과거기록 소실·참조무결성 위반 시 물리삭제 금지 → 비활성화 필요로 분류(§4).
//  · 산출: 삭제대상/유지/예상목록/‐FK보유/실삭제가능/비활성화필요 수(§5). 실제 삭제·백업은 실행하지 않는다.
import fs from "fs";
import path from "path";
import * as XLSX from "xlsx";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { normalizeCompanyName } from "./lib/normalizeCompany";

const BATCH = 182;
const OUT_DIR = process.env.DEDUP_REPORT_DIR || "/home/runner/veritas-reports";

async function main() {
  const rows = (q: any) => (q as any).rows as any[];
  const anyArr = (ids: number[]) => sql.raw(`ARRAY[${ids.join(",")}]::int[]`);

  const newIds = new Set<number>(rows(await db.execute(sql`SELECT entity_id FROM import_row_sources WHERE batch_id=${BATCH}`)).map((r) => Number(r.entity_id)));
  const users = rows(await db.execute(sql`SELECT id, name FROM users WHERE role='translator' AND deleted_at IS NULL`));

  const all = users.map((u) => ({ id: Number(u.id), name: u.name ?? "", norm: normalizeCompanyName(u.name ?? ""), isNew: newIds.has(Number(u.id)) }));
  const totalMasters = all.length;
  const news = all.filter((m) => m.isNew);
  const olds = all.filter((m) => !m.isNew);
  // 신규 이름 집합(정규화). 빈 이름은 매칭에서 제외.
  const newNames = new Set<string>(news.map((m) => m.norm).filter(Boolean));

  // 삭제 대상 = 기존 Master 중 정규화 이름이 신규 이름집합에 존재(§2). 주민/전화/이메일 불사용.
  const targets = olds.filter((m) => m.norm && newNames.has(m.norm));
  const targetIds = targets.map((m) => m.id);

  // ── 삭제 안전성: 과거기록/참조 보유 점검(읽기 전용) ──
  //  각 블로커를 보유하면 물리삭제 금지 → 비활성화 필요. 사유 누적.
  const reasons = new Map<number, Set<string>>();
  const mark = (id: number, why: string) => { const s = reasons.get(id) ?? new Set<string>(); s.add(why); reasons.set(id, s); };
  const scan = async (label: string, q: any) => { for (const r of rows(await db.execute(q))) mark(Number(r.id), label); };

  if (targetIds.length > 0) {
    const A = anyArr(targetIds);
    // 과거 이력(수행/정산/지급) — NO ACTION FK 또는 soft-link
    await scan("작업(tasks)", sql`SELECT DISTINCT translator_id id FROM tasks WHERE translator_id = ANY(${A})`);
    await scan("정산(settlements)", sql`SELECT DISTINCT translator_id id FROM settlements WHERE translator_id = ANY(${A})`);
    await scan("수행(performance_assignments)", sql`SELECT DISTINCT individual_user_id id FROM performance_assignments WHERE individual_user_id = ANY(${A})`);
    await scan("지급회차(payout_round_items)", sql`SELECT DISTINCT payee_id id FROM payout_round_items WHERE payee_type='individual' AND payee_id = ANY(${A})`);
    await scan("송금(payout_transfers)", sql`SELECT DISTINCT payee_id id FROM payout_transfers WHERE payee_type='individual' AND payee_id = ANY(${A})`);
    // CRM 원본 연결(provenance, soft-link) — 고아화 시 소실
    await scan("CRM원본연결(legacy_master_mappings)", sql`SELECT DISTINCT entity_id id FROM legacy_master_mappings WHERE entity_type='translator' AND status<>'rolled_back' AND entity_id = ANY(${A})`);
    // 번역단위 자산(SET NULL → 링크 소실)
    await scan("번역단위(translation_units)", sql`SELECT DISTINCT translator_id id FROM translation_units WHERE translator_id = ANY(${A})`);
    // 활동 흔적(acted-by, NO ACTION → 삭제 차단) — 번역사가 staff행위를 했을 가능성 전수확인
    await scan("활동(board_posts.author)", sql`SELECT DISTINCT author_id id FROM board_posts WHERE author_id = ANY(${A})`);
    await scan("활동(notes.admin)", sql`SELECT DISTINCT admin_id id FROM notes WHERE admin_id = ANY(${A})`);
    await scan("활동(projects.user/admin)", sql`SELECT DISTINCT uid id FROM (SELECT user_id uid FROM projects WHERE user_id = ANY(${A}) UNION SELECT admin_id FROM projects WHERE admin_id = ANY(${A})) x`);
    await scan("활동(product_requests)", sql`SELECT DISTINCT uid id FROM (SELECT requested_by uid FROM product_requests WHERE requested_by = ANY(${A}) UNION SELECT approved_by FROM product_requests WHERE approved_by = ANY(${A})) x`);
    await scan("활동(project_payments)", sql`SELECT DISTINCT uid id FROM (SELECT created_by uid FROM project_payments WHERE created_by = ANY(${A}) UNION SELECT updated_by FROM project_payments WHERE updated_by = ANY(${A})) x`);
    await scan("활동(payout_rounds)", sql`SELECT DISTINCT uid id FROM (SELECT created_by uid FROM payout_rounds WHERE created_by = ANY(${A}) UNION SELECT completed_by FROM payout_rounds WHERE completed_by = ANY(${A})) x`);
    await scan("활동(payment_transactions)", sql`SELECT DISTINCT uid id FROM (SELECT created_by uid FROM payment_transactions WHERE created_by = ANY(${A}) UNION SELECT updated_by FROM payment_transactions WHERE updated_by = ANY(${A})) x`);
    await scan("활동(performance acted-by)", sql`SELECT DISTINCT uid id FROM (SELECT created_by uid FROM performance_assignments WHERE created_by = ANY(${A}) UNION SELECT updated_by FROM performance_assignments WHERE updated_by = ANY(${A}) UNION SELECT delivery_confirmed_by FROM performance_assignments WHERE delivery_confirmed_by = ANY(${A}) UNION SELECT pay_date_changed_by FROM performance_assignments WHERE pay_date_changed_by = ANY(${A})) x`);
  }

  const hasRef = (id: number) => (reasons.get(id)?.size ?? 0) > 0;
  const deactivateTargets = targets.filter((m) => hasRef(m.id));    // 물리삭제 불가 → 비활성화 필요
  const hardDeletable = targets.filter((m) => !hasRef(m.id));       // 실제 물리삭제 가능(종속정보만 선삭제)

  // 사유별 분포
  const reasonDist: Record<string, number> = {};
  for (const m of targets) for (const why of (reasons.get(m.id) ?? [])) reasonDist[why] = (reasonDist[why] ?? 0) + 1;

  // ── 집계 ──
  const keptNew = news.length;
  const keptOld = olds.length - targets.length;
  const afterList = totalMasters - targets.length;    // 삭제/비활성화 모두 일반목록에서 제외

  // ── Excel ──
  const wb = XLSX.utils.book_new();
  const tAoa: any[][] = [["기존MasterID", "이름", "처리구분", "참조/과거기록 사유"]];
  for (const m of targets) tAoa.push([m.id, m.name, hasRef(m.id) ? "비활성화필요" : "물리삭제가능", [...(reasons.get(m.id) ?? [])].join(", ")]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(tAoa), "1_삭제대상");
  const rAoa: any[][] = [["사유", "계정수"], ...Object.entries(reasonDist).sort((a, b) => b[1] - a[1])];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rAoa), "2_사유분포");
  const summary: any[][] = [
    ["항목", "값"],
    ["전체 Master 수", totalMasters],
    ["  ├ 기존(비-batch182)", olds.length],
    ["  └ 신규(batch182/오늘 CRM 명부)", news.length],
    ["신규 고유 이름 수(정규화)", newNames.size],
    ["── 삭제 기준: 기존 이름 == 신규 이름(정규화) ──", ""],
    ["삭제 대상 기존 Master 수", targets.length],
    ["유지할 신규 Master 수", keptNew],
    ["유지할 기존 Master 수(신규에 동명 없음)", keptOld],
    ["삭제 후 예상 목록 수", afterList],
    ["── 안전성 ──", ""],
    ["삭제 대상 중 FK/과거기록 참조 보유 계정 수", deactivateTargets.length],
    ["실제 물리삭제 가능 계정 수", hardDeletable.length],
    ["물리삭제 불가 → 비활성화 필요 계정 수", deactivateTargets.length],
    ["작업 성격", "DRY-RUN · DB 미변경 · 삭제/수정 미실행 · 승인·백업 전 쓰기 금지"],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), "3_요약");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const outPath = path.join(OUT_DIR, `translator_delete_analysis_${stamp}.xlsx`);
  XLSX.writeFile(wb, outPath);

  // ── 콘솔 ──
  console.log("");
  console.log("════════════════════════════════════════════════════════════════════");
  console.log(" VERITAS 통번역사 기존 중복 Master 삭제 — DRY-RUN 분석 보고");
  console.log("════════════════════════════════════════════════════════════════════");
  console.log(` 전체 Master 수                     : ${totalMasters}`);
  console.log(`   ├ 기존(비-batch182)             : ${olds.length}`);
  console.log(`   └ 신규(batch182/오늘 CRM 명부)   : ${news.length}`);
  console.log("");
  console.log(` 삭제 대상 기존 Master 수            : ${targets.length}`);
  console.log(` 유지할 신규 Master 수              : ${keptNew}`);
  console.log(` 유지할 기존 Master 수(동명 없음)    : ${keptOld}`);
  console.log(` 삭제 후 예상 목록 수               : ${afterList}`);
  console.log("");
  console.log(` 삭제 대상 중 FK/과거기록 참조 보유   : ${deactivateTargets.length}`);
  console.log(` 실제 물리삭제 가능 계정 수          : ${hardDeletable.length}`);
  console.log(` 물리삭제 불가 → 비활성화 필요        : ${deactivateTargets.length}`);
  console.log("");
  console.log(" 사유 분포(중복 사유 합산):");
  for (const [why, n] of Object.entries(reasonDist).sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(5)}  ${why}`);
  console.log("");
  console.log(`[Excel] ${outPath}`);
  const report = {
    total_masters: totalMasters, old_masters: olds.length, new_masters: news.length,
    delete_targets: targets.length, kept_new: keptNew, kept_old: keptOld, after_list: afterList,
    targets_with_refs: deactivateTargets.length, hard_deletable: hardDeletable.length, deactivate_needed: deactivateTargets.length,
    reason_distribution: reasonDist, excel_path: outPath,
  };
  console.log("REPORT " + JSON.stringify(report));
  await pool.end().catch(() => {});
  process.exit(0);
}
main().catch(async (e) => { console.error("FATAL", e); try { await pool.end(); } catch { /* ignore */ } process.exit(1); });
