// @ts-nocheck — 격리 테스트 전용 하네스(앱 빌드 비포함). 진행관리표 전체 기간 재업로드 대비 검증.
// DATABASE_URL 이 임시 복제 DB(veritas_sync_scratch)일 때만 실행. 원본 Excel 은 저장된 source_raw 로 메모리에서 재구성.
import ExcelJS from "exceljs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { buildSyncPreview, summarizePreview, previewPage, executeArchiveSync, executeBatchRollback, cachePreview } from "./services/legacyArchiveSync";

if (!/\/veritas_sync_scratch(\?|$)/.test(process.env.DATABASE_URL ?? "")) { console.error("임시 복제 DB(veritas_sync_scratch)에서만 실행합니다."); process.exit(1); }
let pass = 0, fail = 0; const T0 = Date.now(); const timings: string[] = [];
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} [${((Date.now() - T0) / 1000).toFixed(0)}s] ${n}${d ? ` — ${d}` : ""}`); };
const one = async (s: any) => ((await db.execute(s)).rows as any[])[0];
const storage = () => one(sql`SELECT (SELECT count(*) FROM legacy_archive_rows)::int rows, (SELECT count(*) FILTER (WHERE is_effective) FROM legacy_archive_rows)::int eff, (SELECT count(*) FROM import_batches)::int b, (SELECT count(*) FROM legacy_sales_progress_links WHERE decision='confirmed')::int links, (SELECT coalesce(sum(payout_pretax),0)::text FROM legacy_archive_rows WHERE source_type='progress' AND is_effective) payout`);

async function main() {
  const rows = (await db.execute(sql`SELECT id, source_sheet, source_raw, record_date::text rd FROM legacy_archive_rows WHERE source_type='progress' AND is_effective ORDER BY source_sheet, source_row, id`)).rows as any[];
  const headers: string[] = []; for (const r of rows) for (const k of Object.keys(r.source_raw)) if (!headers.includes(k)) headers.push(k);
  const build = async (list: any[], hdr: string[], extra?: (raw: any) => any) => {
    const wb = new ExcelJS.Workbook(); const m = new Map();
    for (const r of list) { const a = m.get(r.source_sheet) ?? []; a.push(extra ? extra(r.source_raw) : r.source_raw); m.set(r.source_sheet, a); }
    for (const [n, rs] of m) { const ws = wb.addWorksheet(n); ws.addRow(hdr); for (const raw of rs) ws.addRow(hdr.map(h => raw[h] == null || raw[h] === "" ? null : String(raw[h]))); }
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  const S0 = await storage();

  // ⓪ 진행관리표 파일을 '판매목록' 유형으로 미리보기 → 유형 불일치 차단(이번 신규 30,119·삭제의심 13,542 원인)
  {
    const buf0 = await build(rows, headers);
    let code = ""; try { await buildSyncPreview(db, { buffer: buf0, sourceType: "sales_list", scope: "full" }); } catch (e) { code = e.code; }
    check("⓪ 진행관리표 파일을 판매목록으로 선택 → 비교 차단(SOURCE_TYPE_MISMATCH)", code === "SOURCE_TYPE_MISMATCH", code);
    const p0 = await buildSyncPreview(db, { buffer: buf0, sourceType: "progress", scope: "full" });
    const s0 = summarizePreview(p0);
    check("⓪ 올바른 유형: 비교 대상 = 기존 진행관리표 유효 30,142행 · 전부 변경 없음", s0.comparedWith.sourceType === "progress" && s0.comparedWith.effectiveRows === rows.length && s0.counts.SAME === rows.length && s0.counts.DELETION_SUSPECT === 0, JSON.stringify({ cw: s0.comparedWith, c: s0.counts }));
  }

  // ⑤ 실제 최신 파일과 같은 형태: 행 순서 변경 + 신규 112행(기존 묶음 추가 40 · 새 건 72) + 다중행 묶음 안 수정 3건
  {
    const shuffled = rows.map((r, i) => ({ ...r, source_raw: { ...r.source_raw }, k: (i * 7919) % rows.length })).sort((a, b) => a.k - b.k);
    const groups = (await db.execute(sql`SELECT array_agg(id ORDER BY id) ids FROM legacy_archive_rows WHERE source_type='progress' AND is_effective
      GROUP BY company_name, contact_name, product_name, language, record_date HAVING count(*) = 3 AND count(DISTINCT translator_name) = 3 AND count(DISTINCT row_hash) = 3 LIMIT 50`)).rows.map(r => r.ids.map(Number));
    const find = (id) => shuffled.find(x => Number(x.id) === id);
    for (const g of groups.slice(0, 3)) find(g[1]).source_raw["지급액(세전)"] = "123456";          // 묶음 안 1건 수정
    const extraInGroup = groups.slice(10, 50).map(g => ({ source_sheet: find(g[0]).source_sheet, source_raw: { ...find(g[0]).source_raw, "통번역사명": "추가수행자테스트", "지급액(세전)": "77000" } }));
    const brandNew = Array.from({ length: 72 }, (_, i) => ({ source_sheet: shuffled[0].source_sheet, source_raw: { ...shuffled[0].source_raw, "거래처명": `신규거래처테스트${i}`, "체결일": "2026-10-20" } }));
    const buf5 = await build([...shuffled, ...extraInGroup, ...brandNew], headers);
    const t5 = performance.now(); const p5 = await buildSyncPreview(db, { buffer: buf5, sourceType: "progress", scope: "full" }); timings.push(`미리보기(${rows.length + 112}행·순서 변경): ${((performance.now() - t5) / 1000).toFixed(2)}s`);
    const s5 = summarizePreview(p5);
    check("⑤ 행 순서 변경·신규 112·묶음 안 수정 3 → 신규 112·수정 3·중복의심 0·삭제의심 0", s5.counts.NEW === 112 && s5.counts.UPDATED === 3 && s5.counts.AMBIGUOUS === 0 && s5.counts.DELETION_SUSPECT === 0 && s5.counts.SAME === rows.length - 3, JSON.stringify(s5.counts));
    const upd5 = previewPage(p5, "UPDATED", 1, 10).rows;
    check("⑤ 묶음 안 수정 건: 기존 행과 1:1 대응·지급액 전후 표시", upd5.length === 3 && upd5.every(r => r.matchedExistingId && r.changedFields.some(c => c.field === "payoutPretax")), JSON.stringify(upd5.map(r => r.reason)));
    // 표본 교차검증 30건: 변경 없음으로 판정된 행의 원본 내용이 대응 기존 행과 공통 열 기준 동일
    const sameRows = p5.plan.decisions.filter(d => d.classification === "SAME" && d.matchedExistingId != null);
    const sample = Array.from({ length: 30 }, (_, i) => sameRows[(i * 997) % sameRows.length]);
    let ok = 0;
    for (const d of sample) {
      const ex = (await one(sql`SELECT source_raw FROM legacy_archive_rows WHERE id=${d.matchedExistingId}`)).source_raw;
      const inc = p5.allRows[d.index].sourceRaw;
      if (headers.every(h => String(ex[h] ?? "").trim() === String(inc[h] ?? "").trim())) ok++;
    }
    check("⑤ 표본 30건 교차검증: '변경 없음' 행 = 대응 기존 행 원본과 동일", ok === 30, `${ok}/30`);
    // 묶음 안 대응이 불확실한 경우(같은 묶음 2건을 서로 다른 내용으로 바꾸고 통번역사명도 바꿈) → 중복 의심
    const g = groups[5];
    const amb = shuffled.map(r => ({ ...r, source_raw: { ...r.source_raw } }));
    for (const id of [g[0], g[1]]) { const x = amb.find(y => Number(y.id) === id); x.source_raw["통번역사명"] = `변경${id}`; x.source_raw["지급액(세전)"] = String(id); }
    const pA = summarizePreview(await buildSyncPreview(db, { buffer: await build(amb, headers), sourceType: "progress", scope: "full" }));
    check("⑤ 묶음 안 2건이 동시에 바뀌어 대응 불확실 → 중복 의심 2·자동 병합 없음·삭제의심 0(앞의 묶음 수정 3건 유지)", pA.counts.AMBIGUOUS === 2 && pA.counts.UPDATED === 3 && pA.counts.NEW === 0 && pA.counts.DELETION_SUSPECT === 0, JSON.stringify(pA.counts));
  }

  // ① 최신 CRM 이 열을 하나 더 내보낸 경우(값 있음) — 공통 열 동일 → 전부 변경 없음(대량 재버전 방지)
  {
    const buf = await build(rows, [...headers, "신규추가열"], raw => ({ ...raw, "신규추가열": "X" }));
    const s0 = performance.now(); const p = await buildSyncPreview(db, { buffer: buf, sourceType: "progress", scope: "full" }); timings.push(`미리보기(열 추가 ${rows.length}행): ${((performance.now() - s0) / 1000).toFixed(2)}s`);
    const s = summarizePreview(p);
    check("① 열 추가 파일: 신규 0·수정 0·전부 변경 없음", s.counts.NEW === 0 && s.counts.UPDATED === 0 && s.counts.SAME === rows.length, JSON.stringify(s.counts));
    check("① 열 구성 변경 감지(추가 열 표시)·공통 열 기준 비교로 새 버전 0", s.changeSummary.headerDiff.added.includes("신규추가열") && s.willApply.insertEffective === 0, JSON.stringify({ added: s.changeSummary.headerDiff.added, only: s.changeSummary.columnOnlyToSame }));
  }

  // ② 원본 열만 바뀐 행(요율·세후지급액·교통비) + 10/7 이전 자료 수정 + 납품일·지급일·지급액 수정
  const work = rows.map(r => ({ ...r, source_raw: { ...r.source_raw } }));
  const uniq = (await db.execute(sql`SELECT r.id FROM legacy_archive_rows r WHERE r.source_type='progress' AND r.is_effective AND
      (SELECT count(*) FROM legacy_archive_rows r2 WHERE r2.source_type='progress' AND r2.is_effective AND r2.company_name IS NOT DISTINCT FROM r.company_name AND r2.contact_name IS NOT DISTINCT FROM r.contact_name AND r2.product_name IS NOT DISTINCT FROM r.product_name AND r2.language IS NOT DISTINCT FROM r.language AND r2.record_date IS NOT DISTINCT FROM r.record_date)=1
      AND r.record_date < '2026-01-01' ORDER BY r.id LIMIT 4`)).rows.map(r => Number(r.id));
  const byId = (id) => work.find(x => Number(x.id) === id);
  byId(uniq[0]).source_raw["요율(85%)"] = "12345";
  byId(uniq[1]).source_raw["지금액(세후)"] = "999999";
  byId(uniq[2]).source_raw["교통비"] = "50000";
  byId(uniq[3]).source_raw["통번역사지급일"] = "2026-10-31";
  const bufB = await build(work, headers);
  const pB = await buildSyncPreview(db, { buffer: bufB, sourceType: "progress", scope: "full" });
  const sB = summarizePreview(pB);
  check("② 수정 4건(10/7 이전 자료 포함)·신규 0·보류 0", sB.counts.UPDATED === 4 && sB.counts.NEW === 0 && sB.counts.AMBIGUOUS === 0 && sB.counts.DELETION_SUSPECT === 0, JSON.stringify(sB.counts));
  const upd = previewPage(pB, "UPDATED", 1, 50).rows;
  const cols = new Set(upd.flatMap(r => r.rawChanges.map(c => c.column)));
  check("② 원본 열 변경 항목 표시(요율·세후지급액·교통비·지급일)", ["요율(85%)", "지금액(세후)", "교통비", "통번역사지급일"].every(c => cols.has(c)), [...cols].join(","));
  check("② 주요 변경 항목 요약", sB.changeSummary.topColumns.length >= 4, JSON.stringify(sB.changeSummary.topColumns));
  check("② 미리보기는 DB 미변경", JSON.stringify(await storage()) === JSON.stringify(S0));
  cachePreview(pB, null);
  const r = await db.transaction(async (tx) => executeArchiveSync(tx, { buffer: bufB, sourceType: "progress", fileName: "progress-full.xlsx", performerId: null, scope: "full", planToken: sB.planToken, approvedAmbiguous: new Set() }));
  const S1 = await storage();
  check("② 반영: 수정 4행만 새 버전 저장·이전 버전 보존", r.applied.updated === 4 && S1.rows === S0.rows + 4 && S1.eff === S0.eff, JSON.stringify({ rows: S1.rows - S0.rows }));
  check("② 판매·진행 확정 연결 유지(이관)", S1.links >= S0.links);
  // ③ 같은 파일 재업로드 → 중복 생성 없음
  const p3 = await buildSyncPreview(db, { buffer: bufB, sourceType: "progress", scope: "full" });
  const r3 = await db.transaction(async (tx) => executeArchiveSync(tx, { buffer: bufB, sourceType: "progress", fileName: "progress-full.xlsx", performerId: null, scope: "full", planToken: p3.planToken, approvedAmbiguous: new Set() }));
  check("③ 같은 파일 재업로드: 변경 없음·건수 불변", r3.mode === "no_change" && JSON.stringify(await storage()) === JSON.stringify(S1));
  // ④ 되돌리기
  await db.transaction(async (tx) => executeBatchRollback(tx, r.batchId, null));
  const S2 = await storage();
  check("④ 되돌리기 후 유효 건수·지급액 합계 = 기준", S2.eff === S0.eff && S2.payout === S0.payout, JSON.stringify(S2));

  console.log("\n[처리시간]\n  " + timings.join("\n  "));
  console.log(`\n결과: PASS ${pass} / FAIL ${fail} · ${((Date.now() - T0) / 1000).toFixed(1)}s`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error("테스트 오류:", e); process.exit(1); });
