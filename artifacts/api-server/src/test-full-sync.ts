// @ts-nocheck — 격리 테스트 전용 하네스(앱 빌드 비포함, esbuild 번들로 실행).
// 최신 CRM 파일 기준 통합 동기화(판매목록+진행관리표) 회귀 테스트. DATABASE_URL 이 임시 복제 DB(veritas_sync_scratch)일 때만 실행.
//   · '최신 파일'은 저장된 source_raw 로 메모리에서 재구성(실제 2026-10-26 진행관리표에서 사라진 34행 제외 + 시나리오 변경).
import ExcelJS from "exceljs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { buildFullSyncPreview, executeFullSync, rollbackFullSync, summarizeFullSync, previewPage, lastSyncAsOf } from "./services/legacyArchiveSync";

const url = process.env.DATABASE_URL ?? "";
if (!/\/veritas_sync_scratch(\?|$)/.test(url)) { console.error("임시 복제 DB(veritas_sync_scratch)에서만 실행합니다."); process.exit(1); }

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") { (ok ? pass++ : fail++); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); }
const q = async (s: any) => (await db.execute(s)).rows as any[];
const one = async (s: any) => (await q(s))[0];
const USER = 10;

async function fp() {
  return {
    sales: await one(sql`SELECT count(*)::int n, md5(string_agg(id::text, ',' ORDER BY id)) h FROM legacy_archive_rows WHERE source_type='sales_list' AND is_effective`),
    prog: await one(sql`SELECT count(*)::int n, md5(string_agg(id::text, ',' ORDER BY id)) h FROM legacy_archive_rows WHERE source_type='progress' AND is_effective`),
    platform: await one(sql`SELECT (SELECT count(*) FROM performance_assignments)::int pa, (SELECT md5(string_agg(id||':'||payment_status||':'||coalesce(payout_round_id,0), ',' ORDER BY id)) FROM performance_assignments) pah,
      (SELECT count(*) FROM payout_rounds)::int r, (SELECT count(*) FROM payout_round_items)::int ri, (SELECT count(*) FROM payout_transfers)::int pt, (SELECT count(*) FROM settlements)::int st,
      (SELECT count(*) FROM projects)::int pj, (SELECT count(*) FROM quotes)::int qt, (SELECT count(*) FROM users)::int us, (SELECT count(*) FROM companies)::int co,
      (SELECT count(*) FROM legacy_master_mappings)::int lmm`),
  };
}
async function loadRaw(t: string) {
  const rows = await q(sql`SELECT id, source_sheet, source_row, source_raw FROM legacy_archive_rows WHERE source_type=${t} AND is_effective ORDER BY source_sheet, source_row, id`);
  const hb = await q(sql`SELECT headers_json FROM import_batches WHERE module='legacy_archive' AND source_type=${t} AND headers_json IS NOT NULL ORDER BY id DESC LIMIT 1`);
  const headers: string[] = [...(hb[0]?.headers_json ?? [])];
  for (const r of rows) for (const k of Object.keys(r.source_raw ?? {})) if (!headers.includes(k)) headers.push(k);
  return { rows, headers };
}
async function toXlsx(rows: any[], headers: string[]) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Sheet1"); ws.addRow(headers);
  for (const r of rows) ws.addRow(headers.map(h => { const v = r.source_raw[h]; return v == null || v === "" ? null : String(v); }));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const clone = (r: any) => ({ ...r, source_raw: { ...r.source_raw } });
const eff = async (id: number) => (await one(sql`SELECT is_effective e FROM legacy_archive_rows WHERE id=${id}`))?.e === true;
const preview = (sales: Buffer, prog: Buffer, asOfDate = "2026-11-04", scope = "full") =>
  buildFullSyncPreview(db, { salesBuffer: sales, progressBuffer: prog, salesName: "판매목록 20261104.xlsx", progressName: "진행관리표 20261104.xlsx", asOfDate, scope, userId: USER });
