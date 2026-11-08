// @ts-nocheck — 격리 테스트 전용 하네스(앱 빌드 비포함, esbuild 번들로 실행).
// 과거 CRM 판매목록·진행관리표 원본 Excel 행 순서 표시 검증. DATABASE_URL 이 임시 복제 DB(veritas_refresh_scratch)일 때만 실행.
import * as XLSX from "xlsx";
import { PassThrough } from "node:stream";
import ExcelJS from "exceljs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getR2ObjectBuffer } from "./lib/r2";
import { applySalesProgress } from "./services/crmRefresh";
import { rollbackFullSync } from "./services/legacyArchiveSync";
import { searchArchiveFull, planArchiveExport, writeArchiveWorkbook } from "./routes/legacyArchive";

if (!/\/veritas_refresh_scratch(\?|$)/.test(process.env.DATABASE_URL ?? "")) { console.error("임시 복제 DB(veritas_refresh_scratch)에서만 실행합니다."); process.exit(1); }
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };
const q = async (s: any) => (await db.execute(s)).rows as any[];
const USER = 10;

async function savedFile(type: string) {
  const r = (await q(sql`SELECT b.original_filename f, m.source_raw->>'r2Key' k FROM import_batches b JOIN import_row_sources m ON m.batch_id=b.id AND m.status='file_meta'
    WHERE b.module='legacy_crm_file' AND b.source_type=${type} AND b.status<>'deleted' ORDER BY b.id DESC LIMIT 1`))[0];
  const { body } = await getR2ObjectBuffer(r.k); return { name: r.f, buf: Buffer.from(body) };
}
function toAoa(buf: Buffer, marker: string) {
  const wb = XLSX.read(buf, { type: "buffer", raw: false });
  const aoa: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: null });
  const h = aoa.findIndex(r => (r ?? []).some(c => String(c ?? "").replace(/\s/g, "") === marker));
  return { pre: aoa.slice(0, h), header: aoa[h].map((x: any) => (x == null ? null : String(x))), rows: aoa.slice(h + 1).filter(r => (r ?? []).some(c => c != null && String(c).trim() !== "")) };
}
function fromAoa(t) { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([...t.pre, t.header, ...t.rows]), "Sheet1"); return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })); }
const col = (t, n) => t.header.findIndex(h => String(h ?? "").replace(/\s/g, "") === n);
const norm = (v) => String(v ?? "").trim();
// 행 지문: 판매목록 = 판매번호, 진행관리표 = 주요 열 조합(주민번호 미사용)
const PK = ["체결일", "거래처명", "상품명", "통번역사명", "통번역사납품일", "통번역사지급일", "지급액(세전)", "총액", "파일명"];
const fpFile = (t, type) => t.rows.map(r => type === "sales_list" ? norm(r[col(t, "판매번호")]) : PK.map(k => norm(r[col(t, k)])).join("|"));
const fpRaw = (raw, type) => type === "sales_list" ? norm(raw["판매번호"]) : PK.map(k => norm(raw[k])).join("|");

async function listAll(type: string, extra = {}, pageSize = 500) {
  const out: any[] = []; let page = 1;
  for (;;) { const r = await searchArchiveFull(db, { sourceType: type, snapshot: "current", page, pageSize, ...extra }, type); out.push(...r.rows); if (page >= r.pagination.totalPages) break; page++; }
  return out;
}
const dataFp = async () => (await q(sql`SELECT md5(string_agg(id||':'||is_effective||':'||coalesce(superseded_by_id,0)||':'||md5(source_raw::text), ',' ORDER BY id)) h,
  (SELECT md5(string_agg(id||':'||sale_row_id||':'||progress_row_id, ',' ORDER BY id)) FROM legacy_sales_progress_links) l FROM legacy_archive_rows`))[0];

async function verifyOrder(label: string, S, P) {
  for (const [type, t] of [["sales_list", S], ["progress", P]] as const) {
    const lbl = type === "sales_list" ? "판매목록" : "진행관리표";
    const rows = await listAll(type);
    const got = rows.map(r => fpRaw(r.sourceRaw, type)), exp = fpFile(t, type);
    let firstDiff = -1; for (let i = 0; i < Math.max(got.length, exp.length); i++) if (got[i] !== exp[i]) { firstDiff = i; break; }
    check(`${label} ${lbl} 화면 순서 = 원본 Excel 행 순서`, firstDiff === -1, `파일 ${exp.length}행 · 화면 ${got.length}행${firstDiff >= 0 ? ` · 첫 불일치 위치 ${firstDiff + 1}` : ""}`);
    const fr = rows.map(r => r.fileRow);
    check(`${label} ${lbl} 표시 Excel 행 번호 오름차순·연속`, fr.every((v, i) => v != null && (i === 0 || v > fr[i - 1])), `첫 ${fr[0]} · 끝 ${fr[fr.length - 1]}`);
  }
}

