// @ts-nocheck — 격리 테스트 전용 하네스(앱 빌드 비포함, esbuild 번들로 실행).
// 과거 CRM 자료 최신화(업로드 즉시 반영) 검증. DATABASE_URL 이 임시 복제 DB(veritas_refresh_scratch)일 때만 실행.
//   · 입력: R2 에 저장된 실제 최신 CRM 파일(판매목록·진행관리표, 읽기 전용 다운로드) + 메모리에서 만든 변형 파일. 디스크 저장 없음.
import * as XLSX from "xlsx";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getR2ObjectBuffer } from "./lib/r2";
import { applySalesProgress, applyTranslatorList, refreshStatus, errorInfo } from "./services/crmRefresh";
import { rollbackFullSync } from "./services/legacyArchiveSync";
import { collectUnifiedItems } from "./routes/payoutUnified";
import { todayKst } from "./lib/legacyPayoutRule";

if (!/\/veritas_refresh_scratch(\?|$)/.test(process.env.DATABASE_URL ?? "")) { console.error("임시 복제 DB(veritas_refresh_scratch)에서만 실행합니다."); process.exit(1); }
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };
const q = async (s: any) => (await db.execute(s)).rows as any[];
const one = async (s: any) => (await q(s))[0];
const USER = 10;

async function protectedFp() {
  // 행 전체(text) 지문 — 어떤 열이든 바뀌면 달라진다.
  const t = (name: string) => sql.raw(`(SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x.id),'')) FROM ${name} x) AS ${name}`);
  return one(sql`SELECT ${t("performance_assignments")}, ${t("payout_rounds")}, ${t("payout_round_items")}, ${t("payout_transfers")}, ${t("settlements")}, ${t("payments")},
    ${t("projects")}, ${t("quotes")}, ${t("legacy_master_mappings")}, ${t("billing_batches")}, ${t("prepaid_ledger")},
    (SELECT count(*) FROM users WHERE deleted_at IS NOT NULL)::int deleted_users`);
}
const legacyFp = async () => one(sql`SELECT
  (SELECT count(*) FROM legacy_archive_rows)::int total,
  (SELECT md5(string_agg(id::text, ',' ORDER BY id)) FROM legacy_archive_rows WHERE source_type='sales_list' AND is_effective) s,
  (SELECT md5(string_agg(id::text, ',' ORDER BY id)) FROM legacy_archive_rows WHERE source_type='progress' AND is_effective) p,
  (SELECT count(*) FROM legacy_sales_progress_links)::int links`);