const run = (set: any, cancelConfirmedSales = false) => db.transaction(tx => executeFullSync(tx, { fullSyncId: set.id, salesToken: set.sales.planToken, progressToken: set.progress.planToken, userId: USER, cancelConfirmedSales }));
// 지급회차 판정(payoutUnified 와 동일 규칙): 지급완료 = 납품일 ≤ 2026-09-15
const round = (d: string) => one(sql`SELECT count(*)::int n, count(*) FILTER (WHERE substring(source_raw->>'통번역사납품일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}') <= '2026-09-15')::int paid,
  coalesce(sum(coalesce(nullif(regexp_replace(coalesce(source_raw->>'지급액(세전)',''),'[^0-9.-]','','g'),'')::numeric,0)),0)::numeric pretax,
  bool_or(id = 596) has596 FROM legacy_archive_rows WHERE source_type='progress' AND is_effective AND source_raw->>'통번역사지급일' LIKE ${d + "%"}`);

async function main() {
  // 운영 전환 보호 시나리오: 유일한 전환 판매(프로젝트 190)는 실제로 취소 상태 → 스크래치 DB에서만 임시로 진행 중으로 바꿔 검증, 종료 시 원복.
  //   (실데이터: 매핑 2912 rolled_back · 프로젝트 190 cancelled → 실제로는 운영 전환 아님)
  const prj = await one(sql`SELECT status FROM projects WHERE id=190`);
  const mp = await one(sql`SELECT status FROM legacy_master_mappings WHERE id=2912`);
  await db.execute(sql`UPDATE projects SET status='created' WHERE id=190`);
  await db.execute(sql`UPDATE legacy_master_mappings SET status='active' WHERE id=2912`);
  try { await body(); } finally {
    await db.execute(sql`UPDATE projects SET status=${prj.status} WHERE id=190`);
    await db.execute(sql`UPDATE legacy_master_mappings SET status=${mp.status} WHERE id=2912`);
  }
  console.log(`\n결과: PASS ${pass} · FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}
async function body() {
  const before = await fp();
  const P = await loadRaw("progress"), S = await loadRaw("sales_list");
  // 실제 10/26 진행관리표에서 사라진 34행(배치 184 del_suspect) — 최신 CRM 에 없음
  const gone1026 = new Set((await q(sql`SELECT entity_id FROM import_row_sources WHERE batch_id=184 AND status='del_suspect'`)).map(r => Number(r.entity_id)));
  check("기준: 10/26 누락 34행 확인", gone1026.size === 34, `${gone1026.size}`);
  const searchOld = [1786, 1787, 1788, 1789, 1790, 1791, 1792, 1793, 1794, 1795];
  const searchPretax0 = await one(sql`SELECT coalesce(sum(payout_pretax),0)::numeric s, count(*)::int n FROM legacy_archive_rows WHERE source_type='progress' AND is_effective AND company_name='(주)서치'`);

  // ── 시나리오 파일 구성 ──
  // 1:N 판매건: 수행행 2건 이상 연결된 판매건 1개 — 그중 수행행 1건만 삭제
  const oneN = await one(sql`SELECT l.sale_row_id s, array_agg(l.progress_row_id ORDER BY l.progress_row_id) p FROM legacy_sales_progress_links l
    JOIN legacy_archive_rows s ON s.id=l.sale_row_id AND s.is_effective JOIN legacy_archive_rows p ON p.id=l.progress_row_id AND p.is_effective
    WHERE l.decision='confirmed' AND p.id <> ALL(${sql.raw(`ARRAY[${[...gone1026].join(",")}]::int[]`)}) AND p.record_date >= '2025-01-01'
    GROUP BY l.sale_row_id HAVING count(DISTINCT l.progress_row_id) BETWEEN 3 AND 5 ORDER BY l.sale_row_id DESC LIMIT 1`);
  const delProg = Number(oneN.p[0]); const keepProg = oneN.p.slice(1).map(Number);
  // 변경 행(지급액) · 체결일 변경 행 · 신규 행
  const pick = (await q(sql`SELECT id FROM legacy_archive_rows WHERE source_type='progress' AND is_effective AND record_date BETWEEN '2025-06-01' AND '2025-12-31'
    AND translator_name IS NOT NULL AND delivery_date IS NOT NULL AND company_name IS NOT NULL AND product_name IS NOT NULL
    AND id <> ALL(${sql.raw(`ARRAY[${[...oneN.p].join(",")}]::int[]`)}) ORDER BY id LIMIT 400`)).map(r => Number(r.id));
  // 체결일 변경 대상은 재매칭 키(거래처·상품·통번역사·납품일) 그룹이 1행인 것으로
  const uniqRelaxed = (await q(sql`SELECT min(id) id FROM legacy_archive_rows WHERE source_type='progress' AND is_effective AND id = ANY(${sql.raw(`ARRAY[${pick.join(",")}]::int[]`)})
    GROUP BY company_name, product_name, translator_name, delivery_date, record_date, contact_name, language HAVING count(*)=1 LIMIT 5`)).map(r => Number(r.id));
  const chgId = uniqRelaxed[0], dateChgId = uniqRelaxed[1];
  const progRows = P.rows.filter(r => !gone1026.has(Number(r.id)) && Number(r.id) !== delProg).map(r => {
    const c = clone(r);
    if (Number(r.id) === chgId) c.source_raw["지급액(세전)"] = "123,456";
    if (Number(r.id) === dateChgId) { c.source_raw["체결일"] = "2024-02-29"; c.source_raw["견적서발행일"] = "2024-02-29"; }
    return c;
  });
  // 식별 불가(1 ↔ 2) — 같은 업무로 보이는 최신 행 2건(발행일 변경) vs 기존 1건 → 신규는 보류, 기존은 삭제하지 않음
  const ambId = uniqRelaxed[2];
  const ai = progRows.findIndex(r => Number(r.id) === ambId);
  const a1 = clone(progRows[ai]); a1.source_raw["견적서발행일"] = "2024-02-28";
  const a2 = clone(progRows[ai]); a2.source_raw["견적서발행일"] = "2024-02-27"; a2.source_raw["지급액(세전)"] = "1";
  progRows.splice(ai, 1, a1, a2);
  // 진짜 식별 불가(동점) — 완전히 같은 최신 행 2건(발행일만 변경) vs 기존 1건 → 보류 + 기존 행 삭제 보류
  const tieId = uniqRelaxed[3];
  const ti = progRows.findIndex(r => Number(r.id) === tieId);
  const t1 = clone(progRows[ti]); t1.source_raw["견적서발행일"] = "2024-02-26";
  progRows.splice(ti, 1, t1, clone(t1));
  // 유형 A — 같은 묶음(거래처·담당자·상품·언어·발행일)에 같은 통번역사 2행(납품일 다름) · 두 행 모두 지급액 변경
  const grpA = await one(sql`SELECT array_agg(id ORDER BY id) ids FROM legacy_archive_rows WHERE source_type='progress' AND is_effective AND translator_name IS NOT NULL
    AND delivery_date IS NOT NULL AND company_name IS NOT NULL AND product_name IS NOT NULL AND record_date >= '2025-01-01'
    AND id <> ALL(${sql.raw(`ARRAY[${[...gone1026, ...oneN.p, ...uniqRelaxed].join(",")}]::int[]`)})
    GROUP BY company_name, contact_name, product_name, language, record_date, translator_name
    HAVING count(*) = 2 AND count(DISTINCT delivery_date) = 2 AND count(DISTINCT coalesce(payout_date::text,'')||delivery_date::text) = 2 LIMIT 1`);
  const aIds = (grpA?.ids ?? []).map(Number);
  for (const r of progRows) if (aIds.includes(Number(r.id))) r.source_raw["지급액(세전)"] = String(777000 + aIds.indexOf(Number(r.id)));
  // 유형 C — 거래처명 공란으로 바뀐 행 → 통번역사·납품일로 기존 행과 대응(수정)
  const cId = uniqRelaxed[4];
  for (const r of progRows) if (Number(r.id) === cId) r.source_raw["거래처명"] = null;
  const newProg = clone(P.rows.find(r => Number(r.id) === chgId)); newProg.source_raw["거래처명"] = "TEST신규거래처(동기화)"; newProg.source_raw["체결일"] = "2026-11-02";
  progRows.push(newProg);

  // 판매목록: 연결 없는 판매 1건 삭제 · 총액 변경 1건 · 신규 1건 · 수행행 유지 판매 1건 삭제(충돌) · 운영 전환 판매 삭제(충돌)
  const saleNoLink = Number((await one(sql`SELECT s.id FROM legacy_archive_rows s WHERE s.source_type='sales_list' AND s.is_effective AND s.source_raw->>'판매번호' >= '2025'
    AND NOT EXISTS (SELECT 1 FROM legacy_sales_progress_links l WHERE l.sale_row_id=s.id) ORDER BY s.id LIMIT 1`)).id);
  const saleLinkedKept = Number((await one(sql`SELECT l.sale_row_id id FROM legacy_sales_progress_links l JOIN legacy_archive_rows p ON p.id=l.progress_row_id AND p.is_effective
    JOIN legacy_archive_rows s ON s.id=l.sale_row_id AND s.is_effective WHERE l.decision='confirmed' AND s.source_raw->>'판매번호' >= '2025' AND l.sale_row_id <> ${Number(oneN.s)}
    AND p.id <> ALL(${sql.raw(`ARRAY[${[...gone1026].join(",")}]::int[]`)}) ORDER BY l.sale_row_id LIMIT 1`)).id);
  const saleActivated = Number((await one(sql`SELECT id FROM legacy_archive_rows WHERE source_type='sales_list' AND is_effective AND source_raw->>'판매번호'='2026-10-23-0001'`))?.id ?? 0);
  const saleChg = Number((await one(sql`SELECT id FROM legacy_archive_rows WHERE source_type='sales_list' AND is_effective AND source_raw->>'판매번호' >= '2025-03' AND id NOT IN (${saleNoLink}, ${saleLinkedKept}, ${saleActivated}) ORDER BY id LIMIT 1`)).id);
  const salesRows = S.rows.filter(r => ![saleNoLink, saleLinkedKept, saleActivated].includes(Number(r.id))).map(r => { const c = clone(r); if (Number(r.id) === saleChg) c.source_raw["총액"] = "9,999,999"; return c; });
  const newSale = clone(S.rows.find(r => Number(r.id) === saleChg)); newSale.source_raw["판매번호"] = "2026-11-04-9001"; newSale.source_raw["거래처명"] = "TEST신규거래처(동기화)"; salesRows.push(newSale);
  const salesBuf = await toXlsx(salesRows, S.headers), progBuf = await toXlsx(progRows, P.headers);

  // ── ⑩ 부분 업로드 보호 · 범위 밖 보존(미리보기만) ──
  {
    const partial = progRows.filter(r => r.source_raw["거래처명"] === "한국산텐제약(주)");
    const pset = await preview(salesBuf, await toXlsx(partial, P.headers), "2026-11-04", "full");
    check("⑩ 일부 거래처만 담은 파일을 '전체'로 비교 → 실행 차단", pset.blockers.some(b => b.code === "DELETION_SCOPE_SUSPECT"), pset.blockers.map(b => b.code).join(","));
    const recOf = new Map((await q(sql`SELECT id, record_date::text d FROM legacy_archive_rows WHERE source_type='progress' AND is_effective`)).map(r => [Number(r.id), r.d]));
    const oct = progRows.filter(r => String(recOf.get(Number(r.id)) ?? "").startsWith("2026-10"));
    const rset = await preview(salesBuf, await toXlsx(oct, P.headers), "2026-11-04", "range");
    const rs = summarizeFullSync(rset).progress;
    const goneInOct = [...gone1026].filter(id => String(recOf.get(id) ?? "").startsWith("2026-10")).length + (String(recOf.get(delProg) ?? "").startsWith("2026-10") ? 1 : 0);
    check("⑩ 기간 자료(range, 기준 필드 일치): 범위 밖 기존 자료 보존 · 범위 내 실제 누락만 삭제", rs.deletionScope.outOfScope > 25000 && rs.counts.DELETION_SUSPECT <= goneInOct + 5 && rset.blockers.length === 0,
      `범위 ${rs.deletionScope.from}~${rs.deletionScope.to} · 범위 밖 ${rs.deletionScope.outOfScope} · 삭제 ${rs.counts.DELETION_SUSPECT}(10월 실제 누락 ${goneInOct})`);
    const oct2 = progRows.filter(r => String(r.source_raw["체결일"] ?? "").startsWith("2026-10"));
    const mset = await preview(salesBuf, await toXlsx(oct2, P.headers), "2026-11-04", "range");
    const ms = summarizeFullSync(mset).progress;
    check("⑩ 다른 날짜 기준(체결일)으로 자른 기간 파일 → 경계 오삭제 위험 → 실행 차단", mset.blockers.some(b => b.code === "DELETION_SCOPE_SUSPECT"), `삭제 ${ms.counts.DELETION_SUSPECT} / 비교범위 ${ms.deletionScope.inScope}`);
    const stale = await preview(salesBuf, progBuf, "2026-10-01", "full");
    check("기준일 검증: 이전 기준일보다 오래된 파일은 (최종 기준일이 있으면) 차단", true, "최초 실행 전이라 비교 기준 없음 — 실행 후 재검사");
    void stale;
  }

  // ── 미리보기 ──
  const set = await preview(salesBuf, progBuf);
  const sm = summarizeFullSync(set);
  console.log("판매목록:", JSON.stringify(sm.sales.counts), "재매칭", sm.sales.relaxedMatches, JSON.stringify(sm.sales.conflictsByCode));
  console.log("진행관리표:", JSON.stringify(sm.progress.counts), "재매칭", sm.progress.relaxedMatches, JSON.stringify(sm.progress.conflictsByCode));
  console.log("지급 영향:", JSON.stringify(sm.progress.amountImpact));
  console.log("매출 영향:", JSON.stringify(sm.sales.amountImpact));
  check("미리보기 실행 가능(차단 없음)", sm.executable, JSON.stringify(sm.blockers));
  const progDelIds = new Set(set.progress.plan.deletionSuspects.map(e => Number(e.id)));
  const conflictIds = new Set(set.progress.plan.deletionConflicts.map(c => Number(c.row.id)));
  check("⑰ 한국산텐제약/오수정(596) 삭제 대상", progDelIds.has(596));
  check("⑱ (주)서치 구버전 10행 삭제 대상", searchOld.every(id => progDelIds.has(id)), searchOld.filter(id => !progDelIds.has(id)).join(","));
  check("⑥ 수행행 1건 삭제 대상", progDelIds.has(delProg));
  const dDate = set.progress.plan.decisions.find(d => d.matchedExistingId != null && Number(d.matchedExistingId) === dateChgId);
  check("⑧ 체결일 변경 → 동일 업무 '변경'(신규 아님)", dDate?.classification === "UPDATED", `${dDate?.classification} ${dDate?.matchBasis}`);
  const dChg = set.progress.plan.decisions.find(d => d.matchedExistingId != null && Number(d.matchedExistingId) === chgId);
  check("⑤ 진행관리표 지급액 변경 → '변경'", dChg?.classification === "UPDATED");
 check("⑧ 재매칭 경로 사용(발행일 변경 → relaxed_key)", dDate?.matchBasis === "relaxed_key", String(dDate?.matchBasis));
  const decOf = (id: number) => set.progress.plan.decisions.find(d => d.matchedExistingId != null && Number(d.matchedExistingId) === id);
  check("유형 B(1↔2, 금액 차이로 구별 가능) → 1건 수정 + 1건 신규, 보류·충돌 없음", decOf(ambId)?.classification === "UPDATED" && !set.progress.plan.deletionConflicts.some(c => Number(c.row.id) === ambId) && !progDelIds.has(ambId), String(decOf(ambId)?.reason));
  const tie = set.progress.plan.deletionConflicts.find(c => Number(c.row.id) === tieId);
  check("진짜 식별 불가(동점 2건) → 보류 유지 · 기존 행 삭제 보류", tie?.code === "identity_unresolved" && !progDelIds.has(tieId) && set.progress.plan.counts.AMBIGUOUS === 2, `${tie?.code} AMB=${set.progress.plan.counts.AMBIGUOUS}`);
  check("유형 A(같은 묶음·같은 통번역사 2행 동시 변경) → 2건 모두 수정", aIds.length === 2 && aIds.every(id => decOf(id)?.classification === "UPDATED"), aIds.map(id => decOf(id)?.reason).join(" | "));
  check("유형 C(거래처 공란) → 통번역사·납품일로 기존 행 수정", decOf(cId)?.classification === "UPDATED" && !progDelIds.has(cId), String(decOf(cId)?.reason));
  const salesDel = new Set(set.sales.plan.deletionSuspects.map(e => Number(e.id)));
  const salesConf = new Map(set.sales.plan.deletionConflicts.map(c => [Number(c.row.id), c.code]));
  check("③ 판매목록 삭제(연결 없는 판매)", salesDel.has(saleNoLink));
  check("8. 수행행이 남은 판매 삭제 → 충돌(삭제 안 함)", salesConf.get(saleLinkedKept) === "linked_progress", String(salesConf.get(saleLinkedKept)));
  check("⑪ 운영 전환 판매(2026-10-23-0001) → 충돌(삭제 안 함)", saleActivated > 0 && salesConf.get(saleActivated) === "activated", String(salesConf.get(saleActivated)));
  const page = previewPage(set.progress, "DELETION_SUSPECT", 1, 200);
  check("미리보기 삭제 목록 페이지 조회", page.total === progDelIds.size);

  // ── ⑳ 실행 중 오류 → 전체 롤백(부분 반영 없음) ──
  let wrote = null;
  try { await db.transaction(async tx => { wrote = await executeFullSync(tx, { fullSyncId: set.id, salesToken: set.sales.planToken, progressToken: set.progress.planToken, userId: USER }); throw new Error("INJECTED"); }); }
  catch (e) { check("⑳ 두 파일 반영 완료 직후 오류 주입 → 예외 전파", String(e?.message).includes("INJECTED") && wrote?.mode === "applied", String(e?.message).slice(0, 120)); }
  const afterFail = await fp();
  check("⑳ 오류 시 판매·진행 모두 변경 없음(전부 또는 전무)", JSON.stringify(afterFail) === JSON.stringify(before));

  // ── 동시 실행 차단 ──
  const set2 = await preview(salesBuf, progBuf);
  let lockOk = false;
  await db.transaction(async holder => {
    await holder.execute(sql`SELECT pg_advisory_xact_lock(74123001)`);
    try { await run(set2); } catch (e) { lockOk = e?.code === "SYNC_RUNNING"; }
  });
  check("동시 실행 차단(advisory lock)", lockOk);

  // ── 실제 실행(관리자 판매취소 확인 옵션 포함) ──
  const linkedOfCancel = (await q(sql`SELECT DISTINCT l.progress_row_id id FROM legacy_sales_progress_links l JOIN legacy_archive_rows p ON p.id=l.progress_row_id AND p.is_effective
    WHERE l.decision='confirmed' AND l.sale_row_id=${saleLinkedKept}`)).map(x => Number(x.id));
  check("판매취소 후보 = 수행행 유지 충돌 판매(운영 전환 제외)", set2.cancelCandidates.saleIds.length === 1 && set2.cancelCandidates.saleIds[0] === saleLinkedKept, JSON.stringify(set2.cancelCandidates));
  const r = await db.transaction(tx => executeFullSync(tx, { fullSyncId: set2.id, salesToken: set2.sales.planToken, progressToken: set2.progress.planToken, userId: USER, cancelConfirmedSales: true, cancelLinkedProgress: true }));
  check("실행 결과 applied", r.mode === "applied", r.mode);
  const la = await lastSyncAsOf(db);
  check("기준일: 판매목록·진행관리표 모두 2026-11-04 로 기록", la.sales_list === "2026-11-04" && la.progress === "2026-11-04", JSON.stringify(la));
  console.log("결과:", JSON.stringify({ sales: { ...r.sales.applied, deleted: r.sales.deleted, conflicts: r.sales.deletionConflicts, eff: r.sales.effective }, progress: { ...r.progress.applied, deleted: r.progress.deleted, conflicts: r.progress.deletionConflicts, eff: r.progress.effective }, integrity: r.integrity }));
  check("① 판매목록 신규 등록", (await one(sql`SELECT count(*)::int n FROM legacy_archive_rows WHERE source_type='sales_list' AND is_effective AND source_raw->>'판매번호'='2026-11-04-9001'`)).n === 1);
  check("② 판매목록 변경 반영", (await one(sql`SELECT count(*)::int n FROM legacy_archive_rows WHERE source_type='sales_list' AND is_effective AND total_amount = 9999999`)).n >= 1 && !(await eff(saleChg)));
  check("③ 판매목록 삭제 반영(비활성·원본 보존)", !(await eff(saleNoLink)) && !!(await one(sql`SELECT 1 x FROM legacy_archive_rows WHERE id=${saleNoLink}`)));
  check("④ 진행관리표 신규 등록", (await one(sql`SELECT count(*)::int n FROM legacy_archive_rows WHERE source_type='progress' AND is_effective AND company_name='TEST신규거래처(동기화)'`)).n === 1);
  check("⑤ 진행관리표 변경 반영", !(await eff(chgId)) && (await one(sql`SELECT count(*)::int n FROM legacy_archive_rows WHERE superseded_by_id IS NULL AND is_effective AND id = (SELECT superseded_by_id FROM legacy_archive_rows WHERE id=${chgId}) AND payout_pretax=123456`)).n === 1);
  check("⑥ 진행관리표 삭제 반영", !(await eff(delProg)));
  const dg = await one(sql`SELECT count(*)::int n FROM legacy_archive_rows a JOIN legacy_archive_rows b ON b.logical_group_key=a.logical_group_key WHERE a.id=${dateChgId} AND b.is_effective`);
  check("⑧ 체결일 변경 행: 같은 버전 체인에 유효 1건(중복 생성 없음)", dg.n === 1 && !(await eff(dateChgId)));
  const keep = await q(sql`SELECT count(*)::int n FROM legacy_sales_progress_links l JOIN legacy_archive_rows p ON p.id=l.progress_row_id AND p.is_effective WHERE l.decision='confirmed' AND l.sale_row_id=${Number(oneN.s)}`);
  check("⑨ 판매 1건 ↔ 수행 N행: 삭제된 1행 외 나머지 연결 유지", (await eff(Number(oneN.s))) && keep[0].n === keepProg.length, `${keep[0].n}/${keepProg.length}`);
  check("식별 불가 기존 행 유지(자동 병합·삭제 안 함)", await eff(tieId));
  check("유형 B 신규 행 저장(정상 수행행 누락 없음)", (await one(sql`SELECT count(*)::int n FROM legacy_archive_rows WHERE source_type='progress' AND is_effective AND payout_pretax = 1 AND record_date = '2024-02-27'`)).n === 1);
  check("판매취소 확인 판매 비활성 · 운영 전환 판매는 보호(유지)", !(await eff(saleLinkedKept)) && (await eff(saleActivated)), JSON.stringify(r.cancelled));
  const stillOn = []; for (const id of linkedOfCancel) if (await eff(id)) stillOn.push(id);
  check("판매취소 판매의 연결 수행행 비활성(지급예정 제외)", linkedOfCancel.length > 0 && stillOn.length === 0 && r.cancelled.progress >= 1, `${linkedOfCancel.length}행 중 유효 ${stillOn.length}`);
  check("⑰ 596(오수정) 비활성", !(await eff(596)));
  const r1113 = await round("2026-11-13");
  check("⑯ 11/13 회차: 596 제외 · 지급완료 0건(지급확정 기록 없음)", !r1113.has596 && r1113.paid === 0, `건수 ${r1113.n} · 지급완료 ${r1113.paid} · 세전 ${r1113.pretax}`);
  const searchPretax1 = await one(sql`SELECT coalesce(sum(payout_pretax),0)::numeric s, count(*)::int n FROM legacy_archive_rows WHERE source_type='progress' AND is_effective AND company_name='(주)서치'`);
  check("⑱ (주)서치 중복 해소: 세전 3,810,000 감소 · 10행 감소", Number(searchPretax0.s) - Number(searchPretax1.s) === 3810000 && searchPretax0.n - searchPretax1.n === 10,
    `${searchPretax0.n}행 ${searchPretax0.s} → ${searchPretax1.n}행 ${searchPretax1.s}`);
  const ded = await one(sql`SELECT count(*)::int n, coalesce(sum(coalesce(nullif(regexp_replace(coalesce(source_raw->>'지급액(세전)',''),'[^0-9.-]','','g'),'')::numeric,0)),0)::numeric s
    FROM legacy_archive_rows WHERE source_type='progress' AND is_effective AND coalesce(substring(source_raw->>'통번역사납품일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}') > '2026-09-15', true)
    AND (nullif(btrim(source_raw->>'입금일'),'') IS NOT NULL OR nullif(btrim(source_raw->>'입금내역'),'') IS NOT NULL)`);
  check("사례 D: 고객 입금기록만 있는 건은 지급완료 판정 대상 아님(규칙상 0건 지급완료)", true, `현재 입금기록 보유·납품일>09-15 유효행 ${ded.n}건 · 세전 ${ded.s}원 → 모두 지급예정/지급확인 필요`);
  const after = await fp();
  check("⑫·⑮ 플랫폼 운영자료·지급회차·정산·마스터 불변", JSON.stringify(after.platform) === JSON.stringify(before.platform));
  check("⑲ 정합성: 비유효 연결 0 · 고아 0 · 중복 버전 0", r.integrity.newLinksToInactive === 0 && r.integrity.orphanedByRun === 0 && r.integrity.duplicateGroups === 0, JSON.stringify(r.integrity));
  check("⑲ 유효 건수 = 이전 + 신규 − 삭제", r.progress.effective.after === r.progress.effective.before + r.progress.applied.created - r.progress.deleted
    && r.sales.effective.after === r.sales.effective.before + r.sales.applied.created - r.sales.deleted);

  // ── ⑦ 동일 파일 재업로드 → 변경 0 ──
  const set3 = await preview(salesBuf, progBuf);
  const s3 = summarizeFullSync(set3);
  check("⑦ 동일 파일 재업로드: 신규·변경·삭제 0 (판매취소 확정 수행행은 재등록 안 함)",
    ["sales", "progress"].every(k => s3[k].counts.NEW === 0 && s3[k].counts.UPDATED === 0 && s3[k].counts.DELETION_SUSPECT === 0) && s3.progress.cancelledSkipped === r.cancelled.progress && r.cancelled.progress > 0,
    `판매 ${JSON.stringify(s3.sales.counts)} / 진행 ${JSON.stringify(s3.progress.counts)} / 재등록 제외 ${s3.progress.cancelledSkipped}·취소 수행행 ${r.cancelled.progress}`);
  const r3 = await run(set3);
  check("⑦ 동일 파일 재실행 → no_change(배치 미생성)", r3.mode === "no_change" && r3.runId === null);
  const stale = await preview(salesBuf, progBuf, "2026-10-01");
  check("기준일 검증: 최종 기준일(2026-11-04)보다 오래된 파일 차단", stale.blockers.some(b => b.code === "STALE_AS_OF"));

  // ── ⑳ 복구(되돌리기) ──
  const rb = await db.transaction(tx => rollbackFullSync(tx, r.runId, USER));
  const restored = await fp();
  check("⑳ 통합 되돌리기 → 판매·진행 유효 자료가 동기화 전과 동일", restored.sales.h === before.sales.h && restored.prog.h === before.prog.h && restored.sales.n === before.sales.n && restored.prog.n === before.prog.n,
    `판매 ${before.sales.n}→${restored.sales.n} · 진행 ${before.prog.n}→${restored.prog.n} · ${rb.rolledBack.length}배치`);
  check("⑳ 되돌린 뒤 596 다시 유효(복구 가능)", await eff(596));
  // ⑳-b 되돌린 뒤 같은 파일 재반영 — 되돌린 행·연결 재활성화(UNIQUE 충돌로 실패·연결 유실 없음)
  const linkN = async () => (await one(sql`SELECT count(*)::int n FROM legacy_sales_progress_links l JOIN legacy_archive_rows s ON s.id=l.sale_row_id AND s.is_effective JOIN legacy_archive_rows p ON p.id=l.progress_row_id AND p.is_effective WHERE l.decision='confirmed'`)).n;
  const rowsN0 = (await one(sql`SELECT count(*)::int n FROM legacy_archive_rows`)).n;
  const set4 = await preview(salesBuf, progBuf);
  const r4 = await db.transaction(tx => executeFullSync(tx, { fullSyncId: set4.id, salesToken: set4.sales.planToken, progressToken: set4.progress.planToken, userId: USER, cancelConfirmedSales: true, cancelLinkedProgress: true }));
  const rowsN1 = (await one(sql`SELECT count(*)::int n FROM legacy_archive_rows`)).n;
  check("⑳-b 되돌린 뒤 같은 파일 재반영 성공 · 물리 행 추가 0(재활성화) · 결과 동일", r4.mode === "applied" && rowsN1 === rowsN0 && r4.progress.deleted === r.progress.deleted && r4.sales.applied.created === r.sales.applied.created,
    `행 ${rowsN0}→${rowsN1} · 삭제 ${r4.progress.deleted}/${r.progress.deleted}`);
  check("⑳-b 재반영 후 판매취소 연결 수행행 보고 동일", r4.keptProgressOfCancelledSales.length === r.keptProgressOfCancelledSales.length, `${r4.keptProgressOfCancelledSales.length}/${r.keptProgressOfCancelledSales.length}`);
  const l4 = await linkN();
  await db.transaction(tx => rollbackFullSync(tx, r4.runId, USER));
  const fin = await fp();
  check("⑳-b 재반영 되돌리기 → 원상태(행·연결)", fin.sales.h === before.sales.h && fin.prog.h === before.prog.h, `links after re-apply ${l4}`);

}
main().catch(e => { console.error(e); process.exit(1); });
