// 통번역사 Master 중복 정리 — 신규 Master 우선 통합 "분석 전용"(DRY-RUN, DB 미변경·통합/삭제 없음).
//  · 원칙: 동일인으로 확인된 기존(진행관리표 생성)·신규(CRM 명부 생성) Master가 있으면, 상세 풍부한 신규를
//    대표로 유지하고 기존은 통합 후 일반목록/선택창에서 제외(단, 과거 ID·통합이력 보존). 미확인 기존은 불변.
//  · 동일인 판정: 성명 일치 + (주민번호13 | 실제이메일 | 휴대폰) 중 1개 이상 공유. @crm-migrated.invalid 제외.
//    주민번호 상충(양쪽 보유·상이)은 별개인으로 간주(귀화 포함, 통합금지).
//  · 참조 관계(이관 대상) = masterDependency.ts 권위목록: tasks / settlements / performance_assignments /
//    payout_round_items · payout_transfers(individual) / legacy_master_mappings + 진행·판매 스냅샷(이름·주민).
//  · 본 스크립트는 '통합 가능/보류 그룹 수·연결정보 이전 방법·예상 최종 Master 수'만 산출한다(요구 8).
import fs from "fs";
import path from "path";
import * as XLSX from "xlsx";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { decrypt } from "./lib/encrypt";
import { normalizeCompanyName } from "./lib/normalizeCompany";
import { normalizePhone, normalizeEmail } from "./lib/hometaxExcel";
import { isLegacyPlaceholderEmail } from "./lib/mailer";

const BATCH = 182;                       // 신규(CRM 명부 재구축) Master 배치
const OUT_DIR = process.env.DEDUP_REPORT_DIR || "/home/runner/veritas-reports";
const rrn13 = (s: unknown) => { const d = String(s ?? "").replace(/[^0-9]/g, ""); return d.length === 13 ? d : null; };
const maskRrn = (r: string | null | undefined) => (r ? `${r.slice(0, 6)}-*******` : "");

type M = {
  id: number; name: string; nameNorm: string; isNew: boolean;
  rrn: string | null; phones: Set<string>; emails: Set<string>; crm: string[];
};

