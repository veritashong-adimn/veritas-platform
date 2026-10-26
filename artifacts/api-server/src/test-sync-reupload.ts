// @ts-nocheck — 격리 테스트 전용 하네스(앱 빌드 비포함, esbuild 번들로 실행).
// 과거 CRM 반복 업로드 최종 검증. DATABASE_URL 이 임시 복제 DB(veritas_sync_scratch)일 때만 실행한다.
//   · 개발/운영 DB 미접촉. 원본 Excel 은 저장된 source_raw 로 메모리에서 재구성(디스크 저장 없음).
import ExcelJS from "exceljs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  buildSyncPreview, summarizePreview, previewPage, executeArchiveSync, planBatchRollback, executeBatchRollback, cachePreview, getCachedPreview,
} from "./services/legacyArchiveSync";
import { analyzeTranslators } from "./routes/bulkImport";

const url = process.env.DATABASE_URL ?? "";
if (!/\/veritas_sync_scratch(\?|$)/.test(url)) { console.error("임시 복제 DB(veritas_sync_scratch)에서만 실행합니다."); process.exit(1); }

let pass = 0, fail = 0;
const T0 = Date.now();
const timings: string[] = [];
function check(name: string, ok: boolean, detail = "") { (ok ? pass++ : fail++); console.log(`${ok ? "PASS" : "FAIL"} [${((Date.now() - T0) / 1000).toFixed(0)}s] ${name}${detail ? ` — ${detail}` : ""}`); }
async function timed<R>(label: string, fn: () => Promise<R>): Promise<R> { const s = performance.now(); const r = await fn(); timings.push(`${label}: ${((performance.now() - s) / 1000).toFixed(2)}s`); return r; }
const q = async (s: any) => (await db.execute(s)).rows as any[];
const one = async (s: any) => (await q(s))[0];

// 변경 전후 비교 지문
async function fingerprint() {
  return {
    salesEff: await one(sql`SELECT count(*)::int n, md5(string_agg(id::text, ',' ORDER BY id)) h FROM legacy_archive_rows WHERE source_type='sales_list' AND is_effective`),
    progEff: await one(sql`SELECT count(*)::int n, md5(string_agg(id::text, ',' ORDER BY id)) h FROM legacy_archive_rows WHERE source_type='progress' AND is_effective`),
    linksEff: await one(sql`SELECT count(*)::int n, md5(string_agg(l.sale_row_id||'-'||l.progress_row_id, ',' ORDER BY l.sale_row_id, l.progress_row_id)) h FROM (SELECT DISTINCT l.sale_row_id, l.progress_row_id FROM legacy_sales_progress_links l JOIN legacy_archive_rows s ON s.id=l.sale_row_id JOIN legacy_archive_rows p ON p.id=l.progress_row_id WHERE l.decision='confirmed' AND s.is_effective AND p.is_effective) l`),
    mappings: await one(sql`SELECT count(*)::int n, md5(string_agg(id||':'||entity_id||':'||status||':'||legacy_id, ',' ORDER BY id)) h FROM legacy_master_mappings`),
    translators: await one(sql`SELECT count(*)::int n, md5(string_agg(id||':'||coalesce(deleted_at::text,'')||':'||is_active, ',' ORDER BY id)) h FROM users WHERE role='translator'`),
    merges: await one(sql`SELECT count(*)::int n, md5(string_agg(id||':'||status, ',' ORDER BY id)) h FROM translator_merges`),
    finance: await one(sql`SELECT (SELECT count(*) FROM settlements)::int s, (SELECT count(*) FROM payments)::int p, (SELECT count(*) FROM payout_rounds)::int r, (SELECT count(*) FROM payout_round_items)::int ri, (SELECT count(*) FROM performance_assignments)::int pa`),
    salesTotal: (await one(sql`SELECT coalesce(sum(total_amount),0)::text t FROM legacy_archive_rows WHERE source_type='sales_list' AND is_effective`)).t,
    progPayout: (await one(sql`SELECT coalesce(sum(payout_pretax),0)::text t FROM legacy_archive_rows WHERE source_type='progress' AND is_effective`)).t,
  };
}
async function storage() {
  return one(sql`SELECT (SELECT count(*) FROM legacy_archive_rows)::int rows, (SELECT count(*) FROM import_batches)::int batches, (SELECT count(*) FROM import_row_sources)::int logs, (SELECT count(*) FROM legacy_sales_progress_links)::int links`);
}
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