async function main() {
  const s0 = await savedFile("sales_list"), p0 = await savedFile("progress");
  const S = toAoa(s0.buf, "판매번호"), P = toAoa(p0.buf, "통번역사명");

  // 순서표 이전(기존 자료): 화면이 여전히 동작(순서표 없음 → 기존 기준)
  const pre = await searchArchiveFull(db, { sourceType: "sales_list", snapshot: "current", page: 1, pageSize: 5 }, "sales_list");
  check("순서표 없는 기존 자료도 조회 정상", pre.rows.length === 5 && pre.pagination.total > 0);

  // 1) 실제 최신 파일 재업로드 → 내용 변경 없음, 순서표만 기록
  const d0 = await dataFp();
  const r1 = await applySalesProgress(db, { salesBuffer: s0.buf, progressBuffer: p0.buf, salesName: s0.name, progressName: p0.name, userId: USER });
  check("재업로드(내용 동일) — CRM 데이터·연결 불변", r1.mode === "no_change" && JSON.stringify(await dataFp()) === JSON.stringify(d0), r1.mode);
  await verifyOrder("[실제 11-03 파일]", S, P);

  // 2) 페이지 이동: 1~2페이지 연결 = 처음 2N행, 페이지 크기 달라도 같은 순서
  const a = await listAll("sales_list", {}, 50), b = await listAll("sales_list", {}, 137);
  check("페이지 크기·이동과 무관하게 같은 순서", a.length === b.length && a.every((r, i) => r.id === b[i].id), `${a.length}행`);
  const p1 = await searchArchiveFull(db, { sourceType: "progress", snapshot: "current", page: 3, pageSize: 50 }, "progress");
  const pAll = await listAll("progress", {}, 50);
  check("진행관리표 3페이지 = 전체 순서의 101~150행", p1.rows.every((r, i) => r.id === pAll[100 + i].id));

  // 3) 검색·필터: 결과 = 원본 순서의 부분열
  const coName = norm(S.rows[3][col(S, "거래처명")]).slice(0, 4);
  for (const [type, t, f] of [["sales_list", S, { company: coName }], ["progress", P, { q: coName }], ["progress", P, { deliveryDateFrom: "2026-01-01", deliveryDateTo: "2026-06-30" }]] as const) {
    const got = (await listAll(type, f)).map(r => fpRaw(r.sourceRaw, type));
    const pos = new Map<string, number[]>(); fpFile(t, type).forEach((k, i) => { const x = pos.get(k) ?? []; x.push(i); pos.set(k, x); });
    let last = -1, ok = got.length > 0;
    for (const k of got) { const c = (pos.get(k) ?? []).find(i => i > last); if (c == null) { ok = false; break; } last = c; }
    check(`검색·필터 후 원본 순서 유지(${type === "sales_list" ? "판매목록" : "진행관리표"} · ${Object.keys(f).join(",")})`, ok, `${got.length}행`);
  }

  // 4) 행 순서만 바꾼 최신 파일 → 데이터 불변, 화면 순서는 새 파일 순서
  const S2 = { ...S, rows: [...S.rows].reverse() };
  const P2 = { ...P, rows: [...P.rows.slice(1000), ...P.rows.slice(0, 1000)] };
  const d1 = await dataFp();
  const r2 = await applySalesProgress(db, { salesBuffer: fromAoa(S2), progressBuffer: fromAoa(P2), salesName: "판매목록 순서변경.xlsx", progressName: "진행관리표 순서변경.xlsx", userId: USER });
  check("순서만 바뀐 파일 — CRM 데이터·연결 불변", r2.mode === "no_change" && JSON.stringify(await dataFp()) === JSON.stringify(d1), r2.mode);
  await verifyOrder("[순서 변경 파일]", S2, P2);

  // 5) 중간에 신규 행 추가 + 기존 행 수정 → 새 파일 위치에 표시
  const S3 = { ...S2, header: S2.header, rows: S2.rows.map(r => [...r]) };
  const nr = new Array(S3.header.length).fill(null);
  nr[col(S3, "판매번호")] = "2026-11-08-9101"; nr[col(S3, "거래처명")] = "[TEST]순서확인"; nr[col(S3, "상품명")] = "영한번역"; nr[col(S3, "총액")] = "55000";
  S3.rows.splice(500, 0, nr);
  S3.rows[10][col(S3, "입금내역")] = "순서테스트 입금 1,000";
  const r3 = await applySalesProgress(db, { salesBuffer: fromAoa(S3), progressBuffer: fromAoa(P2), salesName: "판매목록 추가.xlsx", progressName: "진행관리표 순서변경.xlsx", userId: USER });
  check("신규·수정 반영", r3.mode === "applied" && r3.sales.added === 1 && r3.sales.updated === 1, JSON.stringify(r3.sales));
  await verifyOrder("[신규 행 중간 삽입 파일]", S3, P2);

  // 6) 되돌리기 → 되돌린 실행의 순서표는 쓰지 않음(직전 순서표 = 순서 변경 파일)
  await db.transaction(tx => rollbackFullSync(tx, r3.runId, USER));
  await verifyOrder("[되돌린 뒤]", S2, P2);

  // 7) 다운로드 순서 = 화면 순서
  const plan = await planArchiveExport(db, "all", { sourceType: "sales_list", snapshot: "current" });
  const pt = new PassThrough(); const chunks: Buffer[] = []; pt.on("data", c => chunks.push(c));
  await writeArchiveWorkbook(pt, plan); await new Promise(r => pt.end(r));
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.concat(chunks));
  const ws = wb.worksheets[0]; const hdr = (ws.getRow(1).values as any[]).map(v => String(v ?? ""));
  const ci = hdr.indexOf("판매번호"); const dl: string[] = []; ws.eachRow((row, i) => { if (i > 1) dl.push(norm((row.values as any[])[ci])); });
  const exp = fpFile(S2, "sales_list");
  check("Excel 다운로드 순서 = 화면(원본) 순서", dl.length === exp.length && dl.every((v, i) => v === exp[i]), `${dl.length}행`);

  console.log(`\n결과: PASS ${pass} · FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
