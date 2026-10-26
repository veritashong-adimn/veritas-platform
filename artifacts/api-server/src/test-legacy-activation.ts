// @ts-nocheck — 격리 통합 테스트(임시 복제 DB veritas_act_scratch + :8099 API 서버 전용). 과거 CRM 판매건 운영 전환 ①~⑯.
import ExcelJS from "exceljs";
import jwt from "jsonwebtoken";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { buildSyncPreview, executeArchiveSync, cachePreview } from "./services/legacyArchiveSync";

if (!/\/veritas_act_scratch(\?|$)/.test(process.env.DATABASE_URL ?? "")) { console.error("임시 복제 DB(veritas_act_scratch)에서만 실행합니다."); process.exit(1); }
const B = "http://localhost:8099/api";
const SALE_A = Number(process.env.SALE_A), SALE_A2 = Number(process.env.SALE_A2), SALE_B = Number(process.env.SALE_B), SALE_C = Number(process.env.SALE_C);
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };
const q = async (s: any) => (await db.execute(s)).rows as any[];
const one = async (s: any) => (await q(s))[0];
const tok = (p: any) => jwt.sign(p, process.env.JWT_SECRET, { expiresIn: "30m" });
const ADMIN = tok({ id: 10, email: "admin@test", role: "admin" });
const call = async (t: string, m: string, path: string, body?: any) => {
  const r = await fetch(B + path, { method: m, headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get("content-type") ?? ""; return { status: r.status, body: ct.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};
const archiveHash = () => one(sql`SELECT count(*)::int n, md5(string_agg(id||':'||row_hash||':'||is_effective||':'||coalesce(superseded_by_id,0), ',' ORDER BY id)) h FROM legacy_archive_rows`);
const linkHash = () => one(sql`SELECT count(*)::int n, md5(string_agg(id||':'||sale_row_id||':'||progress_row_id||':'||decision, ',' ORDER BY id)) h FROM legacy_sales_progress_links`);
const opsCount = () => one(sql`SELECT (SELECT count(*) FROM projects)::int projects, (SELECT count(*) FROM quotes)::int quotes, (SELECT count(*) FROM performance_assignments)::int perfs, (SELECT count(*) FROM project_payments)::int pays, (SELECT count(*) FROM legacy_master_mappings)::int maps`);
const saleNoOf = async (id: number) => (await one(sql`SELECT source_raw->>'판매번호' v FROM legacy_archive_rows WHERE id=${id}`)).v;

async function main() {
  // 권한 테스트 사용자(임시 DB 에만)
  const roleId = async (n: string) => (await one(sql`SELECT id FROM roles WHERE name=${n}`))?.id;
  const VIEWER = tok({ id: 10, email: "viewer@test", role: "staff", roleId: await roleId("viewer") });
  const PM = tok({ id: 10, email: "pm@test", role: "staff", roleId: await roleId("pm") });
  const FIN = tok({ id: 10, email: "fin@test", role: "staff", roleId: await roleId("finance") });
  const NOROLE = tok({ id: 10, email: "norole@test", role: "staff" });

  const A0 = await archiveHash(), L0 = await linkHash(), O0 = await opsCount();
  const sh0 = (await call(ADMIN, "GET", "/admin/sales-history?range=all&pageSize=1")).body;

  // ── ① 미리보기(DB 미변경) + 권한 ──
  const pv = await call(ADMIN, "GET", `/admin/legacy-archive/${SALE_A}/activation-preview`);
  check("① 전환 미리보기 200 · 수행/수금 분류", pv.status === 200 && pv.body.perfSummary.legacyPaid >= 1 && pv.body.perfSummary.payoutReview >= 1 && pv.body.collection.status === "matched",
    JSON.stringify({ perf: pv.body.perfSummary, col: pv.body.collection?.status }));
  check("① 미리보기는 DB 미변경", JSON.stringify(await opsCount()) === JSON.stringify(O0));
  check("⑯ 권한: viewer 미리보기 403 · 전환 403", (await call(VIEWER, "GET", `/admin/legacy-archive/${SALE_A}/activation-preview`)).status === 403
    && (await call(VIEWER, "POST", `/admin/legacy-archive/${SALE_A}/activate`, { confirm: true, planToken: pv.body.planToken })).status === 403);
  check("전환: planToken 불일치 → 409(STALE_PLAN)", (await call(ADMIN, "POST", `/admin/legacy-archive/${SALE_A}/activate`, { confirm: true, planToken: "x" })).body.code === "STALE_PLAN");

  // ── 전환 + 동시 중복 전환 방지 ──
  const [r1, r2] = await Promise.all([
    call(ADMIN, "POST", `/admin/legacy-archive/${SALE_A}/activate`, { confirm: true, planToken: pv.body.planToken }),
    call(PM, "POST", `/admin/legacy-archive/${SALE_A}/activate`, { confirm: true, planToken: pv.body.planToken }),
  ]);
  const okR = [r1, r2].filter(r => r.status === 201);
  check("중복 전환 방지: 동시 2요청 중 1건만 생성", okR.length === 1 && [r1, r2].some(r => r.status === 409), `${r1.status}/${r2.status}`);
  const PID = okR[0]?.body.projectId;
  const again = await call(ADMIN, "POST", `/admin/legacy-archive/${SALE_A}/activate`, { confirm: true, planToken: pv.body.planToken });
  check("중복 전환 방지: 재요청 409 + 기존 운영 ID 안내", again.status === 409 && again.body.projectId === PID);
  const saleNoA = await saleNoOf(SALE_A);
  const map = await q(sql`SELECT entity_id FROM legacy_master_mappings WHERE source_system='old_crm' AND entity_type='sale' AND legacy_id=${saleNoA}`);
  check("ID 매핑: 판매번호 → 운영 판매 ID 1건", map.length === 1 && Number(map[0].entity_id) === PID, `${saleNoA} → ${PID}`);

  // ── ② 재조회 · 원본 보존 ──
  const det = (await call(ADMIN, "GET", `/admin/projects/${PID}`)).body;
  const quote = det.quotes.find(x => x.isCurrent) ?? det.quotes[0];
  check("② 운영 판매 재조회: 금액=원본 총액 · 항목 1개(상품명 원본)", Number(quote.price) === Number(pv.body.total) && quote.items.length === 1 && quote.items[0].productName === pv.body.productName);
  const perfs = det.performances;
  check("⑤ 수행정보 = 원본 수행행 수(1:1, 중복 없음)", perfs.length === pv.body.perfSummary.total, `${perfs.length}`);
  const paidRows = perfs.filter(p => p.paymentStatus === "paid"), holdRows = perfs.filter(p => p.paymentStatus === "payment_hold");
  check("과거 지급완료 → paid · 지급일 없는 지급액 → 지급보류(확인 필요)", paidRows.length === pv.body.perfSummary.legacyPaid && holdRows.length === pv.body.perfSummary.payoutReview);
  const orig0 = (await call(ADMIN, "GET", `/admin/projects/${PID}/legacy-origin`)).body.origin;
  const costOk = orig0.payoutItems.every(it => it.originalPreTax == null || Math.abs(Number(it.costTotal) - Number(it.originalPreTax)) < 1);
  check("과거 수행 원가 = 원본 지급액(세전) · 납품확인 유지", costOk && perfs.every(x => x.deliveryConfirmed),
    JSON.stringify(orig0.payoutItems.map(it => [it.legacyStatus, it.originalPreTax, it.costTotal])));
  check("⑥ 통번역사 Master 연결(매핑 기반)", perfs.filter(p => p.individualUserId).length === pv.body.perfSummary.total - pv.body.perfSummary.translatorUnmapped);
  check("⑫ 수금: 원본 입금 = 판매금액 → 수금완료 1건(중복 없음)", det.paymentRecords.length === 1 && det.paymentRecords[0].depositConfirmed && Number(det.paymentRecords[0].amount) === Number(pv.body.total));
  const legacyDet = (await call(ADMIN, "GET", `/admin/legacy-archive/${SALE_A}`)).body;
  check("과거 CRM 상세: 전환 여부 표시(activation)", legacyDet.activation?.projectId === PID);

  // 판매목록 1회 표시
  const sh1 = (await call(ADMIN, "GET", "/admin/sales-history?range=all&pageSize=1")).body;
  check("판매목록 총건수 불변(과거 1건 → 운영 1건 대체)", sh1.pagination.total === sh0.pagination.total, `${sh0.pagination.total} → ${sh1.pagination.total}`);
  const comp = pv.body.company.name;
  const shS = (await call(ADMIN, "GET", `/admin/sales-history?range=all&pageSize=200&search=${encodeURIComponent(comp)}`)).body;
  const curRow = shS.rows.find(r => r.source === "current" && r.id === PID);
  check("판매목록: 전환 건은 운영 1건(과거 CRM 배지·원 판매일) · 과거 행 미표시", !!curRow && curRow.origin === "legacy_crm" && curRow.recordDate === pv.body.saleDate && !shS.rows.some(r => r.source === "legacy" && r.id === SALE_A));

  // ── ③ 판매정보(거래처·담당자·상품명) 수정 + 감사로그 ──
  const someCo = await one(sql`SELECT id, name FROM companies WHERE deleted_at IS NULL ORDER BY id LIMIT 1`);
  const up = await call(ADMIN, "PATCH", `/admin/projects/${PID}/info`, { companyId: someCo.id, title: "전환판매 제목 수정" });
  const lg1 = await one(sql`SELECT metadata FROM logs WHERE entity_type='project' AND entity_id=${PID} AND action='project_updated' ORDER BY id DESC LIMIT 1`);
  check("③ 거래처·제목 수정 + 전후 값 감사로그", up.status === 200 && JSON.parse(lg1.metadata).after.companyId === someCo.id && "companyId" in JSON.parse(lg1.metadata).before);
  const itemBody = (price: number, name: string) => ({ items: [{ productName: name, unit: "건", quantity: 1, unitPrice: price, taxRate: 0.1, taxType: "taxable", itemType: "translation" }], quoteType: quote.quoteType, issueDate: quote.issueDate, title: quote.title });
  const noReason = await call(ADMIN, "PUT", `/admin/quotes/${quote.id}`, itemBody(1000000, "상품명 수정"));
  check("④ 판매 확정 건 금액 변경 — 사유 없으면 거부", noReason.status === 400 && noReason.body.code === "REASON_REQUIRED");
  const withReason = await call(ADMIN, "PUT", `/admin/quotes/${quote.id}`, { ...itemBody(1000000, "상품명 수정"), versionReason: "테스트: 금액 정정" });
  const lg2 = await one(sql`SELECT metadata FROM logs WHERE entity_type='quote' AND entity_id=${quote.id} AND action='quote_items_updated' ORDER BY id DESC LIMIT 1`);
  check("④ 금액 변경(사유) → 재계산 1,100,000 · 감사로그 전후값+사유", withReason.status === 200 && withReason.body.price === 1100000 && JSON.parse(lg2.metadata).reason === "테스트: 금액 정정" && JSON.parse(lg2.metadata).before.price === Number(pv.body.total));

  // ── ⑧ 지급완료 수행정보 보호 ──
  const det2 = (await call(ADMIN, "GET", `/admin/projects/${PID}`)).body;
  const asRows = det2.performances.map(p => ({ ...p }));
  const rt = await call(ADMIN, "PUT", `/admin/projects/${PID}/performances`, { rows: asRows, deletedIds: [] });
  const det3 = (await call(ADMIN, "GET", `/admin/projects/${PID}`)).body;
  check("수행정보 변경 없이 저장 → 200 · 금액·상태 불변", rt.status === 200 && JSON.stringify(det3.performances.map(p => [p.id, p.costTotal, p.paymentStatus])) === JSON.stringify(det2.performances.map(p => [p.id, p.costTotal, p.paymentStatus])), String(rt.status) + (rt.body?.error ?? ""));
  const pr = det2.performances.find(p => p.paymentStatus === "paid");
  const tamper = await call(ADMIN, "PUT", `/admin/projects/${PID}/performances`, { rows: [{ ...pr, isDirectAmount: true, directAmount: Number(pr.costTotal) + 50000 }], deletedIds: [] });
  check("⑧ 지급완료 수행정보 금액 변경 차단", tamper.status === 400 && /지급완료/.test(tamper.body.error));
  check("⑧ 지급완료 수행정보 삭제 차단", (await call(ADMIN, "PUT", `/admin/projects/${PID}/performances`, { rows: [], deletedIds: [pr.id] })).status === 400);
  const hr = det2.performances.find(p => p.paymentStatus === "payment_hold");
  const rel = await call(ADMIN, "PUT", `/admin/projects/${PID}/performances`, { rows: [{ ...hr, paymentStatus: "unpaid" }], deletedIds: [] });
  check("과거 지급 확인 필요 건 — 일반 수정으로 보류 해제 차단", rel.status === 400 && /관리자 확인/.test(rel.body.error));
  check("⑯ 과거 지급 확인 처리 권한: pm 403", (await call(PM, "POST", `/admin/performances/${hr.id}/legacy-payout-review`, { decision: "unpaid", reason: "x" })).status === 403);

  // ── ⑤ 수행정보 추가(Master 검색 연결) — 테스트 통번역사(계좌 보유) ──
  const [tu] = await q(sql`INSERT INTO users (email, role, name, password, is_active) VALUES ('act-test-tr@test.invalid','translator','전환테스트통번역사','x',true) RETURNING id`);
  await call(ADMIN, "POST", `/admin/translators/${tu.id}/sensitive`, { paymentMethod: "domestic_withholding", bankName: "기업은행", bankAccount: "01099998888777", accountHolder: "전환테스트통번역사", residentNumber: "9001011234567" });
  const addRow = { quoteId: quote.id, saleItemId: det2.quotes[0].items[0].id, performerCategory: "individual", individualUserId: tu.id, status: "assigned", serviceType: "translation",
    productNameSnapshot: "추가 번역", isDirectAmount: true, directAmount: 200000, deliveryDate: "2031-02-10", deliveryDateManual: true, deliveryConfirmed: true, paymentStatus: "unpaid" };
  const add = await call(PM, "PUT", `/admin/projects/${PID}/performances`, { rows: [addRow], deletedIds: [] });
  let det4 = (await call(ADMIN, "GET", `/admin/projects/${PID}`)).body;
  const added0 = det4.performances.find(p => p.individualUserId === tu.id);
  await call(ADMIN, "PUT", `/admin/projects/${PID}/performances`, { rows: [{ ...added0, deliveryConfirmed: true }], deletedIds: [] });
  det4 = (await call(ADMIN, "GET", `/admin/projects/${PID}`)).body;
  const added = det4.performances.find(p => p.individualUserId === tu.id);
  check("⑤⑥ 수행정보 추가(pm 권한) · Master 연결 · 원가 200,000", add.status === 200 && added && Number(added.costTotal) === 200000, add.body?.error ?? "");
  check("⑯ viewer 수행정보 저장 403 · 역할 미지정 직원 기존대로 허용", (await call(VIEWER, "PUT", `/admin/projects/${PID}/performances`, { rows: [], deletedIds: [] })).status === 403
    && (await call(NOROLE, "PUT", `/admin/projects/${PID}/performances`, { rows: [], deletedIds: [] })).status === 200);
  const lg3 = await one(sql`SELECT metadata FROM logs WHERE entity_type='project' AND entity_id=${PID} AND action='performances_saved' ORDER BY id DESC LIMIT 1`);
  check("⑯ 수행정보 감사로그(변경행 전후값)", !!lg3 && JSON.parse(lg3.metadata).changes.some(c => c.before === null && c.after.individualUserId === tu.id));

  // ── ⑦⑨⑩ 정산: 지급회차 → 지급명세서 → 대량이체 ──
  const round = await call(ADMIN, "POST", "/admin/payout-rounds", { paymentDate: "2031-02-28", periodStart: "2000-01-01", periodEnd: "2031-12-31", collectionBasis: "delivery_date" });
  const rid = round.body.id ?? round.body.round?.id;
  const inRound = await q(sql`SELECT id, payment_status FROM performance_assignments WHERE payout_round_id=${rid}`);
  const ids = inRound.map(r => Number(r.id));
  check("⑦ 지급회차 수집: 신규 미지급만 포함 · 과거 지급완료/확인 필요 제외", ids.includes(added.id) && !ids.includes(pr.id) && !ids.includes(hr.id), `수집 ${ids.length}건`);
  // 과거 지급 확인 → 미지급 확정(재수집 대상) / 다른 건은 지급완료 확정
  const resU = await call(FIN, "POST", `/admin/performances/${hr.id}/legacy-payout-review`, { decision: "unpaid", reason: "통장 확인 결과 미지급" });
  const reRes = await call(ADMIN, "PATCH", `/admin/payout-rounds/${rid}/recollect`, {});
  const inRound2 = (await q(sql`SELECT id FROM performance_assignments WHERE payout_round_id=${rid}`)).map(r => Number(r.id));
  check("과거 지급 확인(finance) → 미지급 확정 시에만 지급회차 수집", resU.status === 200 && inRound2.includes(hr.id), `recollect ${reRes.status}`);
  const stmt = (await call(ADMIN, "GET", `/admin/payout-rounds/${rid}`)).body;
  const stmtIds = (stmt.summary ?? []).flatMap(g => g.items.map(i => i.id));
  check("⑨ 지급명세서(회차 상세) — 포함 건만, 과거 지급완료 건 없음", stmtIds.includes(added.id) && !stmtIds.includes(pr.id));
  await call(ADMIN, "PATCH", `/admin/payout-rounds/${rid}/confirm`, {});
  await call(ADMIN, "POST", `/admin/payout-rounds/${rid}/transfers/generate`);
  const tv = (await call(ADMIN, "GET", `/admin/payout-rounds/${rid}/transfers`)).body;
  for (const t of tv.transfers) if (!(t.status === "ready" && t.verificationStatus === "verified")) await call(ADMIN, "POST", `/admin/payout-rounds/${rid}/transfers/${t.id}/exclude`, { reason: "테스트: 계좌정보 없음" });
  const ibk = await call(ADMIN, "POST", `/admin/payout-rounds/${rid}/transfers/ibk-file`);
  let ibkTxt = "";
  if (Buffer.isBuffer(ibk.body)) { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(ibk.body); wb.worksheets[0].eachRow(r => { ibkTxt += JSON.stringify(r.values) + "\n"; }); }
  check("⑩ 기업은행 대량이체 파일 — 신규 지급(세후 193,400) 포함", ibk.status === 200 && ibkTxt.includes("193400"), `status ${ibk.status}`);
  const paid = await call(ADMIN, "PATCH", `/admin/payout-rounds/${rid}/pay`, {});
  const aPaid = await one(sql`SELECT payment_status FROM performance_assignments WHERE id=${added.id}`);
  const round2 = await call(ADMIN, "POST", "/admin/payout-rounds", { paymentDate: "2031-03-31", periodStart: "2000-01-01", periodEnd: "2031-12-31", collectionBasis: "delivery_date" });
  const rid2 = round2.body.id ?? round2.body.round?.id;
  const again2 = (await q(sql`SELECT id FROM performance_assignments WHERE payout_round_id=${rid2}`)).map(r => Number(r.id));
  check("중복 지급 방지: 지급완료 후 다음 회차에 재수집 없음", paid.status === 200 && aPaid.payment_status === "paid" && !again2.includes(added.id) && !again2.includes(pr.id));
  const tax = (await call(ADMIN, "GET", "/admin/tax-report?from=2000-01-01&to=2031-12-31")).body;
  const taxIds = JSON.stringify(tax).match(/"assignmentId":\d+|"id":\d+/g) ?? [];
  check("원천세 신고자료: 과거 지급완료(회차 없음) 건 미포함", !JSON.stringify(tax).includes(`"assignmentId":${pr.id},`) && !taxIds.includes(`"id":${pr.id}`));

  // ── ⑪⑫ 수금: 확정 기록 보호 · 부분입금·잔금 ──
  const pay0 = det.paymentRecords[0];
  const payRow = (r: any) => ({ id: r.id, issueDate: r.issueDate, expectedDate: r.expectedDate, paidDate: r.paidDate, paymentType: r.paymentType, paymentMethod: r.paymentMethod,
    supplyAmount: Number(r.supplyAmount), vatAmount: Number(r.vatAmount), amount: Number(r.amount), depositStatus: r.depositStatus, depositConfirmed: r.depositConfirmed, note: r.note });
  check("⑫ 확정 수금기록 금액 변경 차단", (await call(ADMIN, "PUT", `/admin/projects/${PID}/payment-records`, { rows: [{ ...payRow(pay0), amount: 1 }], deletedIds: [] })).status === 409);
  check("⑫ 확정 수금기록 삭제 차단", (await call(ADMIN, "PUT", `/admin/projects/${PID}/payment-records`, { rows: [], deletedIds: [pay0.id] })).status === 409);
  check("⑫ 확정 기록 비고 수정은 허용", (await call(ADMIN, "PUT", `/admin/projects/${PID}/payment-records`, { rows: [{ ...payRow(pay0), note: `${pay0.note} (확인)` }], deletedIds: [] })).status === 200);
  check("⑯ viewer 수금 저장 403", (await call(VIEWER, "PUT", `/admin/projects/${PID}/payment-records`, { rows: [], deletedIds: [] })).status === 403);

  // B: 입금합계 불일치 → 수금 확인 대상(자동 수금완료 없음) → 부분입금 + 잔금
  const pvB = (await call(ADMIN, "GET", `/admin/legacy-archive/${SALE_B}/activation-preview`)).body;
  const aB = await call(ADMIN, "POST", `/admin/legacy-archive/${SALE_B}/activate`, { confirm: true, planToken: pvB.planToken });
  const PB = aB.body.projectId;
  const detB = (await call(ADMIN, "GET", `/admin/projects/${PB}`)).body;
  const origB = (await call(ADMIN, "GET", `/admin/projects/${PB}/legacy-origin`)).body.origin;
  check("⑪ 입금 불일치 → 수금 확인 대상 · 수금기록 자동생성 없음", aB.status === 201 && pvB.collection.status === "review" && detB.paymentRecords.length === 0 && origB.collection.status === "collection_review", pvB.collection.reason);
  const totB = Number(pvB.total), half = Math.round(totB / 2);
  const s1 = await call(ADMIN, "PUT", `/admin/projects/${PB}/payment-records`, { rows: [
    { expectedDate: "2031-01-10", paidDate: "2031-01-10", paymentType: "advance", supplyAmount: half, vatAmount: 0, amount: half, depositStatus: "completed", depositConfirmed: true },
    { expectedDate: "2031-02-10", paymentType: "balance", supplyAmount: totB - half, vatAmount: 0, amount: totB - half, depositStatus: "scheduled", depositConfirmed: false }], deletedIds: [] });
  const recs = s1.body.rows;
  const paidSum = recs.filter(r => r.depositConfirmed).reduce((s, r) => s + Number(r.amount), 0);
  check("⑪ 부분입금(선입금 확정) + 잔금 예정 → 미수금 = 잔액", s1.status === 200 && paidSum === half && totB - paidSum === totB - half, `판매 ${totB} 입금 ${paidSum} 미수 ${totB - paidSum}`);

  // C: 수행행 없는 판매 → 상품 1개 · 수행 0
  const pvC = (await call(ADMIN, "GET", `/admin/legacy-archive/${SALE_C}/activation-preview`)).body;
  check("상품정보: 수행행 없는 판매도 원본 상품명 1개 항목(분할·추정 없음)", pvC.perfSummary.total === 0 && pvC.productName && pvC.warnings.some(w => w.includes("총액")));

  // ── ⑬ CRM 원본 보존 ──
  const A1 = await archiveHash(), L1 = await linkHash();
  check("⑬ 과거 CRM 원본행·연결 불변(전환·수정·정산 후)", JSON.stringify(A1) === JSON.stringify(A0) && JSON.stringify(L1) === JSON.stringify(L0));

  // ── ⑭ 재업로드 시 운영정보 보존 ──
  const projBefore = await one(sql`SELECT md5(row(p.*)::text) h FROM projects p WHERE id=${PID}`);
  const quoteBefore = await one(sql`SELECT md5(string_agg(row(q.*)::text, '' ORDER BY id)) h FROM quotes q WHERE project_id=${PID}`);
  const perfBefore = await one(sql`SELECT md5(string_agg(id||':'||cost_total||':'||payment_status, ',' ORDER BY id)) h FROM performance_assignments WHERE project_id=${PID}`);
  const sales = await q(sql`SELECT id, source_sheet, source_raw FROM legacy_archive_rows WHERE source_type='sales_list' AND is_effective ORDER BY source_sheet, source_row, id`);
  const headers: string[] = []; for (const r of sales) for (const k of Object.keys(r.source_raw)) if (!headers.includes(k)) headers.push(k);
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Sheet1"); ws.addRow(headers);
  for (const r of sales) { const raw = { ...r.source_raw }; if (Number(r.id) === SALE_A) raw["총액"] = String(Number(String(raw["총액"]).replace(/,/g, "")) + 5000); ws.addRow(headers.map(h => raw[h] == null || raw[h] === "" ? null : String(raw[h]))); }
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const p = await buildSyncPreview(db, { buffer: buf, sourceType: "sales_list", scope: "full" });
  cachePreview(p, null);
  const ex = await db.transaction(async (tx) => executeArchiveSync(tx, { buffer: buf, sourceType: "sales_list", fileName: "reupload.xlsx", performerId: null, scope: "full", planToken: p.planToken, approvedAmbiguous: new Set() }));
  const origA = (await call(ADMIN, "GET", `/admin/projects/${PID}/legacy-origin`)).body.origin;
  const projAfter = await one(sql`SELECT md5(row(p.*)::text) h FROM projects p WHERE id=${PID}`);
  const quoteAfter = await one(sql`SELECT md5(string_agg(row(q.*)::text, '' ORDER BY id)) h FROM quotes q WHERE project_id=${PID}`);
  const perfAfter = await one(sql`SELECT md5(string_agg(id||':'||cost_total||':'||payment_status, ',' ORDER BY id)) h FROM performance_assignments WHERE project_id=${PID}`);
  const sh2 = (await call(ADMIN, "GET", "/admin/sales-history?range=all&pageSize=1")).body;
  check("⑭ 재업로드(원본 총액 변경 1건) → 원본 새 버전 · 운영 판매/견적/수행 불변", ex.applied.updated === 1 && projAfter.h === projBefore.h && quoteAfter.h === quoteBefore.h && perfAfter.h === perfBefore.h, JSON.stringify(ex.applied));
  check("⑭ 운영 상세에 '원본 변경 감지' 표시 · 판매목록 중복 없음", origA.sourceChanged === true && sh2.pagination.total === sh1.pagination.total);

  // ── ⑮ 신규 판매건 기존 기능 ──
  const [np] = await q(sql`INSERT INTO projects (user_id, title, status, company_id) VALUES (10, '신규판매 회귀', 'approved', ${someCo.id}) RETURNING id`);
  const [nq] = await q(sql`INSERT INTO quotes (project_id, quote_number, title, price, status, quote_type, issue_date) VALUES (${np.id}, 'TQ-ACT-1', '신규판매 회귀', 110000, 'approved', 'b2b_standard', '2031-01-05') RETURNING id`);
  await q(sql`INSERT INTO quote_items (quote_id, product_name, unit, quantity, unit_price, supply_amount, tax_amount, total_amount, item_type, tax_type) VALUES (${nq.id}, '신규 번역', '건', 1, 100000, 100000, 10000, 110000, 'translation', 'taxable')`);
  const nd = (await call(ADMIN, "GET", `/admin/projects/${np.id}`)).body;
  const nOrigin = (await call(ADMIN, "GET", `/admin/projects/${np.id}/legacy-origin`)).body;
  const nSame = await call(ADMIN, "PUT", `/admin/quotes/${nq.id}`, { items: [{ productName: "신규 번역 수정", unit: "건", quantity: 1, unitPrice: 100000, taxRate: 0.1, taxType: "taxable", itemType: "translation" }], quoteType: "b2b_standard", issueDate: "2031-01-05", title: "신규판매 회귀" });
  const nPerf = await call(ADMIN, "PUT", `/admin/projects/${np.id}/performances`, { rows: [{ ...addRow, quoteId: nq.id, saleItemId: null, deliveryDate: "2031-04-10" }], deletedIds: [] });
  const nPay = await call(ADMIN, "PUT", `/admin/projects/${np.id}/payment-records`, { rows: [{ expectedDate: "2031-01-20", paidDate: "2031-01-20", paymentType: "lump_sum", supplyAmount: 100000, vatAmount: 10000, amount: 110000, depositStatus: "completed", depositConfirmed: true }], deletedIds: [] });
  const shN = (await call(ADMIN, "GET", `/admin/sales-history?range=all&pageSize=50&search=${encodeURIComponent(someCo.name)}`)).body;
  check("⑮ 신규 판매: 상세·금액 동일 수정(사유 불필요)·수행 추가·수금 저장·목록 표시(배지 없음)", nd.id === np.id && nOrigin.origin === null && nSame.status === 200 && nPerf.status === 200 && nPay.status === 200
    && shN.rows.some(r => r.source === "current" && r.id === np.id && !r.origin), `${nSame.status}/${nPerf.status}/${nPay.status}`);

  // ── ⑯ 감사로그 종합 ──
  const acts = (await q(sql`SELECT DISTINCT action FROM logs WHERE (entity_type='project' AND entity_id IN (${PID}, ${PB}, ${np.id})) OR (entity_type='quote' AND entity_id=${quote.id})`)).map(r => r.action);
  const need = ["legacy_sale_activated", "project_updated", "quote_items_updated", "performances_saved", "payment_records_saved", "legacy_payout_review_resolved"];
  check("⑯ 감사로그: 전환·판매수정·금액변경·수행·수금·과거지급확인 기록", need.every(a => acts.includes(a)), need.filter(a => !acts.includes(a)).join(",") || "모두 기록");

  console.log(`\n결과: PASS ${pass} / FAIL ${fail}`);
  console.log(JSON.stringify({ PID, PB, saleNoA }));
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error("테스트 오류:", e); process.exit(1); });