async function loadEffectiveRaw(sourceType: string) {
  const rows = await q(sql`SELECT id, source_sheet, source_row, source_raw, total_amount, payout_pretax FROM legacy_archive_rows WHERE source_type=${sourceType} AND is_effective ORDER BY source_sheet, source_row, id`);
  const hb = await q(sql`SELECT headers_json FROM import_batches WHERE module='legacy_archive' AND source_type=${sourceType} AND headers_json IS NOT NULL ORDER BY id LIMIT 1`);
  const headers: string[] = [...(hb[0]?.headers_json ?? [])];
  for (const r of rows) for (const k of Object.keys(r.source_raw ?? {})) if (!headers.includes(k)) headers.push(k);
  return { rows, headers };
}
async function toXlsx(rows: { source_sheet: string; source_raw: any }[], headers: string[]): Promise<Buffer> {
  const m = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) { const a = m.get(r.source_sheet) ?? []; a.push(r.source_raw); m.set(r.source_sheet, a); }
  const wb = new ExcelJS.Workbook();
  for (const [name, rs] of m) { const ws = wb.addWorksheet(name); ws.addRow(headers); for (const raw of rs) ws.addRow(headers.map(h => { const v = raw[h]; return v == null || v === "" ? null : String(v); })); }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const clone = (rows: any[]) => rows.map(r => ({ ...r, source_raw: { ...r.source_raw } }));

async function preview(buffer: Buffer, sourceType: string, scope = "full") {
  const p = await buildSyncPreview(db, { buffer, sourceType, scope });
  return { p, s: summarizePreview(p) };
}
async function exec(buffer: Buffer, sourceType: string, planToken: string, approved: string[] = [], fileName = "test.xlsx", scope = "full") {
  return db.transaction(async (tx) => executeArchiveSync(tx, { buffer, sourceType, fileName, performerId: null, scope, planToken, approvedAmbiguous: new Set(approved) }));
}
async function rollback(batchId: number) { return db.transaction(async (tx) => executeBatchRollback(tx, batchId, null)); }

