// 수행자 ↔ 지급대상 신원 불일치 — 실제 브라우저(헤드리스 Chrome · CDP) 검증. 브라우저 구동 헬퍼는 export-access.e2e.mjs 와 같다.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";

const require = createRequire(new URL("../../api-server/package.json", import.meta.url));
const jwt = require("jsonwebtoken"); const pg = require("pg");
if (!process.env.DATABASE_URL || process.env.DATABASE_URL === process.env.PROD_DATABASE_URL) { console.error("개발 DB 전용 테스트입니다."); process.exit(1); }
const WEB = process.env.TEST_WEB ?? "http://localhost:8090";
const SECRET = process.env.JWT_SECRET ?? "translation-platform-jwt-secret-dev";
const CHROME = process.env.CHROME_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const q1 = async (s, a = []) => (await pool.query(s, a)).rows[0];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✅" : "❌"} ${n}${ok ? "" : " — " + JSON.stringify(d)}`); };

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "export-e2e-"));
const PORT = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, "--window-size=1600,1000", "--renderer-process-limit=2", "--disable-extensions", "about:blank"], { stdio: "ignore" });
async function newTab() {
  for (let i = 0; i < 40; i++) { await sleep(250); try { await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { /* 기동 중 */ } }
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.addEventListener("open", r));
  let seq = 0; const pend = new Map(); const downloads = [];
  ws.addEventListener("message", e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    else if (m.method === "Page.downloadWillBegin") downloads.push(m.params.suggestedFilename); });
  const send = (method, params = {}) => new Promise((r, j) => { const id = ++seq; pend.set(id, m => m.error ? j(new Error(method + ": " + m.error.message)) : r(m.result)); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async expr => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
  const waitFor = async (expr, ms = 20000, label = expr) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* 이동 중 */ } await sleep(200); } throw new Error("대기 초과: " + label); };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: profile });
  return { ws, send, ev, waitFor, downloads, goto: async url => { await send("Page.navigate", { url }); await sleep(500); } };
}
const has = id => `!!document.querySelector('[data-testid="${id}"]')`;