async function main() {
  const rows = (q: any) => (q as any).rows as any[];
  const anyArr = (ids: number[]) => sql.raw(`ARRAY[${ids.join(",")}]::int[]`);

  const newIds = new Set<number>(rows(await db.execute(sql`SELECT entity_id FROM import_row_sources WHERE batch_id=${BATCH}`)).map((r) => Number(r.entity_id)));
  const users = rows(await db.execute(sql`SELECT id, name, email FROM users WHERE role='translator' AND deleted_at IS NULL`));
  const temails = rows(await db.execute(sql`SELECT translator_id tid, email FROM translator_emails`));
  const profiles = rows(await db.execute(sql`SELECT user_id uid, coalesce(phone,'') phone FROM translator_profiles`));
  const sens = rows(await db.execute(sql`SELECT translator_id tid, resident_number rn FROM translator_sensitive`));
  const maps = rows(await db.execute(sql`SELECT entity_id eid, btrim(legacy_id) lid FROM legacy_master_mappings WHERE entity_type='translator' AND status<>'rolled_back'`));

  const M = new Map<number, M>();
  for (const u of users) M.set(Number(u.id), { id: Number(u.id), name: u.name ?? "", nameNorm: normalizeCompanyName(u.name ?? ""), isNew: newIds.has(Number(u.id)), rrn: null, phones: new Set(), emails: new Set(), crm: [] });
  const addEmail = (id: number, raw: string | null | undefined) => { if (!raw || isLegacyPlaceholderEmail(raw)) return; const e = normalizeEmail(raw); if (e) M.get(id)?.emails.add(e); };
  for (const u of users) addEmail(Number(u.id), u.email);
  for (const t of temails) { if (M.has(Number(t.tid))) addEmail(Number(t.tid), t.email); }
  for (const p of profiles) { const m = M.get(Number(p.uid)); if (m) { const ph = normalizePhone(p.phone); if (ph) m.phones.add(ph); } }
  for (const s of sens) { const m = M.get(Number(s.tid)); if (!m) continue; const raw = s.rn ? String(s.rn).trim() : ""; if (!raw) continue; try { const k = rrn13(decrypt(raw)); if (k) m.rrn = k; } catch { /* skip */ } }
  for (const mp of maps) { const m = M.get(Number(mp.eid)); if (m && mp.lid) m.crm.push(String(mp.lid)); }

  // ── 이름 그룹(기존+신규 혼합만 대상) ──
  const byName = new Map<string, number[]>();
  for (const m of M.values()) { if (!m.nameNorm) continue; const a = byName.get(m.nameNorm) ?? []; a.push(m.id); byName.set(m.nameNorm, a); }

  const shareSet = (a: Set<string>, b: Set<string>) => { for (const x of a) if (b.has(x)) return true; return false; };

  type EStatus = "mergeable" | "hold_nameonly" | "hold_conflict" | "hold_multi";
  type EInfo = { e: M; repNew: M | null; basis: string; status: EStatus };
  type GroupInfo = { name: string; nameNorm: string; olds: M[]; news: M[]; eInfos: EInfo[]; mergeableCount: number; status: "mergeable" | "hold"; holdReason: string };

  const groups: GroupInfo[] = [];
  for (const [nameNorm, ids] of byName) {
    const members = ids.map((id) => M.get(id)!);
    const olds = members.filter((m) => !m.isNew);
    const news = members.filter((m) => m.isNew);
    if (olds.length === 0 || news.length === 0) continue;   // 기존+신규 혼합 그룹만(§1)

    const eInfos: EInfo[] = [];
    for (const e of olds) {
      // 신규 후보 중 동일인 확인(주민번호 상충 제외)
      const confirmed: { n: M; basis: string }[] = [];
      let sawConflict = false;
      for (const n of news) {
        if (e.rrn && n.rrn && e.rrn !== n.rrn) { sawConflict = true; continue; }   // 주민번호 상충 → 별개인
        const basis: string[] = [];
        if (e.rrn && n.rrn && e.rrn === n.rrn) basis.push("주민번호");
        if (shareSet(e.emails, n.emails)) basis.push("이메일");
        if (shareSet(e.phones, n.phones)) basis.push("전화");
        if (basis.length) confirmed.push({ n, basis: basis.join("+") });
      }
      let status: EStatus; let repNew: M | null = null; let basis = "";
      if (confirmed.length === 1) { status = "mergeable"; repNew = confirmed[0].n; basis = confirmed[0].basis; }
      else if (confirmed.length > 1) { status = "hold_multi"; basis = `신규 후보 ${confirmed.length}`; }
      else if (sawConflict) { status = "hold_conflict"; basis = "주민번호 상충"; }
      else { status = "hold_nameonly"; basis = "공유 식별자 없음(이름만)"; }
      eInfos.push({ e, repNew, basis, status });
    }
    const mergeableCount = eInfos.filter((x) => x.status === "mergeable").length;
    const status = mergeableCount > 0 ? "mergeable" : "hold";
    let holdReason = "";
    if (status === "hold") {
      const reasons = new Set(eInfos.map((x) => x.status === "hold_conflict" ? "주민번호 상충" : x.status === "hold_multi" ? "다중 신규후보" : "식별정보 부족(이름만)"));
      holdReason = [...reasons].join(", ");
    }
    groups.push({ name: members[0].name, nameNorm, olds, news, eInfos, mergeableCount, status, holdReason });
  }

  const mergeableGroups = groups.filter((g) => g.status === "mergeable");
  const holdGroups = groups.filter((g) => g.status === "hold");
  const mergeableEs = mergeableGroups.flatMap((g) => g.eInfos.filter((x) => x.status === "mergeable"));
  const mergeableEIds = mergeableEs.map((x) => x.e.id);

  // ── 이관 대상 참조 집계(mergeable 기존 Master 기준, 읽기 전용) ──
  const refCount = new Map<number, Record<string, number>>();
  const addRef = (id: number, key: string, n: number) => { const r = refCount.get(id) ?? {}; r[key] = (r[key] ?? 0) + n; refCount.set(id, r); };
  if (mergeableEIds.length > 0) {
    const A = anyArr(mergeableEIds);
    for (const r of rows(await db.execute(sql`SELECT translator_id id, count(*) c FROM tasks WHERE translator_id = ANY(${A}) GROUP BY translator_id`))) addRef(Number(r.id), "task", Number(r.c));
    for (const r of rows(await db.execute(sql`SELECT translator_id id, count(*) c FROM settlements WHERE translator_id = ANY(${A}) GROUP BY translator_id`))) addRef(Number(r.id), "settlement", Number(r.c));
    for (const r of rows(await db.execute(sql`SELECT individual_user_id id, count(*) c FROM performance_assignments WHERE individual_user_id = ANY(${A}) AND deleted_at IS NULL GROUP BY individual_user_id`))) addRef(Number(r.id), "performance", Number(r.c));
    for (const r of rows(await db.execute(sql`SELECT payee_id id, count(*) c FROM payout_round_items WHERE payee_type='individual' AND payee_id = ANY(${A}) GROUP BY payee_id`))) addRef(Number(r.id), "payout_item", Number(r.c));
    for (const r of rows(await db.execute(sql`SELECT payee_id id, count(*) c FROM payout_transfers WHERE payee_type='individual' AND payee_id = ANY(${A}) GROUP BY payee_id`))) addRef(Number(r.id), "payout_transfer", Number(r.c));
    for (const r of rows(await db.execute(sql`SELECT entity_id id, count(*) c FROM legacy_master_mappings WHERE entity_type='translator' AND status<>'rolled_back' AND entity_id = ANY(${A}) GROUP BY entity_id`))) addRef(Number(r.id), "legacy_map", Number(r.c));
  }
  const refOf = (id: number) => refCount.get(id) ?? {};
  const refTotal = (id: number) => Object.values(refOf(id)).reduce((a, b) => a + b, 0);

  // ── 집계 수치 ──
  const totalMasters = M.size;
  const mergeableECount = mergeableEIds.length;               // 통합(숨김) 대상 기존 Master 수
  const projectedFinal = totalMasters - mergeableECount;      // 예상 최종 Master(일반목록 기준)
  const sumRef = (key: string) => mergeableEIds.reduce((a, id) => a + (refOf(id)[key] ?? 0), 0);

  // ── Excel ──
  const wb = XLSX.utils.book_new();
  // 1) 통합 가능 그룹(기존→신규 대표)
  const mAoa: any[][] = [["그룹", "이름", "기존ID", "신규대표ID", "동일인근거", "기존_주민보유", "기존_주민(마스킹)", "기존_전화", "기존_이메일", "기존_CRM연결", "이관_작업", "이관_정산", "이관_수행", "이관_지급회차", "이관_송금", "이관_legacy매핑", "이관_합계"]];
  let gi = 0;
  for (const g of mergeableGroups) {
    gi++;
    for (const x of g.eInfos.filter((y) => y.status === "mergeable")) {
      const e = x.e, r = refOf(e.id);
      mAoa.push([`M${gi}`, g.name, e.id, x.repNew!.id, x.basis, e.rrn ? "O" : "X", maskRrn(e.rrn), [...e.phones][0] ?? "", [...e.emails][0] ?? "", e.crm.slice(0, 3).join(" / "), r.task ?? 0, r.settlement ?? 0, r.performance ?? 0, r.payout_item ?? 0, r.payout_transfer ?? 0, r.legacy_map ?? 0, refTotal(e.id)]);
    }
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mAoa), "1_통합가능");
  // 2) 통합 보류 그룹
  const hAoa: any[][] = [["그룹", "이름", "보류사유", "기존ID들", "신규ID들", "기존수", "신규수"]];
  let hi = 0;
  for (const g of holdGroups) { hi++; hAoa.push([`H${hi}`, g.name, g.holdReason, g.olds.map((m) => m.id).join(", "), g.news.map((m) => m.id).join(", "), g.olds.length, g.news.length]); }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(hAoa), "2_통합보류");
  // 3) 요약
  const summary: any[][] = [
    ["항목", "값"],
    ["전체 Master 수", totalMasters],
    ["  ├ 기존(진행관리표 생성)", [...M.values()].filter((m) => !m.isNew).length],
    ["  └ 신규(CRM 명부/batch 182)", [...M.values()].filter((m) => m.isNew).length],
    ["기존+신규 혼합 이름그룹 수", groups.length],
    ["통합 가능 그룹 수", mergeableGroups.length],
    ["통합 보류 그룹 수", holdGroups.length],
    ["  ├ 식별정보 부족(이름만)", holdGroups.filter((g) => g.holdReason.includes("식별정보")).length],
    ["  ├ 주민번호 상충", holdGroups.filter((g) => g.holdReason.includes("상충")).length],
    ["  └ 다중 신규후보", holdGroups.filter((g) => g.holdReason.includes("다중")).length],
    ["통합(숨김) 대상 기존 Master 수", mergeableECount],
    ["예상 최종 Master 수(일반목록)", projectedFinal],
    ["── 이관 대상 참조 합계(통합 대상 기존) ──", ""],
    ["작업(tasks)", sumRef("task")],
    ["정산(settlements)", sumRef("settlement")],
    ["수행(performance_assignments)", sumRef("performance")],
    ["지급회차(payout_round_items)", sumRef("payout_item")],
    ["송금(payout_transfers)", sumRef("payout_transfer")],
    ["legacy 매핑(legacy_master_mappings)", sumRef("legacy_map")],
    ["작업 성격", "DRY-RUN · DB 미변경 · 통합/삭제 미실행 · 승인 전 쓰기 금지"],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), "3_요약");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const outPath = path.join(OUT_DIR, `translator_merge_analysis_${stamp}.xlsx`);
  XLSX.writeFile(wb, outPath);

  // ── 콘솔 보고 ──
  const oldN = [...M.values()].filter((m) => !m.isNew).length;
  const newN = [...M.values()].filter((m) => m.isNew).length;
  console.log("");
  console.log("════════════════════════════════════════════════════════════════════");
  console.log(" VERITAS 통번역사 Master 중복 정리(신규 우선) — DRY-RUN 분석 보고");
  console.log("════════════════════════════════════════════════════════════════════");
  console.log(` 전체 Master ${totalMasters} (기존 ${oldN} / 신규 ${newN})`);
  console.log(` 기존+신규 혼합 이름그룹 ${groups.length}개`);
  console.log(`   ├ 통합 가능 그룹 : ${mergeableGroups.length}`);
  console.log(`   └ 통합 보류 그룹 : ${holdGroups.length}  (식별부족 ${holdGroups.filter((g) => g.holdReason.includes("식별정보")).length} / 주민상충 ${holdGroups.filter((g) => g.holdReason.includes("상충")).length} / 다중후보 ${holdGroups.filter((g) => g.holdReason.includes("다중")).length})`);
  console.log("");
  console.log(` 통합(숨김) 대상 기존 Master : ${mergeableECount}명`);
  console.log(` 예상 최종 Master(일반목록)   : ${totalMasters} → ${projectedFinal}`);
  console.log("");
  console.log(" 이관 대상 참조 합계(통합 대상 기존 Master 기준):");
  console.log(`   작업 ${sumRef("task")} · 정산 ${sumRef("settlement")} · 수행 ${sumRef("performance")} · 지급회차 ${sumRef("payout_item")} · 송금 ${sumRef("payout_transfer")} · legacy매핑 ${sumRef("legacy_map")}`);
  console.log("");
  console.log(" 통합 가능 그룹 상위 15개(기존ID→신규대표ID · 근거 · 이관참조합계):");
  for (const g of mergeableGroups.slice(0, 15)) {
    for (const x of g.eInfos.filter((y) => y.status === "mergeable")) {
      console.log(`   ${g.name.padEnd(10)} #${x.e.id}(기존) → #${x.repNew!.id}(신규)  [${x.basis}]  참조 ${refTotal(x.e.id)}건`);
    }
  }
  console.log("");
  console.log(`[Excel] ${outPath}`);
  const report = {
    total_masters: totalMasters, mixed_groups: groups.length,
    mergeable_groups: mergeableGroups.length, hold_groups: holdGroups.length,
    hold_nameonly: holdGroups.filter((g) => g.holdReason.includes("식별정보")).length,
    hold_conflict: holdGroups.filter((g) => g.holdReason.includes("상충")).length,
    hold_multi: holdGroups.filter((g) => g.holdReason.includes("다중")).length,
    merge_target_old_masters: mergeableECount, projected_final_masters: projectedFinal,
    refs: { task: sumRef("task"), settlement: sumRef("settlement"), performance: sumRef("performance"), payout_item: sumRef("payout_item"), payout_transfer: sumRef("payout_transfer"), legacy_map: sumRef("legacy_map") },
    excel_path: outPath,
  };
  console.log("REPORT " + JSON.stringify(report));
  await pool.end().catch(() => {});
  process.exit(0);
}
main().catch(async (e) => { console.error("FATAL", e); try { await pool.end(); } catch { /* ignore */ } process.exit(1); });