async function main() {
  const F0 = await fingerprint();
  const S0 = await storage();
  console.log("기준선:", JSON.stringify({ sales: F0.salesEff.n, progress: F0.progEff.n, linksEffective: F0.linksEff.n, salesTotal: F0.salesTotal, progPayout: F0.progPayout, storage: S0 }));

  // ── 1. 동일 파일 3회 반복 업로드(판매목록·진행관리표) ──
  const sales = await loadEffectiveRaw("sales_list");
  const salesBuf = await toXlsx(sales.rows, sales.headers);
  const prog = await loadEffectiveRaw("progress");
  const progBuf = await toXlsx(prog.rows, prog.headers);
  for (const [label, buf, st, n] of [["판매목록", salesBuf, "sales_list", sales.rows.length], ["진행관리표", progBuf, "progress", prog.rows.length]] as const) {
    for (let k = 1; k <= 3; k++) {
      const { p, s } = await timed(`${label} 미리보기(${n.toLocaleString()}행) ${k}회`, () => preview(buf, st));
      if (k === 1) check(`1 ${label} 동일 자료 판정: 전부 변경 없음`, s.counts.SAME === n && s.counts.NEW + s.counts.UPDATED + s.counts.AMBIGUOUS + s.counts.DELETION_SUSPECT === 0, JSON.stringify(s.counts));
      cachePreview(p, null);
      const r = await timed(`${label} 반영 시도 ${k}회(캐시 재사용)`, () => exec(buf, st, s.planToken));
      check(`1 ${label} 동일 파일 ${k}회차 반영: no_change·INSERT/UPDATE 없음`, r.mode === "no_change" && r.unchangedSkipped === n && r.reusedPreview, `${r.mode}, skipped ${r.unchangedSkipped}, reused ${r.reusedPreview}`);
    }
  }
  check("1 동일 파일 6회 업로드 후 전체 행·배치·로그·연결 수 불변", same(await storage(), S0), JSON.stringify(await storage()));
  check("1 동일 파일 6회 업로드 후 유효자료·금액·연결·Master 지문 불변", same(await fingerprint(), F0));

  // ── 2. 캐시 페이지 조회(파일 재전송·재파싱 없음) ──
  {
    const { p } = await preview(progBuf, "progress");
    const id = cachePreview(p, 7);
    const s0 = performance.now(); const pg = previewPage(getCachedPreview(id, 7)!, "SAME", 300, 100); const ms = performance.now() - s0;
    timings.push(`진행관리표 캐시 페이지 조회(300쪽): ${(ms / 1000).toFixed(3)}s`);
    check("2 미리보기 전체 건수 정확·페이지 단위 표시", pg.total === prog.rows.length && pg.rows.length === 100 && pg.page === 300);
    check("2 다른 사용자 캐시 접근 차단", getCachedPreview(id, 8) === null);
  }

  // ── 3. 일부 행 수정 후 재업로드(배치 A) ──
  const anyLinked = new Set((await q(sql`SELECT DISTINCT sale_row_id id FROM legacy_sales_progress_links WHERE decision='confirmed'`)).map(r => Number(r.id)));
  const linkedRows = sales.rows.filter(r => anyLinked.has(Number(r.id))).slice(0, 5);
  const plain = sales.rows.filter(r => !anyLinked.has(Number(r.id)));
  const r1 = plain[50], c2 = plain[51], inc = plain[52];
  const modA = clone(sales.rows);
  const byId = (rows: any[], id: number) => rows.find(x => Number(x.id) === Number(id));
  for (const lr of linkedRows) { const x = byId(modA, lr.id); x.source_raw["총액"] = String(Number(String(x.source_raw["총액"]).replace(/,/g, "")) + 1000); }
  byId(modA, r1.id).source_raw["총액"] = "777000";
  byId(modA, c2.id).source_raw["거래처명"] = `${c2.source_raw["거래처명"]}(정정)`;
  byId(modA, inc.id).source_raw["거래처명"] = "완전히다른거래처"; byId(modA, inc.id).source_raw["상품명"] = "완전히다른상품";
  const bufA = await toXlsx(modA, sales.headers);
  let batchA = 0;
  {
    const SB = await storage();
    const { p, s } = await timed("판매목록 수정 파일 미리보기", () => preview(bufA, "sales_list"));
    check("3 수정 파일 판정: 수정 7·중복의심 1·신규 0", s.counts.UPDATED === 7 && s.counts.AMBIGUOUS === 1 && s.counts.NEW === 0 && s.counts.DELETION_SUSPECT === 0, JSON.stringify(s.counts));
    check("3 미리보기는 DB 미변경", same(await storage(), SB));
    const upd = previewPage(p, "UPDATED", 1, 50).rows;
    check("3 수정 전후 값 표시", upd.length === 7 && upd.every(r => r.before && r.changedFields.length > 0));
    let rejected = "";
    try { await exec(bufA, "sales_list", "invalid"); } catch (e) { rejected = e.code; }
    check("3 승인 토큰 불일치 시 반영 거부(DB 미변경)", rejected === "SYNC_PLAN_CHANGED" && same(await storage(), SB));
    cachePreview(p, null);
    const r = await timed("판매목록 수정 반영(배치 A)", () => exec(bufA, "sales_list", s.planToken, [], "A.xlsx"));
    batchA = r.batchId;
    const SA = await storage();
    check("3 반영: 수정 7건만 새 버전 저장(변경 없음 미저장)", r.applied.updated === 7 && r.unchangedSkipped === sales.rows.length - 8 && SA.rows === SB.rows + 7, `rows +${SA.rows - SB.rows}, skipped ${r.unchangedSkipped}`);
    check("3 반영: 중복 의심 1건 보류(미저장)", r.held === 1);
    check("3 반영: 유효 판매 건수 동일", r.effective.after === F0.salesEff.n);
    const F = await fingerprint();
    check("3 반영 후 판매·진행 유효 연결 수 유지", F.linksEff.n === F0.linksEff.n, `${F0.linksEff.n}→${F.linksEff.n}`);
    const expTotal = BigInt(F0.salesTotal) + 5000n + (777000n - BigInt(Math.round(Number(r1.total_amount ?? 0))));
    check("3 반영 후 판매 금액 합계 = 기준 + 변경분", BigInt(F.salesTotal) === expTotal, `${F0.salesTotal}→${F.salesTotal} (예상 ${expTotal})`);
    check("3 반영 후 진행관리표·매핑·Master·통합·정산 불변", same(F.progEff, F0.progEff) && same(F.mappings, F0.mappings) && same(F.translators, F0.translators) && same(F.merges, F0.merges) && same(F.finance, F0.finance));
    for (let k = 1; k <= 2; k++) {
      const { s: s2 } = await preview(bufA, "sales_list");
      const r2 = await exec(bufA, "sales_list", s2.planToken);
      check(`3 같은 수정 파일 재업로드 ${k}회: no_change·건수 불변`, r2.mode === "no_change" && same(await storage(), SA), JSON.stringify(s2.counts));
    }
  }

  // ── 4. 신규 행 추가 + 같은 행(r1) 재수정 후 재업로드(배치 B) ──
  let batchB = 0;
  const cur = await loadEffectiveRaw("sales_list");
  const modB = clone(cur.rows);
  modB.find(x => x.source_raw["판매번호"] === r1.source_raw["판매번호"]).source_raw["총액"] = "888000";
  const newRows = [1, 2, 3].map(i => ({ source_sheet: modB[0].source_sheet, source_raw: { ...modB[0].source_raw, "판매번호": `2026-10-25-99${i}`, "거래처명": `테스트신규거래처${i}`, "총액": "110000" } }));
  const bufB = await toXlsx([...modB, ...newRows], sales.headers);
  {
    const SB = await storage();
    const { p, s } = await preview(bufB, "sales_list");
    check("4 신규 추가 파일 판정: 신규 3·수정 1(같은 행 재수정)", s.counts.NEW === 3 && s.counts.UPDATED === 1 && s.counts.AMBIGUOUS === 0, JSON.stringify(s.counts));
    cachePreview(p, null);
    const r = await exec(bufB, "sales_list", s.planToken, [], "B.xlsx");
    batchB = r.batchId;
    const SAfter = await storage();
    check("4 반영: 신규 3 + 수정 1 = 4행만 저장", r.applied.created === 3 && r.applied.updated === 1 && SAfter.rows === SB.rows + 4, `rows +${SAfter.rows - SB.rows}`);
    check("4 반영: 유효 판매 +3", r.effective.after === F0.salesEff.n + 3);
    const { s: s2 } = await preview(bufB, "sales_list");
    const r2 = await exec(bufB, "sales_list", s2.planToken);
    check("4 같은 신규 추가 파일 재업로드: no_change·건수 불변", r2.mode === "no_change" && same(await storage(), SAfter));
  }

  // ── 5. 진행관리표 수정(배치 C) — 배치 A가 수정한 판매건과 연결된 수행행 ──
  let batchC = 0;
  const linkedSaleNo = linkedRows[0].source_raw["판매번호"];
  {
    const pr = await one(sql`SELECT p.id FROM legacy_sales_progress_links l JOIN legacy_archive_rows p ON p.id=l.progress_row_id JOIN legacy_archive_rows s ON s.id=l.sale_row_id
      WHERE l.decision='confirmed' AND p.is_effective AND s.is_effective AND s.source_raw->>'판매번호'=${linkedSaleNo}
        AND (SELECT count(*) FROM legacy_archive_rows r2 WHERE r2.source_type='progress' AND r2.is_effective AND r2.company_name IS NOT DISTINCT FROM p.company_name AND r2.contact_name IS NOT DISTINCT FROM p.contact_name AND r2.product_name IS NOT DISTINCT FROM p.product_name AND r2.language IS NOT DISTINCT FROM p.language AND r2.record_date IS NOT DISTINCT FROM p.record_date)=1
      LIMIT 1`);
    const pw = clone(prog.rows);
    pw.find(x => Number(x.id) === Number(pr.id)).source_raw["통번역사지급일"] = "2026-10-31";
    const bufC = await toXlsx(pw, prog.headers);
    const SB = await storage();
    const { p, s } = await timed("진행관리표 수정 파일 미리보기", () => preview(bufC, "progress", "range"));
    check("5 진행관리표 수정 1건 판정", s.counts.UPDATED === 1 && s.counts.NEW === 0, JSON.stringify(s.counts));
    cachePreview(p, null);
    const r = await timed("진행관리표 수정 반영(배치 C)", () => exec(bufC, "progress", s.planToken, [], "C.xlsx", "range"));
    batchC = r.batchId;
    check("5 반영: 1행만 저장·연결 이관", (await storage()).rows === SB.rows + 1 && r.linksCarried >= 1, `links ${r.linksCarried}`);
    check("5 반영 후 유효 연결 수 유지", (await fingerprint()).linksEff.n === F0.linksEff.n);
  }

  // ── 6. 되돌리기: 이후 업로드가 있어도 해당 배치가 바꾼 행만 ──
  {
    const pA = await planBatchRollback(db, batchA);
    check("6 배치 A 되돌리기 미리보기: 변경 7 중 6 복원·1건(B가 재수정) 보존", pA.ok && pA.effectiveInBatch === 6 && pA.restoreSuperseded === 6 && pA.preservedLater === 1, JSON.stringify({ eff: pA.effectiveInBatch, restore: pA.restoreSuperseded, preserved: pA.preservedLater, reattach: pA.linksToReattach }));
    const ra = await timed("배치 A 되돌리기", () => rollback(batchA));
    const F = await fingerprint();
    const r1Eff = await one(sql`SELECT total_amount::text t, import_batch_id b FROM legacy_archive_rows WHERE source_type='sales_list' AND is_effective AND source_raw->>'판매번호'=${r1.source_raw["판매번호"]}`);
    check("6 A 되돌린 후 B의 재수정본(888,000) 보존", Number(r1Eff.t) === 888000 && Number(r1Eff.b) === batchB, JSON.stringify(r1Eff));
    const bNew = await one(sql`SELECT count(*)::int n FROM legacy_archive_rows WHERE import_batch_id=${batchB} AND is_effective`);
    check("6 A 되돌린 후 B의 신규·수정 4건 유효 유지", bNew.n === 4);
    check("6 A 되돌린 후 유효 판매 = 기준 + 3", F.salesEff.n === F0.salesEff.n + 3);
    const cEff = await one(sql`SELECT count(*)::int n FROM legacy_archive_rows WHERE import_batch_id=${batchC} AND is_effective`);
    check("6 A 되돌린 후 C의 진행 수정본 유지·유효 연결 수 유지", F.linksEff.n === F0.linksEff.n && cEff.n === 1, `links ${F.linksEff.n}, reattached ${ra.linksReattached}`);
    const shown = await one(sql`SELECT count(*)::int n FROM legacy_sales_progress_links l JOIN legacy_archive_rows s ON s.id=l.sale_row_id JOIN legacy_archive_rows p ON p.id=l.progress_row_id
      WHERE l.decision='confirmed' AND s.is_effective AND p.is_effective AND s.source_raw->>'판매번호'=${linkedSaleNo}`);
    const orig = await one(sql`SELECT count(*)::int n FROM legacy_sales_progress_links WHERE decision='confirmed' AND sale_row_id=${linkedRows[0].id} AND match_method <> 'carry_over_v1'`);
    check("6 복원된 판매건 ↔ C 수정 수행행 연결 유지(연결 보완)", shown.n === orig.n, `${shown.n} vs ${orig.n}`);
    const pB = await planBatchRollback(db, batchB);
    check("6 배치 B 되돌리기 가능(순서 무관)", pB.ok, pB.reason);
    await rollback(batchB);
    const r1Back = await one(sql`SELECT id, total_amount::text t FROM legacy_archive_rows WHERE source_type='sales_list' AND is_effective AND source_raw->>'판매번호'=${r1.source_raw["판매번호"]}`);
    check("6 B 되돌린 후 r1 = 원본 행(되돌린 A 버전 부활 없음)", Number(r1Back.id) === Number(r1.id) && Number(r1Back.t) === Number(r1.total_amount), JSON.stringify(r1Back));
    await rollback(batchC);
    const F2 = await fingerprint();
    check("6 A·B·C 모두 되돌린 후 유효자료·유효연결·금액·Master·정산 = 기준선", same(F2, F0), JSON.stringify({ sales: F2.salesEff.n, links: F2.linksEff.n, total: F2.salesTotal }));
    check("6 같은 배치 재되돌리기 차단", !(await planBatchRollback(db, batchA)).ok);
    const origBatch = await one(sql`SELECT min(id) id FROM import_batches WHERE module='legacy_archive' AND source_type='sales_list'`);
    check("6 최초 원본 배치 되돌리기 차단", !(await planBatchRollback(db, origBatch.id)).ok);
    const { s } = await preview(bufA, "sales_list");
    check("6 되돌린 뒤 같은 파일 재분석 시 다시 반영 가능", s.counts.UPDATED === 7 && s.alreadyStored === 0, JSON.stringify(s.counts));
  }

  // ── 7. 통합·제외된 통번역사 재업로드(2회) ──
  {
    const merged = await one(sql`SELECT g.merged_master_id m, g.representative_master_id r, u.name FROM translator_merges g JOIN users u ON u.id=g.merged_master_id WHERE g.status='active' ORDER BY g.id LIMIT 1`);
    const lone = await one(sql`SELECT u.id, u.name FROM users u WHERE u.role='translator' AND u.deleted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users a WHERE a.role='translator' AND a.deleted_at IS NULL AND a.name=u.name) ORDER BY u.id LIMIT 1`);
    const prevPhone = (await one(sql`SELECT phone FROM translator_profiles WHERE user_id=${merged.m}`))?.phone ?? null;
    await db.execute(sql`UPDATE translator_profiles SET phone='010-9999-0417' WHERE user_id=${merged.m}`);   // 임시 DB 한정
    try {
      const FT = await fingerprint();
      for (let k = 1; k <= 2; k++) {
        const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("통번역사");
        ws.addRow(["성명", "이메일", "휴대폰"]);
        ws.addRow([merged.name, null, "010-9999-0417"]);
        ws.addRow([merged.name, null, null]);
        ws.addRow([lone.name, null, null]);
        ws.addRow(["반복업로드신규테스트", "sync-test-new@example.com", "010-0000-1234"]);
        const res = await analyzeTranslators(Buffer.from(await wb.xlsx.writeBuffer()));
        const [a, b, c, d] = res.rows;
        check(`7 (${k}회) 통합 Master + 휴대폰 → 대표 Master #${merged.r} 연결`, a.status !== "new" && a.existingId === Number(merged.r), `${a.status} · ${a.reason}`);
        check(`7 (${k}회) 통합 Master 이름만 → 보류`, b.status === "needs_review", `${b.status} · ${b.reason}`);
        check(`7 (${k}회) 제외 Master 이름만 → 보류(excluded_master)`, c.status === "needs_review" && c.reviewCategory === "excluded_master", `${c.status} · ${c.reason}`);
        check(`7 (${k}회) 실제 신규 인물만 신규`, d.status === "new" && res.rows.filter(r => r.status === "new").length === 1);
      }
      const FT2 = await fingerprint();
      check("7 통번역사 분석 후 Master·통합·매핑 불변", same(FT2.translators, FT.translators) && same(FT2.mappings, FT.mappings) && same(FT2.merges, FT.merges));
    } finally {
      await db.execute(sql`UPDATE translator_profiles SET phone=${prevPhone} WHERE user_id=${merged.m}`);
    }
  }

  const FZ = await fingerprint(); const SZ = await storage();
  check("최종 유효자료·금액·연결·Master·정산 = 기준선", same(FZ, F0));
  console.log("\n[건수] 테스트 전:", JSON.stringify({ ...S0, salesEff: F0.salesEff.n, progEff: F0.progEff.n, linksEff: F0.linksEff.n, salesTotal: F0.salesTotal, progPayout: F0.progPayout }));
  console.log("[건수] 테스트 후:", JSON.stringify({ ...SZ, salesEff: FZ.salesEff.n, progEff: FZ.progEff.n, linksEff: FZ.linksEff.n, salesTotal: FZ.salesTotal, progPayout: FZ.progPayout }));
  console.log("[처리시간]\n  " + timings.join("\n  "));
  console.log(`\n결과: PASS ${pass} / FAIL ${fail} · ${((Date.now() - T0) / 1000).toFixed(1)}s`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("테스트 오류:", e); process.exit(1); });
