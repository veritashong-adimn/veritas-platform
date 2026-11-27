// Excel·CSV 출력 버튼 — 관리자만 표시(브라우저 회귀 테스트, headless Chromium · CDP)
//   실행: PORT=8090 node artifacts/api-server/dist/index.mjs &  →  node artifacts/web-app/e2e/export-access.e2e.mjs
//   관리자: 각 화면에 출력 버튼 표시 / 모든 권한을 가진 직원 역할: 같은 화면은 정상 표시되지만 출력 버튼 없음 + 직접 API 403
//   개발 DB 전용. 테스트 역할·계정·세션(export-e2e-*)은 끝에서 삭제.
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

let roleId = null; const users = []; const sids = [];
async function session(u) {
  const sid = randomUUID(); sids.push(sid);
  await pool.query(`INSERT INTO user_sessions (user_id, session_id, role_type, login_at, last_activity_at, user_agent, is_online, date_key)
    VALUES ($1,$2,$3,now(),now(),'automated-test',true,to_char(now(),'YYYY-MM-DD'))`, [u.id, sid, u.role]);
  return jwt.sign({ id: u.id, email: u.email, role: u.role, roleId: u.role_id, sessionId: sid }, SECRET, { expiresIn: "1h" });
}
// 화면별: 이동 탭 · 화면 표시 기준 요소 · 출력 버튼 · (선택) 사전 동작
const PAGES = [
  { name: "견적 목록", tab: "quotes", anchor: "quote-list-title", buttons: ["quote-excel-export-btn"] },
  { name: "거래처", tab: "companies", anchor: "company-create-btn", buttons: ["company-excel-export-btn"], download: true },
  { name: "담당자", tab: "contacts", anchor: "contact-create-btn", buttons: ["contact-excel-export-btn"] },
  { name: "판매 [현재]", tab: "projects", anchor: "sales-range-current", before: `document.querySelector('[data-testid="sales-range-current"]').click()`, buttons: ["sales-excel-export-btn", "sales-csv-export-btn"] },
  { name: "지급회차 상세 — 지급대상별 요약", tab: "settlements", anchor: "pd-tab-payees", open: true, before: `document.querySelector('[data-testid="pd-tab-payees"]').click()`, buttons: ["pu-payee-excel-all"], download: true },
  { name: "지급회차 상세 — 건별 상세내역", tab: "settlements", anchor: "pd-tab-items", open: true, before: `document.querySelector('[data-testid="pd-tab-items"]').click()`, buttons: ["pd-item-excel-all"] },
];
async function visit(tab, token, user, page, isAdmin) {
  await tab.goto(WEB + "/");
  await tab.ev(`localStorage.setItem('auth_token', ${JSON.stringify(token)}); localStorage.setItem('auth_user', ${JSON.stringify(JSON.stringify(user))}); sessionStorage.setItem('veritasRestoreTab', '${page.tab}'); true`);
  await tab.goto(WEB + "/");
  if (page.open) {
    await tab.waitFor(`!!document.querySelector('[data-testid^="pu-round-"]')`, 25000, page.name + " 목록");
    await tab.ev(`document.querySelector('[data-testid^="pu-round-"]').click(), true`);
  }
  await tab.waitFor(has(page.anchor), 25000, page.name);
  if (page.before) { await tab.ev(page.before + ", true"); }
  await sleep(2500);   // 권한 재조회(canExport)·목록 조회 반영
  const shown = await tab.ev(`${JSON.stringify(page.buttons)}.map(id => !!document.querySelector('[data-testid="' + id + '"]'))`);
  return shown;
}

let tab;
try {
  const admin = await q1(`SELECT id, email, role, role_id, name FROM users WHERE role='admin' AND role_id IS NULL AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1`);
  const tag = Date.now().toString(36);
  roleId = (await q1(`INSERT INTO roles (name, description) VALUES ($1, 'export e2e — 모든 권한 직원') RETURNING id`, [`export-e2e-all-${tag}`])).id;
  await pool.query(`INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions`, [roleId]);
  const staff = await q1(`INSERT INTO users (email, name, role, role_id, is_active) VALUES ($1,'export테스트 직원','staff',$2,true) RETURNING id, email, role, role_id, name`, [`export-e2e-staff-${tag}@test.local`, roleId]);
  users.push(staff.id);
  const TA = await session(admin), TS = await session(staff);
  tab = await newTab();
  for (const page of PAGES) {
    console.log(`\n[${page.name}]`);
    const a = await visit(tab, TA, { id: admin.id, email: admin.email, role: "admin", roleId: null, name: admin.name }, page, true);
    check(`관리자: 출력 버튼 표시 (${page.buttons.join(", ")})`, a.every(Boolean), a);
    if (page.download) {   // 관리자 실제 다운로드(브라우저 생성 Excel)
      const n0 = tab.downloads.length;
      await tab.ev(`document.querySelector('[data-testid="${page.buttons[0]}"]').click(), true`);
      await tab.waitFor(`true`, 1000).catch(() => {}); for (let i = 0; i < 40 && tab.downloads.length === n0; i++) await sleep(250);
      const f = tab.downloads.slice(n0)[0];
      check(`관리자: Excel 다운로드 실행 (${f ?? "없음"})`, !!f && /\.xlsx$/.test(f), tab.downloads);
    }
    const s = await visit(tab, TS, { id: staff.id, email: staff.email, role: "staff", roleId, name: staff.name }, page, false);
    check(`모든 권한 직원: 화면 정상 표시 · 출력 버튼 없음`, s.every(v => !v), s);
  }
  console.log("\n[직원 화면에서 직접 호출]");
  const st = await tab.ev(`Promise.all(['/api/admin/projects/export','/api/admin/quotes/bulk-import/export','/api/admin/products/export'].map(p => fetch(p, { headers: { Authorization: 'Bearer ' + localStorage.getItem('auth_token') } }).then(r => r.status)))`);
  check(`출력 API 직접 호출 403 (${st.join("/")})`, st.every(x => x === 403), st);
  const txt = await tab.ev(`[...document.querySelectorAll('button')].filter(b => b.offsetParent && /Excel 다운로드|CSV 내보내기|엑셀 다운로드/.test(b.innerText)).length`);
  check("직원 화면에 Excel·CSV 다운로드 버튼 문구 없음", txt === 0, txt);
} catch (e) { fail++; console.log("  ❌ 중단:", e.message); }
finally {
  try { tab?.ws.close(); } catch { /* 무시 */ }
  chrome.kill("SIGTERM"); await sleep(600); try { chrome.kill("SIGKILL"); } catch { /* 무시 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 무시 */ }
  if (sids.length) await pool.query(`DELETE FROM user_sessions WHERE session_id = ANY($1)`, [sids]);
  if (users.length) await pool.query(`DELETE FROM users WHERE id = ANY($1) AND email LIKE 'export-e2e-%@test.local'`, [users]);
  if (roleId) { await pool.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]); await pool.query(`DELETE FROM roles WHERE id = $1`, [roleId]); }
  await pool.end();
}
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
