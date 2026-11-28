// 지급회차 상세 — 지급대상별 요약 → 건별 상세내역 '뒤로가기' 복귀 · 실제 브라우저(헤드리스 Chrome · CDP) 검증. 브라우저 구동 헬퍼는 export-access.e2e.mjs 와 같다.
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


// ─── 지급회차 상세 — 지급대상별 요약 → 건별 상세내역 '뒤로가기' 복귀(2026-11-28) · 개발 DB 전용 · TEST_WEB(기본 :8090) ───
//   ① 요약에서 외주업체·통번역사 클릭 → 건별 상세(해당 지급대상) · 좌측 상단 '뒤로가기'
//   ② 뒤로가기 → 같은 회차 지급대상별 요약 · 스크롤 위치 복원 · 상세 필터(지급대상) 유지
//   ③ 요약 화면의 '지급회차 목록' → 지급회차 목록 ④ 건별 상세 탭 직접 진입 → '지급회차 목록'(기존 동작)
//   ⑤ 지급대상 클릭 후 다른 탭을 직접 누르면 '뒤로가기' 해제. fixture 는 끝나면 삭제.
const SHOT_DIR = process.env.SHOT_DIR ?? os.tmpdir();
const TAG = "[E2E-BACK]", PAYDATE = "2031-06-30";
const shot = async (tab, name) => { const r = await tab.send("Page.captureScreenshot", { format: "png" }); const f = path.join(SHOT_DIR, `detail-back-${name}.png`); fs.writeFileSync(f, Buffer.from(r.data, "base64")); console.log("     📷", f); };
async function cleanup() {
  const pids = (await pool.query(`SELECT id FROM projects WHERE title LIKE $1`, [TAG + "%"])).rows.map(r => r.id);
  const uids = (await pool.query(`SELECT id FROM users WHERE name LIKE $1`, [TAG + "%"])).rows.map(r => r.id);
  await pool.query(`DELETE FROM logs WHERE entity_type = 'project' AND entity_id = ANY($1)`, [pids]);
  await pool.query(`DELETE FROM performance_assignments WHERE project_id = ANY($1)`, [pids]);
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
// 요약 표의 세로 스크롤 컨테이너(페이지 레이아웃) — 스크롤 가능한 가장 가까운 조상, 없으면 문서
const SCROLLER = `(() => { let el = document.querySelector('[data-testid="pu-payee-panel"]')?.parentElement; while (el) { const s = getComputedStyle(el); if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 5) return el; el = el.parentElement; } return document.scrollingElement; })()`;
const backLabel = `document.querySelector('[data-testid="pd-back"]')?.innerText.trim()`;
const activeTab = `[...document.querySelectorAll('[role="tab"]')].find(b => b.getAttribute('aria-selected') === 'true')?.dataset.testid`;
let tab;
try {
  await cleanup();
  const admin = await q1(`SELECT id, email, role, role_id, name FROM users WHERE role='admin' AND role_id IS NULL AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1`);
  const co = await q1(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [TAG + "거래처"]);
  const vendor = await q1(`INSERT INTO companies (name, is_vendor, company_type) VALUES ($1, true, 'vendor') RETURNING id`, [TAG + "하늘장비"]);
  const pj = await q1(`INSERT INTO projects (user_id, title, company_id, company_name_snapshot) VALUES ($1,$2,$3,$4) RETURNING id`, [admin.id, TAG + "판매", co.id, TAG + "거래처"]);
  const mkPa = async (seq, cat, uid, vid, name, cost) => pool.query(`INSERT INTO performance_assignments
      (project_id, sequence, performer_category, cost_type, payee_type, individual_user_id, vendor_company_id, performer_name_snapshot, status, service_type, product_name_snapshot,
       delivery_date, delivery_confirmed, expected_payment_date, withholding_treatment, residency_type, is_direct_amount, direct_amount, base_performance_fee, cost_total, payment_status, line_category)
    VALUES ($1,$2,$3::text::performance_performer_category,$3::text::performance_cost_type,$3::text,$4,$5,$6,'completed','interpretation','통역','2031-06-10',true,$7,$8,$9,true,$10,$10,$10,'unpaid',$11)`,
    [pj.id, seq, cat, uid, vid, name, PAYDATE, cat === "individual" ? "domestic_3_3" : null, cat === "individual" ? "domestic_resident" : null, cost, cat === "individual" ? "통번역사" : "장비업체"]);
  const names = [];
  for (let i = 1; i <= 25; i++) {   // 요약 표가 화면보다 길어지도록 지급대상 25명 + 외주업체 1곳
    const nm = `${TAG}통역사${String(i).padStart(2, "0")}`; names.push(nm);
    const u = await q1(`INSERT INTO users (email, name, role, is_active) VALUES ($1,$2,'translator',true) RETURNING id`, [`e2e-back-${randomUUID().slice(0, 8)}@test.local`, nm]);
    await mkPa(i, "individual", u.id, null, nm, 100000 + i * 1000);
  }
  await mkPa(99, "vendor", null, vendor.id, TAG + "하늘장비", 500000);
  const TA = await session2(admin);
  const user = { id: admin.id, email: admin.email, role: "admin", roleId: null, name: admin.name };
  tab = await newTab();
  await tab.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await tab.goto(WEB + "/");
  await tab.ev(`localStorage.setItem('auth_token', ${JSON.stringify(TA)}); localStorage.setItem('auth_user', ${JSON.stringify(JSON.stringify(user))}); sessionStorage.setItem('veritasRestoreTab', 'settlements'); true`);
  await tab.goto(WEB + "/");
  const openDetail = async () => {
    await tab.waitFor(has(`pu-round-${PAYDATE}`), 30000, "지급회차 목록 " + PAYDATE);
    await tab.ev(`document.querySelector('[data-testid="pu-round-${PAYDATE}"]').click(), true`);
    await tab.waitFor(has("pd-tab-payees"), 20000, "지급회차 상세");
    await tab.ev(`document.querySelector('[data-testid="pd-tab-payees"]').click(), true`);
    await tab.waitFor(has(`pu-payee-${TAG}하늘장비`), 20000, "지급대상별 요약");
  };
  await openDetail();
  check("요약 화면 좌측 상단 = '지급회차 목록'", (await tab.ev(backLabel)) === "지급회차 목록", await tab.ev(backLabel));

  for (const [label, who] of [["외주업체", `${TAG}하늘장비`], ["통번역사", `${TAG}통역사20`]]) {
    console.log(`\n[${label}] 요약 → 건별 상세 → 뒤로가기`);
    // 요약 화면을 아래로 스크롤해 둔 상태에서 지급대상 클릭
    await tab.ev(`(() => { const r = document.querySelector('[data-testid="pu-payee-${who}"]'); r.scrollIntoView({ block: 'center' }); return true; })()`); await sleep(300);
    const before = await tab.ev(`${SCROLLER}.scrollTop`);
    check(`요약 화면이 스크롤된 상태(${before}px)`, before > 100, before);
    await shot(tab, `${label}-1-summary`);
    await tab.ev(`document.querySelector('[data-testid="pu-payee-${who}"]').click(), true`);
    await tab.waitFor(`${activeTab} === 'pd-tab-items'`, 10000, "건별 상세 탭");
    await tab.waitFor(has("pu-detail-0"), 15000, "건별 상세 행");
    const rows = await tab.ev(`[...document.querySelectorAll('tr[data-testid^="pu-detail-"]:not([data-testid="pu-detail-total"])')].map(e => e.innerText)`);
    check(`건별 상세 = ${who} 건만`, rows.length >= 1 && rows.every(t => t.includes(who)), rows.length);
    check("좌측 상단 = '뒤로가기'", (await tab.ev(backLabel)) === "뒤로가기", await tab.ev(backLabel));
    await shot(tab, `${label}-2-items`);
    await tab.ev(`document.querySelector('[data-testid="pd-back"]').click(), true`);
    await tab.waitFor(`${activeTab} === 'pd-tab-payees'`, 10000, "요약 탭 복귀");
    await sleep(400);
    const after = await tab.ev(`${SCROLLER}.scrollTop`);
    check(`같은 회차 지급대상별 요약으로 복귀(${PAYDATE})`, (await tab.ev(`document.querySelector('[data-testid="pd-title"]').innerText`)).includes("2031.06.30") && await tab.ev(has(`pu-payee-${who}`)));
    check(`스크롤 위치 복원(${before} → ${after}px)`, Math.abs(after - before) <= 2, { before, after });
    check("복귀 후 좌측 상단 = '지급회차 목록'", (await tab.ev(backLabel)) === "지급회차 목록");
    await shot(tab, `${label}-3-back`);
  }

  console.log("\n[건별 상세 필터 유지] 지급대상 클릭으로 정한 지급대상·상태 필터는 탭 이동 후에도 유지");
  await tab.ev(`document.querySelector('[data-testid="pd-tab-items"]').click(), true`);
  await tab.waitFor(has("pd-item-payee"), 10000, "건별 상세");
  const keptPayee = await tab.ev(`document.querySelector('[data-testid="pd-item-payee"]').selectedOptions[0].innerText`);
  check("건별 상세 지급대상 필터 유지(마지막 선택 지급대상)", keptPayee.includes(`${TAG}통역사20`), keptPayee);

  console.log("\n[직접 진입] 건별 상세 탭을 직접 누름 → 기존 동작");
  check("직접 진입 시 좌측 상단 = '지급회차 목록'", (await tab.ev(backLabel)) === "지급회차 목록", await tab.ev(backLabel));
  await tab.ev(`document.querySelector('[data-testid="pd-back"]').click(), true`);
  await tab.waitFor(has(`pu-round-${PAYDATE}`), 15000, "지급회차 목록");
  check("직접 진입 상태의 '지급회차 목록' → 지급회차 목록", await tab.ev(has(`pu-round-${PAYDATE}`)) && !(await tab.ev(has("pd-tab-payees"))));

  console.log("\n[해제] 지급대상 클릭 후 다른 탭 직접 이동 → '뒤로가기' 해제");
  await openDetail();
  await tab.ev(`document.querySelector('[data-testid="pu-payee-${TAG}하늘장비"]').click(), true`);
  await tab.waitFor(`${activeTab} === 'pd-tab-items'`, 10000, "건별 상세 탭");
  await tab.ev(`document.querySelector('[data-testid="pd-tab-readiness"]').click(), true`); await sleep(300);
  await tab.ev(`document.querySelector('[data-testid="pd-tab-items"]').click(), true`); await sleep(300);
  check("탭 직접 이동 후 건별 상세 = '지급회차 목록'", (await tab.ev(backLabel)) === "지급회차 목록", await tab.ev(backLabel));

  console.log("\n[요약 화면 목록 버튼] 요약에서 '지급회차 목록' → 지급회차 목록");
  await tab.ev(`document.querySelector('[data-testid="pd-tab-payees"]').click(), true`); await sleep(300);
  await tab.ev(`document.querySelector('[data-testid="pd-back"]').click(), true`);
  await tab.waitFor(has(`pu-round-${PAYDATE}`), 15000, "지급회차 목록");
  check("요약의 '지급회차 목록' → 지급회차 목록", await tab.ev(has(`pu-round-${PAYDATE}`)));
} catch (e) { fail++; console.log("  ❌ 중단:", e.message); try { if (tab) await shot(tab, "error"); } catch { /* */ } }
finally {
  try { tab?.ws.close(); } catch { /* 무시 */ }
  chrome.kill("SIGTERM"); await sleep(600); try { chrome.kill("SIGKILL"); } catch { /* 무시 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 무시 */ }
  try { await cleanup(); if (sids2.length) await pool.query(`DELETE FROM user_sessions WHERE session_id = ANY($1)`, [sids2]);
    const left = await q1(`SELECT (SELECT count(*) FROM users WHERE name LIKE $1)::int u, (SELECT count(*) FROM projects WHERE title LIKE $1)::int p`, [TAG + "%"]);
    console.log(`\n정리 완료 — 남은 테스트 데이터: 통번역사 ${left.u} · 판매 ${left.p}`); } catch (e) { console.log("정리 실패", e.message); fail++; }
  await pool.end();
}
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