// ─── 수행자 ↔ 지급대상 신원 불일치 — 실제 브라우저 검증(2026-11-28) · 개발 DB 전용 · TEST_WEB(기본 :8090, 새 빌드 서버) ───
//   ① 지급준비점검 사유에 '신원 불일치'(수행자·연결 지급대상) 표시 ② 지급확정 클릭 → 서버 차단 안내, 회차 draft 유지
//   ③ 수행정보 저장(화면과 같은 요청 · 변경 사유)으로 정정 ④ 점검 경고 해소 · 지급대상별 요약·건별 상세내역 반영 ⑤ 지급확정 성공
//   화면 캡처는 SHOT_DIR 에 저장. fixture 는 끝나면 삭제.
import crypto from "node:crypto";
const SHOT_DIR = process.env.SHOT_DIR ?? os.tmpdir();
const TAG = "[E2E-ID]", PAYDATE = "2031-05-30";
const encKey = crypto.scryptSync(process.env.SENSITIVE_ENCRYPT_KEY ?? "dev-fallback-key-change-in-prod-!!", "translator-sensitive-v1", 32);
const enc = (t) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv("aes-256-gcm", encKey, iv); const e = Buffer.concat([c.update(t, "utf8"), c.final()]); return `${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${e.toString("hex")}`; };
const RRN_A = "8001011000001", RRN_B = "8102022000002";   // 합성 번호(실존 번호 아님)
const shot = async (tab, name) => { const r = await tab.send("Page.captureScreenshot", { format: "png" }); const f = path.join(SHOT_DIR, `payee-identity-${name}.png`); fs.writeFileSync(f, Buffer.from(r.data, "base64")); console.log("     📷", f); };
const bodyHas = (t) => `document.body.innerText.includes(${JSON.stringify(t)})`;
async function cleanup() {
  const pids = (await pool.query(`SELECT id FROM projects WHERE title LIKE $1`, [TAG + "%"])).rows.map(r => r.id);
  const rids = (await pool.query(`SELECT id FROM payout_rounds WHERE note LIKE $1`, [TAG + "%"])).rows.map(r => r.id);
  const uids = (await pool.query(`SELECT id FROM users WHERE name LIKE $1`, [TAG + "%"])).rows.map(r => r.id);
  await pool.query(`DELETE FROM payout_transfers WHERE payout_round_id = ANY($1)`, [rids]);
  await pool.query(`DELETE FROM payout_round_items WHERE payout_round_id = ANY($1)`, [rids]);
  await pool.query(`DELETE FROM logs WHERE entity_type = 'project' AND entity_id = ANY($1)`, [pids]);
  await pool.query(`DELETE FROM performance_assignments WHERE project_id = ANY($1)`, [pids]);
  await pool.query(`DELETE FROM payout_rounds WHERE id = ANY($1)`, [rids]);
  await pool.query(`DELETE FROM projects WHERE id = ANY($1)`, [pids]);
  await pool.query(`DELETE FROM translator_sensitive WHERE translator_id = ANY($1)`, [uids]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [uids]);
  await pool.query(`DELETE FROM companies WHERE name LIKE $1`, [TAG + "%"]);
}
const sids2 = [];
async function session2(u) {
  const sid = randomUUID(); sids2.push(sid);
  await pool.query(`INSERT INTO user_sessions (user_id, session_id, role_type, login_at, last_activity_at, user_agent, is_online, date_key)
    VALUES ($1,$2,$3,now(),now(),'automated-test',true,to_char(now(),'YYYY-MM-DD'))`, [u.id, sid, u.role]);
  return jwt.sign({ id: u.id, email: u.email, role: u.role, roleId: u.role_id, sessionId: sid }, SECRET, { expiresIn: "1h" });
}
async function openDetail(tab, token, user) {
  await tab.goto(WEB + "/");
  await tab.ev(`localStorage.setItem('auth_token', ${JSON.stringify(token)}); localStorage.setItem('auth_user', ${JSON.stringify(JSON.stringify(user))}); sessionStorage.setItem('veritasRestoreTab', 'settlements'); true`);
  await tab.goto(WEB + "/");
  await tab.waitFor(has(`pu-round-${PAYDATE}`), 30000, "지급회차 목록의 " + PAYDATE);
  await tab.ev(`document.querySelector('[data-testid="pu-round-${PAYDATE}"]').click(), true`);
  await tab.waitFor(has("pd-tab-readiness"), 20000, "지급회차 상세");
  await tab.ev(`document.querySelector('[data-testid="pd-tab-readiness"]').click(), true`);   // 마지막 탭 복원과 무관하게 지급준비점검부터
}
async function confirmClick(tab) {
  await tab.ev(`document.querySelector('[data-testid="pd-tab-operational"]').click(), true`);
  await tab.waitFor(has("payout-confirm"), 25000, "지급확정 버튼");
  await tab.ev(`document.querySelector('[data-testid="payout-confirm"]').click(), true`);
  await tab.waitFor(has("dialog-confirm"), 8000, "확인 대화상자");
  await tab.ev(`document.querySelector('[data-testid="dialog-confirm"]').click(), true`);
}
let tab;
try {
  await cleanup();
  const admin = await q1(`SELECT id, email, role, role_id, name FROM users WHERE role='admin' AND role_id IS NULL AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1`);
  const mk = async (name, rrn) => { const u = await q1(`INSERT INTO users (email, name, role, is_active) VALUES ($1,$2,'translator',true) RETURNING id`, [`e2e-id-${randomUUID().slice(0, 8)}@test.local`, name]);
    await pool.query(`INSERT INTO translator_sensitive (translator_id, resident_number, payment_method) VALUES ($1,$2,'domestic_withholding')`, [u.id, enc(rrn)]); return u.id; };
  const A = await mk(`${TAG}갑통역사`, RRN_A), Bk = await mk(`${TAG}을통역사`, RRN_B);
  const co = await q1(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [TAG + "테스트거래처"]);
  const pj = await q1(`INSERT INTO projects (user_id, title, company_id, company_name_snapshot) VALUES ($1,$2,$3,$4) RETURNING id`, [admin.id, TAG + "통역", co.id, TAG + "테스트거래처"]);
  const rd = await q1(`INSERT INTO payout_rounds (batch_number, payment_date, period_start, period_end, status, note) VALUES ($1,$2,$2,$2,'draft',$3) RETURNING id`, [PAYDATE + " 지급회차", PAYDATE, TAG + "회차"]);
  const mkPa = async (seq, uid, snap, rrn, cost) => (await q1(`INSERT INTO performance_assignments
      (project_id, sequence, performer_category, cost_type, payee_type, individual_user_id, performer_name_snapshot, identifier_snapshot_enc, identifier_snapshot_masked,
       status, service_type, product_name_snapshot, delivery_date, delivery_confirmed, expected_payment_date, withholding_treatment, residency_type,
       is_direct_amount, direct_amount, base_performance_fee, cost_total, payment_status, payout_round_id, line_category)
    VALUES ($1,$2,'individual','individual','individual',$3,$4,$5,$6,'completed','interpretation','영어동시통역 외5','2031-05-10',true,$7,'domestic_3_3','domestic_resident',true,$8,$9,$9,'unpaid',$10,'통번역사') RETURNING id`,
    [pj.id, seq, uid, snap, enc(rrn), rrn.slice(0, 6) + "-*******", PAYDATE, cost / 0.85, cost, rd.id])).id;
  const okA = await mkPa(1, A, `${TAG}갑통역사`, RRN_A, 85000);
  const bad = await mkPa(4, A, `${TAG}을통역사`, RRN_B, 85000);   // #123 재현: 스냅샷 = 을통역사, 내부 연결 = 갑통역사
  const TA = await session2(admin);
  const user = { id: admin.id, email: admin.email, role: "admin", roleId: null, name: admin.name };
  tab = await newTab();

  console.log("\n[1] 지급준비점검 — 신원 불일치 표시");
  await openDetail(tab, TA, user);
  await tab.waitFor(has(`ready-row-current:${bad}`), 30000, "점검 행");
  const reason = await tab.ev(`document.querySelector('[data-testid="ready-reason-current:${bad}"]')?.innerText ?? ''`);
  const rowTxt = await tab.ev(`document.querySelector('[data-testid="ready-row-current:${bad}"]').innerText`);
  check("사유: 신원 불일치 · 수행자 을통역사 · 지급대상 갑통역사", /^신원 불일치/.test(reason) && reason.includes("을통역사") && reason.includes("갑통역사"), reason);
  check("행: 거래처·금액 표시", rowTxt.includes(TAG + "테스트거래처") && rowTxt.includes("85,000"), rowTxt.slice(0, 200));
  check("화면에 주민번호 원문 없음", !(await tab.ev(`/\\d{6}-?[1-4]\\d{6}/.test(document.body.innerText)`)));
  const okReason = await tab.ev(`document.querySelector('[data-testid="ready-reason-current:${okA}"]')?.innerText ?? ''`);
  check("정상 건에는 신원 경고 없음", !okReason.includes("신원"), okReason);
  await tab.ev(`document.querySelector('[data-testid="ready-row-current:${bad}"]').scrollIntoView({block:'center'}), true`); await sleep(400);
  await shot(tab, "1-readiness-mismatch");

  console.log("\n[2] 지급확정·은행이체 — 지급확정 클릭 → 서버 차단");
  await confirmClick(tab);
  await tab.waitFor(bodyHas("신원이 다른 건"), 15000, "차단 안내");
  const toast = await tab.ev(`[...document.querySelectorAll('div,span')].map(e => e.innerText).filter(t => t && t.includes('수행자와 지급대상의 신원이 다른 건')).sort((a, b) => a.length - b.length)[0] ?? ''`);
  check("차단 안내: 거래처·수행자·지급대상·금액", toast.includes(TAG + "테스트거래처") && toast.includes("을통역사") && toast.includes("갑통역사") && toast.includes("82,195원"), toast);
  await shot(tab, "2-confirm-blocked");
  check("회차 상태 draft 유지", (await q1(`SELECT status FROM payout_rounds WHERE id=$1`, [rd.id])).status === "draft");

  console.log("\n[3] 수행정보 저장으로 정정(판매관리 수행정보 화면과 같은 1행 저장 요청 + 변경 사유)");
  const row = (await pool.query(`SELECT * FROM performance_assignments WHERE id=$1`, [bad])).rows[0];
  const payload = { id: row.id, sequence: row.sequence, performerCategory: "individual", costType: "individual", individualUserId: Bk, vendorCompanyId: null,
    status: row.status, lineCategory: row.line_category, performerNameSnapshot: row.performer_name_snapshot, serviceType: row.service_type, productNameSnapshot: row.product_name_snapshot,
    deliveryDate: "2031-05-10", deliveryConfirmed: true, expectedPaymentDate: PAYDATE, withholdingTreatment: "domestic_3_3", residencyType: "domestic_resident",
    isDirectAmount: true, directAmount: Number(row.direct_amount), paymentStatus: "unpaid" };
  const put = await tab.ev(`fetch('/api/admin/projects/${pj.id}/performances', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('auth_token') },
    body: JSON.stringify({ rows: [${JSON.stringify(payload)}], deletedIds: [], changeReason: '수행자-지급대상 오연결 정정(실제 수행자 을통역사)' }) }).then(async r => ({ s: r.status, d: await r.json() }))`);
  check("저장 200", put.s === 200, put);
  const after = await q1(`SELECT individual_user_id, performer_name_snapshot, cost_total FROM performance_assignments WHERE id=$1`, [bad]);
  check("지급대상 = 을통역사 · 스냅샷 유지 · 금액 불변", Number(after.individual_user_id) === Bk && after.performer_name_snapshot === `${TAG}을통역사` && Number(after.cost_total) === 85000, after);

  console.log("\n[4] 화면 재조회 — 점검 경고 해소 · 지급대상별 요약 · 건별 상세내역");
  await openDetail(tab, TA, user);
  await tab.waitFor(has(`ready-row-current:${bad}`), 30000, "점검 행");
  const reason2 = await tab.ev(`document.querySelector('[data-testid="ready-reason-current:${bad}"]')?.innerText ?? ''`);
  check("점검 사유에서 신원 불일치 해소", !reason2.includes("신원"), reason2);
  await tab.ev(`document.querySelector('[data-testid="pd-tab-payees"]').click(), true`);
  await tab.waitFor(has(`pu-payee-${TAG}을통역사`), 20000, "지급대상별 요약 을통역사");
  const pA = await tab.ev(`document.querySelector('[data-testid="pu-payee-${TAG}갑통역사"]')?.innerText ?? ''`), pB = await tab.ev(`document.querySelector('[data-testid="pu-payee-${TAG}을통역사"]')?.innerText ?? ''`);
  check("지급대상별 요약: 갑통역사 82,195 · 을통역사 82,195", pA.includes("82,195") && pB.includes("82,195"), { pA: pA.slice(0, 160), pB: pB.slice(0, 160) });
  await shot(tab, "3-payees-after");
  await tab.ev(`document.querySelector('[data-testid="pd-tab-items"]').click(), true`);
  await tab.waitFor(has("pu-detail-0"), 20000, "건별 상세내역");
  const det = await tab.ev(`[...document.querySelectorAll('tr[data-testid^="pu-detail-"]:not([data-testid="pu-detail-total"])')].map(e => e.innerText.replace(/\\s+/g, ' '))`);
  check("건별 상세내역 2건 · 같은 판매 안 수행자 가나다순(갑통역사 → 을통역사)", det.length === 2 && det[0].includes("갑통역사") && det[1].includes("을통역사"), det);
  await shot(tab, "4-items-after");

  console.log("\n[5] 지급확정 성공");
  await confirmClick(tab);
  await tab.waitFor(bodyHas("지급확정되었습니다"), 20000, "확정 완료 안내");
  check("회차 confirmed", (await q1(`SELECT status FROM payout_rounds WHERE id=$1`, [rd.id])).status === "confirmed");
  await shot(tab, "5-confirmed");
} catch (e) { fail++; console.log("  ❌ 중단:", e.message); try { if (tab) await shot(tab, "error"); } catch { /* */ } }
finally {
  try { tab?.ws.close(); } catch { /* 무시 */ }
  chrome.kill("SIGTERM"); await sleep(600); try { chrome.kill("SIGKILL"); } catch { /* 무시 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 무시 */ }
  try { await cleanup(); if (sids2.length) await pool.query(`DELETE FROM user_sessions WHERE session_id = ANY($1)`, [sids2]);
    const left = await q1(`SELECT (SELECT count(*) FROM users WHERE name LIKE $1)::int u, (SELECT count(*) FROM payout_rounds WHERE note LIKE $1)::int r`, [TAG + "%"]);
    console.log(`\n정리 완료 — 남은 테스트 데이터: 통번역사 ${left.u} · 회차 ${left.r}`); } catch (e) { console.log("정리 실패", e.message); fail++; }
  await pool.end();
}
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