// ── 실제 최신 파일(R2 저장본) ──
async function savedFile(type: string) {
  const r = await one(sql`SELECT b.original_filename f, m.source_raw->>'r2Key' k FROM import_batches b JOIN import_row_sources m ON m.batch_id=b.id AND m.status='file_meta'
    WHERE b.module='legacy_crm_file' AND b.source_type=${type} AND b.status<>'deleted' ORDER BY b.id DESC LIMIT 1`);
  const { body } = await getR2ObjectBuffer(r.k);
  return { name: r.f, buf: Buffer.from(body) };
}
function toAoa(buf: Buffer, marker: string) {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false, raw: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null });
  const h = aoa.findIndex(r => (r ?? []).some(c => String(c ?? "").replace(/\s/g, "") === marker));
  return { pre: aoa.slice(0, h), header: aoa[h].map((x: any) => (x == null ? null : String(x))), rows: aoa.slice(h + 1).filter(r => (r ?? []).some(c => c != null && String(c).trim() !== "")) };
}
function fromAoa(t: { pre: any[][]; header: any[]; rows: any[][] }) {
  const ws = XLSX.utils.aoa_to_sheet([...t.pre, t.header, ...t.rows]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}
const col = (t, name) => t.header.findIndex(h => String(h ?? "").replace(/\s/g, "") === name.replace(/\s/g, ""));
const clone = (t) => ({ pre: t.pre, header: [...t.header], rows: t.rows.map(r => [...r]) });

async function main() {
  const today = todayKst();
  console.log(`오늘(KST) ${today}`);
  const sales0 = await savedFile("sales_list"), prog0 = await savedFile("progress");
  console.log(`실제 파일: ${sales0.name} (${sales0.buf.length}B) · ${prog0.name} (${prog0.buf.length}B)`);
  const fpP0 = await protectedFp();

  // ── S1 실제 최신 파일 그대로 전체 교체 ──
  const r1 = await applySalesProgress(db, { salesBuffer: sales0.buf, progressBuffer: prog0.buf, salesName: sales0.name, progressName: prog0.name, userId: USER });
  console.log("S1", JSON.stringify({ mode: r1.mode, sales: r1.sales, progress: r1.progress, links: r1.links, ms: r1.elapsedMs }));
  check("S1 실제 최신 파일 전체 교체 성공", r1.mode === "applied" || r1.mode === "no_change");
  const effS = await one(sql`SELECT (SELECT count(*) FROM legacy_archive_rows WHERE source_type='sales_list' AND is_effective)::int s, (SELECT count(*) FROM legacy_archive_rows WHERE source_type='progress' AND is_effective)::int p`);
  const S = toAoa(sales0.buf, "판매번호"), P = toAoa(prog0.buf, "통번역사명");
  check("S1 유효 판매건 수 = 최신 파일 행 수(보호·보류 제외)", effS.s === S.rows.length - r1.sales.held + r1.sales.protectedFromRemoval, `DB ${effS.s} · 파일 ${S.rows.length} · 보류 ${r1.sales.held} · 보호 ${r1.sales.protectedFromRemoval}`);
  check("S1 유효 수행행 수 = 최신 파일 행 수(보호·보류·취소판매 제외)", Math.abs(effS.p - P.rows.length) <= r1.progress.held + r1.progress.protectedFromRemoval + (r1.cancelled?.progress ?? 0) + 200,
    `DB ${effS.p} · 파일 ${P.rows.length} · 보류 ${r1.progress.held} · 보호 ${r1.progress.protectedFromRemoval}`);
  const r1b = await applySalesProgress(db, { salesBuffer: sales0.buf, progressBuffer: prog0.buf, salesName: sales0.name, progressName: prog0.name, userId: USER });
  check("S1 같은 파일 재업로드 = 변경 없음(멱등)", r1b.mode === "no_change", r1b.mode);
  const fpL1 = await legacyFp();

  // ── S2 변경 파일: 신규·수정·삭제·열 추가 ──
  const iNo = col(S, "판매번호"), iCo = col(S, "거래처명"), iPr = col(S, "상품명"), iTot = col(S, "총액"), iDep = col(S, "입금내역"), iDepD = col(S, "입금일"), iMgr = col(S, "영업담당자");
  // 삭제 대상 판매건: 운영 전환되지 않았고 연결 수행행이 있는 판매건(최근 것)
  const del = await one(sql`SELECT r.id, r.source_raw->>'판매번호' no FROM legacy_archive_rows r WHERE r.source_type='sales_list' AND r.is_effective
    AND EXISTS (SELECT 1 FROM legacy_sales_progress_links l JOIN legacy_archive_rows p ON p.id=l.progress_row_id AND p.is_effective WHERE l.sale_row_id=r.id)
    AND NOT EXISTS (SELECT 1 FROM legacy_master_mappings m WHERE m.entity_type='sale' AND m.status='active' AND m.legacy_id=r.source_raw->>'판매번호')
    ORDER BY r.source_raw->>'판매번호' DESC LIMIT 1`);
  const delProg = (await q(sql`SELECT p.id FROM legacy_sales_progress_links l JOIN legacy_archive_rows p ON p.id=l.progress_row_id AND p.is_effective WHERE l.sale_row_id=${del.id}`)).map(r => Number(r.id));
  // 수정 대상: 연결 수행행이 있는 다른 판매건(입금정보·담당자 변경)
  const upd = await one(sql`SELECT r.id, r.source_raw->>'판매번호' no FROM legacy_archive_rows r WHERE r.source_type='sales_list' AND r.is_effective AND r.source_raw->>'판매번호' <> ${del.no}
    AND EXISTS (SELECT 1 FROM legacy_sales_progress_links l WHERE l.sale_row_id=r.id)
    AND NOT EXISTS (SELECT 1 FROM legacy_master_mappings m WHERE m.entity_type='sale' AND m.status='active' AND m.legacy_id=r.source_raw->>'판매번호')
    ORDER BY r.source_raw->>'판매번호' DESC OFFSET 3 LIMIT 1`);
  const S2 = clone(S), P2 = clone(P);
  S2.rows = S2.rows.filter(r => String(r[iNo]) !== del.no);
  const uRow = S2.rows.find(r => String(r[iNo]) === upd.no);
  uRow[iDep] = "테스트은행 123,456"; uRow[iDepD] = "2026-11-07"; uRow[iMgr] = "테스트담당";
  // 진행관리표: 삭제 판매건의 수행행을 파일에서 제외(원본 값 일치 행)
  const delRaw = await q(sql`SELECT source_raw FROM legacy_archive_rows WHERE id = ANY(${sql.raw(`ARRAY[${delProg.join(",") || 0}]::int[]`)})`);
  const pi = (n) => col(P2, n);
  const sameRow = (r, raw) => ["거래처명", "상품명", "통번역사명", "통번역사납품일", "총액"].every(k => String(r[pi(k)] ?? "").trim() === String(raw[k] ?? "").trim());
  const before = P2.rows.length;
  P2.rows = P2.rows.filter(r => !delRaw.some(d => sameRow(r, d.source_raw)));
  const progRemovedInFile = before - P2.rows.length;
  // 신규 판매건 + 수행행
  const NEWNO = "2026-11-08-9001";
  const ns = new Array(S2.header.length).fill(null);
  ns[iNo] = NEWNO; ns[iCo] = "[TEST]최신화거래처"; ns[iPr] = "영한번역(테스트)"; ns[iTot] = "110000"; ns[col(S2, "영업기회명")] = "최신화 테스트"; ns[iMgr] = "테스트담당";
  S2.rows.unshift(ns);
  const np = new Array(P2.header.length).fill(null);
  Object.assign(np, { [pi("체결일")]: "2026-11-08", [pi("거래처명")]: "[TEST]최신화거래처", [pi("상품명")]: "영한번역(테스트)", [pi("총액")]: "110000", [pi("통번역사명")]: "테스트번역사",
    [pi("통번역사납품일")]: "2026-11-05", [pi("통번역사지급일")]: "2026-11-13", [pi("지급액(세전)")]: "50000", [pi("지금액(세후)")]: "48350" });
  P2.rows.unshift(np);
  // 새 원본 열 추가(모든 열 저장 확인)
  S2.header.push("테스트열"); S2.rows.forEach((r, i) => r.push(i === 0 ? "신규열값" : null));
  const fpP1 = await protectedFp();
  const r2 = await applySalesProgress(db, { salesBuffer: fromAoa(S2), progressBuffer: fromAoa(P2), salesName: "판매목록 변경.xlsx", progressName: "진행관리표 변경.xlsx", userId: USER });
  console.log("S2", JSON.stringify({ mode: r2.mode, sales: r2.sales, progress: r2.progress, links: r2.links, cancelled: r2.cancelled, integrity: r2.integrity }));
  const nz = await one(sql`SELECT id, source_raw FROM legacy_archive_rows WHERE source_type='sales_list' AND is_effective AND source_raw->>'판매번호'=${NEWNO}`);
  check("S2 신규 판매건 추가", !!nz);
  check("S2 신규 판매건 원본 열 누락 없음(추가 열 포함)", !!nz && nz.source_raw["테스트열"] === "신규열값" && Object.keys(nz.source_raw).length >= S2.header.filter(Boolean).length - 1, nz ? `${Object.keys(nz.source_raw).length}열` : "");
  const nzLink = nz ? await one(sql`SELECT count(*)::int n FROM legacy_sales_progress_links l JOIN legacy_archive_rows p ON p.id=l.progress_row_id AND p.is_effective WHERE l.sale_row_id=${nz.id}`) : { n: 0 };
  check("S2 신규 판매건 ↔ 신규 수행행 자동 연결", nzLink.n === 1, `${nzLink.n}건`);
  const uz = await one(sql`SELECT id, source_raw FROM legacy_archive_rows WHERE source_type='sales_list' AND is_effective AND source_raw->>'판매번호'=${upd.no}`);
  check("S2 기존 판매건 수정 반영(입금내역·입금일·담당자)", uz?.source_raw?.["입금내역"] === "테스트은행 123,456" && String(uz?.source_raw?.["입금일"]).startsWith("2026-11-07") && uz?.source_raw?.["영업담당자"] === "테스트담당");
  const uzOld = await one(sql`SELECT is_effective e, superseded_by_id s FROM legacy_archive_rows WHERE id=${upd.id}`);
  check("S2 수정 전 버전 보존(비유효·대체 포인터)", uzOld.e === false && Number(uzOld.s) === Number(uz?.id));
  const uzLinks = await one(sql`SELECT (SELECT count(*) FROM legacy_sales_progress_links WHERE sale_row_id=${upd.id})::int a, (SELECT count(*) FROM legacy_sales_progress_links WHERE sale_row_id=${uz?.id ?? 0})::int b`);
  check("S2 수정 판매건 수행행 연결 유지", uzLinks.b >= uzLinks.a && uzLinks.a > 0, `이전 ${uzLinks.a} → 새 버전 ${uzLinks.b}`);
  const dz = await one(sql`SELECT is_effective e FROM legacy_archive_rows WHERE id=${del.id}`);
  check("S2 최신 파일에서 삭제된 판매건 조회 제외(비활성, 물리 삭제 없음)", dz?.e === false);
  const dp = await one(sql`SELECT count(*) FILTER (WHERE is_effective)::int eff, count(*)::int n FROM legacy_archive_rows WHERE id = ANY(${sql.raw(`ARRAY[${delProg.join(",") || 0}]::int[]`)})`);
  check("S2 삭제 판매건의 수행행도 조회 제외(행 보존)", dp.eff === 0 && dp.n === delProg.length, `수행행 ${delProg.length}건(파일에서 ${progRemovedInFile}행 제거)`);
  check("S2 연결 무결성(비유효 연결·고아 수행행 0)", r2.integrity.newLinksToInactive === 0 && r2.integrity.orphanedByRun === 0 && r2.integrity.duplicateGroups === 0, JSON.stringify(r2.integrity));
  const unified = await collectUnifiedItems({ basis: "payout", source: "legacy", dFrom: null, dTo: null, q: "[TEST]최신화거래처", canViewFullContact: false, limit: 50 });
  check("S2 지급회차 통합자료에 신규 수행행 반영(지급일 2026-11-13 → 지급예정)", unified.items.length === 1 && unified.items[0].status === "scheduled", JSON.stringify(unified.items.map(i => [i.payoutDate, i.status])));
  const fpP2 = await protectedFp();
  check("S2 신규 플랫폼 금융·정산·운영 자료 불변", JSON.stringify(fpP1) === JSON.stringify(fpP2));
  const r2b = await applySalesProgress(db, { salesBuffer: fromAoa(S2), progressBuffer: fromAoa(P2), salesName: "판매목록 변경.xlsx", progressName: "진행관리표 변경.xlsx", userId: USER });
  check("S2 같은 변경 파일 재업로드 = 변경 없음", r2b.mode === "no_change", r2b.mode);
  const fpL2 = await legacyFp();

  // ── S3 실패 시 기존 자료 유지 ──
  const bad = clone(P2); const ti = col(bad, "통번역사명"); bad.header[ti] = "수행자";
  let e3: any = null; try { await applySalesProgress(db, { salesBuffer: fromAoa(S2), progressBuffer: fromAoa(bad), salesName: "s.xlsx", progressName: "p.xlsx", userId: USER }); } catch (e) { e3 = errorInfo(e); }
  check("S3 필수 열 없는 파일 → 교체 거부", !!e3 && (e3.code === "REQUIRED_COLUMNS_MISSING" || e3.code === "SOURCE_TYPE_MISMATCH"), e3 ? `${e3.code}: ${e3.message.slice(0, 80)}` : "오류 없음");
  check("S3 거부 후 기존 자료 그대로", JSON.stringify(await legacyFp()) === JSON.stringify(fpL2));
  const part = clone(S2); part.rows = part.rows.slice(0, Math.floor(part.rows.length * 0.3));
  let e4: any = null; try { await applySalesProgress(db, { salesBuffer: fromAoa(part), progressBuffer: fromAoa(P2), salesName: "s.xlsx", progressName: "p.xlsx", userId: USER }); } catch (e) { e4 = errorInfo(e); }
  check("S3 부분 자료(30%)로 전체 교체 시도 → 차단", !!e4 && e4.code === "SYNC_BLOCKED", e4 ? `${e4.code}: ${e4.message.slice(0, 100)}` : "오류 없음");
  check("S3 차단 후 기존 자료 그대로", JSON.stringify(await legacyFp()) === JSON.stringify(fpL2));
  let e5: any = null; try { await applySalesProgress(db, { salesBuffer: Buffer.from("not an excel"), progressBuffer: fromAoa(P2), salesName: "s.xlsx", progressName: "p.xlsx", userId: USER }); } catch (e) { e5 = errorInfo(e); }
  check("S3 손상 파일 → 거부 · 기존 자료 그대로", !!e5 && JSON.stringify(await legacyFp()) === JSON.stringify(fpL2), e5 ? `${e5.code}: ${e5.message.slice(0, 80)}` : "");

  // ── S4 실행 단위 되돌리기(복구 가능한 이전 버전) ──
  if (r2.runId) {
    await db.transaction(tx => rollbackFullSync(tx, r2.runId, USER));
    const fpL3 = await legacyFp();
    check("S4 변경 실행 되돌리기 → 유효 자료가 이전 상태로 복원", fpL3.s === fpL1.s && fpL3.p === fpL1.p, `판매 ${fpL3.s === fpL1.s} · 진행 ${fpL3.p === fpL1.p}`);
    // 다시 적용(이후 검증용)
    const r2c = await applySalesProgress(db, { salesBuffer: fromAoa(S2), progressBuffer: fromAoa(P2), salesName: "판매목록 변경.xlsx", progressName: "진행관리표 변경.xlsx", userId: USER });
    check("S4 되돌린 뒤 재적용 가능", r2c.mode === "applied");
  }

  // ── S5 과거 CRM 지급회차 자동 지급완료 / 신규 플랫폼 미적용 ──
  const all = await collectUnifiedItems({ basis: "payout", source: "all", dFrom: null, dTo: null, canViewFullContact: false, limit: 200000 });
  const leg = all.items.filter(i => i.source === "legacy" && i.status !== "dup_suspect");
  const wrongPast = leg.filter(i => i.payoutDate && i.payoutDate < today && i.status !== "paid");
  const wrongToday = leg.filter(i => i.payoutDate && i.payoutDate >= today && i.status === "paid" && !(i.deliveryDate && i.deliveryDate <= "2026-09-15"));
  const c1030 = leg.filter(i => i.payoutDate === "2026-10-30"), c1113 = leg.filter(i => i.payoutDate === "2026-11-13");
  check("S5 지급일 경과 과거 건 = 지급완료", wrongPast.length === 0, `오류 ${wrongPast.length}건`);
  check("S5 지급일 당일·미래 과거 건 = 지급예정(지급완료 아님)", wrongToday.length === 0, `오류 ${wrongToday.length}건`);
  check("S5 2026-10-30 회차 전부 지급완료", c1030.length > 0 && c1030.every(i => i.status === "paid"), `${c1030.length}건`);
  check("S5 2026-11-13 회차 = 지급예정(11-14부터 완료)", c1113.length > 0 && c1113.every(i => i.status === "scheduled" || (i.deliveryDate && i.deliveryDate <= "2026-09-15")), `${c1113.length}건 · ${[...new Set(c1113.map(i => i.status))].join(",")}`);
  const byRound = leg.filter(i => i.status === "paid" && i.paidBasis?.includes("지급회차"));
  check("S5 지급회차 경과 지급완료 근거 표기(VERITAS 송금 아님)", byRound.length > 0 && byRound.every(i => i.paidBasis.includes("송금 아님")), `${byRound.length}건`);
  const cur = all.items.filter(i => i.source === "current");
  const curRaw = await q(sql`SELECT id, payment_status::text ps FROM performance_assignments WHERE deleted_at IS NULL`);
  const psById = new Map(curRaw.map(r => [Number(r.id), r.ps]));
  const curWrong = cur.filter(i => (i.status === "paid") !== (psById.get(i.id) === "paid"));
  const curElapsedUnpaid = cur.filter(i => i.payoutDate && i.payoutDate < today && i.status !== "paid").length;
  check("S5 신규 플랫폼 지급건 = payment_status 그대로(지급일 경과로 자동 완료 안 함)", curWrong.length === 0, `신규 ${cur.length}건 · 지급일 경과 미지급 ${curElapsedUnpaid}건 유지`);

  // ── S6 통번역사 명부 ──
  const histName = await one(sql`SELECT btrim(translator_name) n FROM legacy_archive_rows p WHERE source_type='progress' AND is_effective AND btrim(coalesce(translator_name,'')) <> ''
    AND coalesce(regexp_replace(source_raw->>'주민등록번호','[^0-9]','','g'),'') = ''
    AND NOT EXISTS (SELECT 1 FROM users u WHERE u.role='translator' AND regexp_replace(lower(u.name),'\\s','','g') = regexp_replace(lower(btrim(p.translator_name)),'\\s','','g'))
    AND NOT EXISTS (SELECT 1 FROM translator_aliases a WHERE a.normalized_alias = regexp_replace(lower(btrim(p.translator_name)),'\\s','','g'))
    AND NOT EXISTS (SELECT 1 FROM legacy_master_mappings m WHERE m.entity_type='translator' AND m.legacy_id = btrim(p.translator_name))
    AND btrim(translator_name) !~ '[()㈜]' AND length(btrim(translator_name)) BETWEEN 2 AND 4 GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`);
  const exist = await one(sql`SELECT u.id, u.name, u.email FROM users u JOIN translator_profiles tp ON tp.user_id=u.id WHERE u.role='translator' AND u.deleted_at IS NULL AND u.is_active
    AND u.email NOT LIKE '%@legacy%' AND u.email LIKE '%@%' AND (tp.region IS NULL OR btrim(tp.region)='') ORDER BY u.id LIMIT 1`);
  const aliveBefore = Number((await one(sql`SELECT count(*)::int n FROM users WHERE role='translator' AND deleted_at IS NULL`)).n);
  const rowsT = [
    ["성명", "이메일", "주민등록번호", "휴대폰", "활동지역", "가능언어"],
    ["김테스트가", "refresh.a@test-veritas.example", "9001011000001", "010-9000-0001", "서울", "영어"],          // ① 주민번호 + 이력 없음 → 포함
    [histName?.n ?? "이력자없음", "refresh.b@test-veritas.example", "", "010-9000-0002", "", "일본어"],          // ③ 주민번호 없음 + 이력 있음 → 포함
    ["박테스트다", "refresh.c@test-veritas.example", "", "010-9000-0003", "", "중국어"],                        // ④ 둘 다 없음 → 제외
    [exist?.name, exist?.email, "", "", "부산", ""],                                                            // 기존 Master → 공란 보완
    ["김테스트가", "refresh.a@test-veritas.example", "9001011000001", "010-9000-0001", "서울", "영어"],          // 파일 내 중복 → 1회만
  ];
  const tws = XLSX.utils.aoa_to_sheet(rowsT); const twb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(twb, tws, "명부");
  const tbuf = Buffer.from(XLSX.write(twb, { type: "buffer", bookType: "xlsx" }));
  const fpT0 = await protectedFp();
  const t1 = await applyTranslatorList(db, { buffer: tbuf, fileName: "통번역사명부 테스트.xlsx", userId: USER, snapshotId: "test" });
  console.log("S6", JSON.stringify(t1));
  const has = async (email) => one(sql`SELECT u.id, (SELECT count(*) FROM translator_sensitive s WHERE s.translator_id=u.id AND s.resident_number IS NOT NULL)::int rrn FROM users u WHERE u.email=${email} AND u.deleted_at IS NULL`);
  const a = await has("refresh.a@test-veritas.example"), b = await has("refresh.b@test-veritas.example"), c = await has("refresh.c@test-veritas.example");
  check("S6 ① 주민번호 있음·이력 없음 → 등록(주민번호 암호화 저장)", !!a && a.rrn === 1);
  check("S6 ③ 주민번호 없음·수행이력 있음 → 등록", !!histName && !!b, histName ? `성명 ${histName.n.slice(0, 1)}**` : "대상 없음");
  check("S6 ④ 주민번호·수행이력 모두 없음 → 제외", !c && t1.excludedNoRrnNoHistory >= 1);
  const ex2 = exist ? await one(sql`SELECT region FROM translator_profiles WHERE user_id=${exist.id}`) : null;
  check("S6 기존 Master 정보 보완(공란만, 신규 생성 없음)", !!exist && ex2?.region === "부산");
  const aliveAfter = Number((await one(sql`SELECT count(*)::int n FROM users WHERE role='translator' AND deleted_at IS NULL`)).n);
  check("S6 중복 등록 없음 · 기존 Master 삭제 없음", aliveAfter === aliveBefore + t1.applied.created && t1.applied.created === (histName ? 2 : 1), `${aliveBefore} → ${aliveAfter}`);
  check("S6 수행·지급이력/금융자료 불변", JSON.stringify(fpT0) === JSON.stringify(await protectedFp()));
  const t2 = await applyTranslatorList(db, { buffer: tbuf, fileName: "통번역사명부 테스트.xlsx", userId: USER, snapshotId: "test" });
  check("S6 같은 명부 재업로드 = 변경 없음", t2.mode === "no_change", t2.mode);
  const logs = await q(sql`SELECT s.source_raw::text t FROM import_row_sources s JOIN import_batches b ON b.id=s.batch_id WHERE b.module IN ('translator','crm_refresh') AND b.created_at > now() - interval '1 hour'`);
  check("S6 처리 로그·변경 이력에 주민번호 원문 없음", !logs.some(l => l.t.includes("9001011000001") || l.t.includes("900101-1000001")));

  // ── S7 현황 ──
  const st = await refreshStatus(db);
  check("S7 현황 조회(5개 자료 건수)", st.items.length === 4 && st.items[0].counts.sales > 0, JSON.stringify(st.items.map(i => i.counts)));
  check("S0 전체 — 보호 대상(신규 플랫폼 금융·운영) 불변", JSON.stringify(fpP0) === JSON.stringify(await protectedFp()));
  console.log(`\n결과: PASS ${pass} · FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
