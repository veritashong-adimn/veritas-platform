// 미사용 자동 로그아웃 — 실제 브라우저(headless Chromium, CDP) 회귀 테스트
//   실행: (api-server 빌드 서버가 web-app 빌드를 함께 서비스하는 상태에서)
//     PORT=8090 node artifacts/api-server/dist/index.mjs &
//     node artifacts/web-app/e2e/idle-logout.e2e.mjs        (TEST_WEB 기본 http://localhost:8090)
//   · 30분·60분을 기다리지 않는다: 탭 공유 활동 시각(localStorage)과 세션 활동 시각(개발 DB)을 과거로 옮겨 경과를 재현한다.
//   · 개발 DB 전용(DATABASE_URL 이 PROD_DATABASE_URL 과 같으면 종료). 테스트 계정(idle-e2e-*@test.local)·세션은 끝에서 삭제.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(new URL("../../api-server/package.json", import.meta.url));
const jwt = require("jsonwebtoken"); const pg = require("pg"); const bcrypt = require("bcryptjs");
if (!process.env.DATABASE_URL || process.env.DATABASE_URL === process.env.PROD_DATABASE_URL) { console.error("개발 DB 전용 테스트입니다."); process.exit(1); }
const WEB = process.env.TEST_WEB ?? "http://localhost:8090";
const SECRET = process.env.JWT_SECRET ?? "translation-platform-jwt-secret-dev";
const CHROME = process.env.CHROME_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const q1 = async (s, a = []) => (await pool.query(s, a)).rows[0];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIN = 60_000;
let pass = 0, fail = 0;
const check = (n, ok, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✅" : "❌"} ${n}${ok ? "" : " — " + JSON.stringify(d)}`); };

// ── 최소 CDP 드라이버(탭 여러 개) ──
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "idle-e2e-"));
const PORT = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, "--window-size=1440,1000", "--renderer-process-limit=3", "--disable-extensions", "about:blank"], { stdio: "ignore" });
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl); await new Promise(r => ws.addEventListener("open", r));
  let seq = 0; const pend = new Map();
  ws.addEventListener("message", e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r, j) => { const id = ++seq; pend.set(id, m => m.error ? j(new Error(method + ": " + m.error.message)) : r(m.result)); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async expr => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
  const waitFor = async (expr, ms = 15000, label = expr) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(expr)) return true; } catch { /* 이동 중 */ } await sleep(150); } throw new Error("대기 초과: " + label); };
  await send("Page.enable"); await send("Runtime.enable");
  return { ws, send, ev, waitFor, goto: async url => { await send("Page.navigate", { url }); await sleep(400); }, close: () => ws.close() };
}
async function newTab() {
  let list; for (let i = 0; i < 40 && !list; i++) { await sleep(250); try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { /* 기동 중 */ } }
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  return connect(t.webSocketDebuggerUrl);
}
const $ = s => `document.querySelector(${JSON.stringify(s)})`;

// ── 테스트 계정·세션(개발 DB) ──
const tag = Date.now().toString(36);
const createdUsers = []; const createdSids = []; let createdRole = null;
async function mkSession(u, idleMin = 0) {
  const sid = randomUUID(); createdSids.push(sid);
  await pool.query(`INSERT INTO user_sessions (user_id, session_id, role_type, login_at, last_activity_at, is_online, date_key)
    VALUES ($1,$2,$3, now(), now() - make_interval(secs => $4), true, to_char(now(),'YYYY-MM-DD'))`, [u.id, sid, u.role, idleMin * 60]);
  return { sid, token: jwt.sign({ id: u.id, email: u.email, role: u.role, roleId: u.role_id, sessionId: sid }, SECRET, { expiresIn: "2h" }) };
}
const sess = sid => q1(`SELECT logout_at, extract(epoch from (now() - last_activity_at)) AS idle_s FROM user_sessions WHERE session_id = $1`, [sid]);
async function signIn(tab, u, s, idleMinutes) {
  await tab.goto(WEB + "/");
  await tab.ev(`localStorage.setItem('auth_token', ${JSON.stringify(s.token)}); localStorage.setItem('auth_user', ${JSON.stringify(JSON.stringify({ id: u.id, email: u.email, role: u.role, roleId: u.role_id, name: u.name }))}); localStorage.setItem('auth_idle_minutes', '${idleMinutes}'); true`);
}
const setLast = (tab, sid, msAgo) => tab.ev(`localStorage.setItem('veritas_idle_last:${sid}', String(Date.now() - ${msAgo})); true`);
const getLastAgo = (tab, sid) => tab.ev(`Date.now() - Number(localStorage.getItem('veritas_idle_last:${sid}'))`);
const dialogShown = tab => tab.ev(`!!${$('[data-testid="idle-logout-dialog"]')}`);
const onLogin = tab => tab.ev(`!localStorage.getItem('auth_token') && !!document.querySelector('input[type=password]')`);

let A, Bt;
try {
  const admin = await q1(`SELECT id, email, role, role_id, name FROM users WHERE role='admin' AND role_id IS NULL AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1`);
  // 운영 'pm' 역할과 같은 지급 권한(지급회차 조회·지급명세서, 지급확정·은행이체 없음)의 테스트 역할 — 개발 DB 의 pm 역할은 지급 권한이 없어 별도 구성
  const pmRole = await q1(`INSERT INTO roles (name, description) VALUES ($1, 'idle e2e — 운영 pm 지급 권한 재현') RETURNING id`, [`idle-e2e-pm-${tag}`]);
  createdRole = pmRole.id;
  await pool.query(`INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = ANY($2)`,
    [pmRole.id, ["menu.payout", "menu.payout_statement", "payout.view", "menu.project"]]);
  const pm = await q1(`INSERT INTO users (email, name, role, role_id, is_active, password) VALUES ($1,'idleE2E PM','staff',$2,true,$3) RETURNING id, email, role, role_id, name`,
    [`idle-e2e-pm-${tag}@test.local`, pmRole.id, await bcrypt.hash("IdleE2E!2026pw", 4)]);
  createdUsers.push(pm.id);

  A = await newTab();
  const s1 = await mkSession(admin, 0);
  await signIn(A, admin, s1, 60);
  await A.goto(WEB + "/"); await A.waitFor(`!!document.querySelector('aside, nav') && !!localStorage.getItem('auth_token')`, 20000, "관리자 화면");
  await sleep(1500);

  console.log("\n[1] 관리자 58분 경과 → 안내·카운트다운");
  await setLast(A, s1.sid, 58 * MIN + 5000); await A.waitFor(`!!${$('[data-testid="idle-logout-dialog"]')}`, 4000, "안내창");
  const msg = await A.ev(`${$('[data-testid="idle-logout-message"]')}.innerText.trim()`);
  check("안내 문구", msg === "장시간 사용하지 않아 회사정보 및 개인정보 보호를 위해 자동 로그아웃됩니다.", msg);
  const c1 = await A.ev(`${$('[data-testid="idle-logout-countdown"]')}.innerText`); await sleep(2100);
  const c2 = await A.ev(`${$('[data-testid="idle-logout-countdown"]')}.innerText`);
  const secs = t => { const [m, s] = t.split(":").map(Number); return m * 60 + s; };
  check(`카운트다운 표시·감소(${c1} → ${c2})`, secs(c1) <= 115 && secs(c1) >= 110 && secs(c1) - secs(c2) >= 2, [c1, c2]);
  check("버튼 [로그아웃] [로그인 연장]", await A.ev(`${$('[data-testid="idle-logout-now"]')}.innerText === '로그아웃' && ${$('[data-testid="idle-logout-extend"]')}.innerText === '로그인 연장'`));
  await A.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 300, y: 300 }); await sleep(1200);
  check("안내 중 마우스 이동만으로는 연장되지 않음", await dialogShown(A));

  console.log("\n[2] 로그인 연장");
  await pool.query(`UPDATE user_sessions SET last_activity_at = now() - interval '58 minutes' WHERE session_id = $1`, [s1.sid]);
  await A.ev(`${$('[data-testid="idle-logout-extend"]')}.click(), true`); await sleep(1500);
  check("연장 → 안내창 닫힘·활동 시각 초기화", !(await dialogShown(A)) && (await getLastAgo(A, s1.sid)) < 5000);
  check("연장 → 서버 세션 활동 시각 갱신(60분 재설정)", Number((await sess(s1.sid)).idle_s) < 10, await sess(s1.sid));

  console.log("\n[3] 실제 활동 / 백그라운드 조회");
  await setLast(A, s1.sid, 10 * MIN); await sleep(300);
  await A.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 500, y: 420 }); await sleep(600);
  check("마우스 이동 → 미사용 시간 초기화", (await getLastAgo(A, s1.sid)) < 3000);
  await setLast(A, s1.sid, 10 * MIN + 1500); await sleep(1100);
  await A.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft" }); await A.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft" }); await sleep(500);
  check("키보드 입력 → 미사용 시간 초기화", (await getLastAgo(A, s1.sid)) < 3000);
  await setLast(A, s1.sid, 10 * MIN); await sleep(1100);
  const before = Number((await sess(s1.sid)).idle_s);
  await A.ev(`Promise.all([1,2,3].map(() => fetch('/api/admin/projects?page=1&pageSize=1', { headers: { Authorization: 'Bearer ' + localStorage.getItem('auth_token') } }).then(r => r.status)))`);
  await sleep(2500);
  const lastAgo = await getLastAgo(A, s1.sid);
  check(`백그라운드 API 3회 → 화면 미사용 시간 유지(${Math.round(lastAgo / 1000)}초)`, lastAgo >= 10 * MIN, lastAgo);
  check("백그라운드 API → 서버 활동 시각 유지", Number((await sess(s1.sid)).idle_s) >= before, [before, await sess(s1.sid)]);

  console.log("\n[4] 여러 탭 동기화");
  Bt = await newTab(); await Bt.goto(WEB + "/"); await Bt.waitFor(`!!localStorage.getItem('auth_token') && !!document.querySelector('aside, nav')`, 20000, "탭 B");
  await sleep(1200);
  await setLast(Bt, s1.sid, 58 * MIN + 3000);
  await A.waitFor(`!!${$('[data-testid="idle-logout-dialog"]')}`, 4000, "탭 A 안내"); await Bt.waitFor(`!!${$('[data-testid="idle-logout-dialog"]')}`, 4000, "탭 B 안내");
  check("한 세션의 두 탭 모두 안내 표시", true);
  await Bt.ev(`${$('[data-testid="idle-logout-extend"]')}.click(), true`); await sleep(1800);
  check("탭 B 연장 → 탭 A 안내도 닫힘", !(await dialogShown(A)) && !(await dialogShown(Bt)));
  await setLast(A, s1.sid, 5 * MIN); await sleep(300);
  await Bt.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 200, y: 200 }); await sleep(800);
  check("탭 B 활동 → 탭 A 미사용 시간도 초기화", (await getLastAgo(A, s1.sid)) < 3000);

  console.log("\n[5] 미저장 입력 경고 → [로그아웃] 즉시 로그아웃");
  const sale = await q1(`SELECT p.id, (SELECT i.memo FROM quote_items i JOIN quotes q ON q.id = i.quote_id WHERE q.project_id = p.id AND q.is_current ORDER BY i.id LIMIT 1) AS memo
    FROM projects p WHERE EXISTS (SELECT 1 FROM quotes q JOIN quote_items i ON i.quote_id = q.id WHERE q.project_id = p.id AND q.is_current) ORDER BY p.id DESC LIMIT 1`);
  await A.goto(`${WEB}/sales/${sale.id}`); await A.waitFor(`!!${$('[data-testid="btn-sales-items-edit"]')}`, 20000, "판매 상세");
  await A.ev(`${$('[data-testid="btn-sales-items-edit"]')}.click(), true`); await A.waitFor(`!!${$('[data-testid="qe-memo-0"]')}`, 8000, "편집");
  await A.ev(`${$('[data-testid="qe-memo-0"]')}.focus(), true`); await A.send("Input.insertText", { text: " [미저장 테스트]" }); await sleep(300);
  await setLast(A, s1.sid, 58 * MIN + 2000); await A.waitFor(`!!${$('[data-testid="idle-logout-dialog"]')}`, 4000, "안내창");
  await sleep(1200);
  check("미저장 입력 경고 표시", await A.ev(`!!${$('[data-testid="idle-logout-unsaved"]')}`));
  await A.ev(`${$('[data-testid="idle-logout-now"]')}.click(), true`);
  await A.waitFor(`!localStorage.getItem('auth_token') && !!document.querySelector('input[type=password]')`, 8000, "로그인 화면");
  check("[로그아웃] → 로그인 화면·토큰 제거", true);
  await sleep(1500);   // 다른 탭이 로그아웃을 반영할 시간
  const leftover = await A.ev(`Object.keys(localStorage).filter(k => ['auth_token','auth_user','auth_permissions','auth_idle_minutes'].includes(k) || k.startsWith('veritas_idle_'))`);
  check("로그아웃 시 토큰·사용자 정보·권한·활동 기록 제거", leftover.length === 0, leftover);
  await Bt.waitFor(`!!document.querySelector('input[type=password]')`, 8000, "탭 B 로그아웃 반영");
  check("다른 탭에도 로그아웃 반영", await onLogin(Bt));
  const memoAfter = (await q1(`SELECT i.memo FROM quote_items i JOIN quotes q ON q.id = i.quote_id WHERE q.project_id = $1 AND q.is_current ORDER BY i.id LIMIT 1`, [sale.id])).memo;
  check("미저장 자료를 저장하지 않음", memoAfter === sale.memo, [sale.memo, memoAfter]);
  await sleep(800);
  check("서버 세션 종료 기록", !!(await sess(s1.sid)).logout_at);
  const old = await fetch(WEB + "/api/auth/permissions", { headers: { Authorization: `Bearer ${s1.token}` } });
  check("로그아웃된 토큰으로 API 접근 차단(401)", old.status === 401, old.status);
  await A.ev(`history.back(), true`); await sleep(2000);
  check("뒤로가기 → 이전 업무화면 미표시(로그인 화면)", await A.ev(`!document.querySelector('[data-testid="sales-detail-title"]') && !!document.querySelector('input[type=password]')`));
  await A.goto(`${WEB}/sales/${sale.id}`); await sleep(2000);
  check("직접 URL 접근 → 로그인 화면", await A.ev(`!document.querySelector('[data-testid="sales-detail-title"]') && !!document.querySelector('input[type=password]')`));

  console.log("\n[6] 절전(화면 동결) 후 복귀 → 만료");
  const s2 = await mkSession(admin, 0);
  await signIn(A, admin, s2, 60); await A.goto(WEB + "/"); await A.waitFor(`!!localStorage.getItem('auth_token') && !!document.querySelector('aside, nav')`, 20000, "재로그인");
  await Bt.goto(WEB + "/"); await sleep(1500);
  await A.send("Page.setWebLifecycleState", { state: "frozen" });
  await setLast(Bt, s2.sid, 61 * MIN);    // 동결(절전) 동안 61분 경과
  await sleep(1500);
  await A.send("Page.setWebLifecycleState", { state: "active" });
  await A.waitFor(`!localStorage.getItem('auth_token') && !!document.querySelector('input[type=password]')`, 8000, "복귀 후 로그아웃");
  check("복귀 즉시 만료 로그아웃(경고 없이)", true);
  check("자동 로그아웃 안내 표시(다른 탭이 먼저 만료 처리한 경우 포함)", await A.ev(`(document.querySelector('[data-testid="auto-logout-notice"]')?.innerText ?? '').includes('자동 로그아웃')`));
  await sleep(800);
  const exp = await fetch(WEB + "/api/admin/projects?page=1&pageSize=1", { headers: { Authorization: `Bearer ${s2.token}` } });
  check("만료된 토큰으로 API 접근 차단(401)", exp.status === 401, exp.status);

  console.log("\n[7] 서버 측 만료(화면 시각과 무관) → 즉시 로그아웃");
  const s3 = await mkSession(admin, 0);
  await signIn(A, admin, s3, 60); await A.goto(WEB + "/"); await A.waitFor(`!!localStorage.getItem('auth_token') && !!document.querySelector('aside, nav')`, 20000, "재로그인");
  await pool.query(`UPDATE user_sessions SET last_activity_at = now() - interval '61 minutes' WHERE session_id = $1`, [s3.sid]);
  await A.ev(`fetch('/api/admin/projects?page=1&pageSize=1', { headers: { Authorization: 'Bearer ' + localStorage.getItem('auth_token') } }).then(r => r.status)`);
  await A.waitFor(`!localStorage.getItem('auth_token') && !!document.querySelector('input[type=password]')`, 8000, "서버 만료 반영");
  check("서버 만료 응답 → 화면 즉시 로그아웃", true);

  console.log("\n[7-2] 안내 후 무응답 → 카운트다운 종료 시 자동 로그아웃");
  const s5 = await mkSession(admin, 0);
  await signIn(A, admin, s5, 60); await A.goto(WEB + "/"); await A.waitFor(`!!localStorage.getItem('auth_token') && !!document.querySelector('aside, nav')`, 20000, "재로그인");
  await sleep(1200);
  await setLast(A, s5.sid, 60 * MIN - 4000);
  await A.waitFor(`!!${$('[data-testid="idle-logout-dialog"]')}`, 3000, "만료 직전 안내");
  check("만료 4초 전 안내 표시", true);
  await A.waitFor(`!localStorage.getItem('auth_token') && !!document.querySelector('input[type=password]')`, 9000, "카운트다운 종료 후 로그아웃");
  check("응답 없음 → 0:00 에 자동 로그아웃", true);
  await sleep(800);
  check("자동 로그아웃 → 서버 세션 종료 기록", !!(await sess(s5.sid)).logout_at);

  console.log("\n[8] 계정 변경(PM 로그인) · PM 30분 · 지급확정 탭 차단");
  await A.goto(WEB + "/"); await A.waitFor(`!!document.querySelector('input[type=password]')`, 8000, "로그인 화면");
  await A.ev(`(() => { const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(document.querySelector('input[type=email]'), ${JSON.stringify(pm.email)}); set(document.querySelector('input[type=password]'), 'IdleE2E!2026pw');
    document.querySelector('form').requestSubmit(); return true })()`);
  await A.waitFor(`!!localStorage.getItem('auth_token') && !!document.querySelector('aside, nav')`, 20000, "PM 로그인");
  const pmSid = await A.ev(`JSON.parse(atob(localStorage.getItem('auth_token').split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).sessionId`); createdSids.push(pmSid);
  check("PM 로그인 → 미사용 시간 30분", await A.ev(`localStorage.getItem('auth_idle_minutes') === '30'`));
  check("이전 계정 활동 기록 없음(새 세션만)", await A.ev(`Object.keys(localStorage).filter(k => k.startsWith('veritas_idle_')).every(k => k.endsWith(${JSON.stringify(pmSid)}))`));
  await Bt.waitFor(`localStorage.getItem('auth_user')?.includes('idleE2E PM') && !!document.querySelector('aside, nav')`, 10000, "탭 B 계정 반영");
  check("다른 탭도 새 계정으로 다시 불러옴", true);
  await setLast(A, pmSid, 28 * MIN + 3000); await A.waitFor(`!!${$('[data-testid="idle-logout-dialog"]')}`, 4000, "PM 안내");
  const pc = await A.ev(`${$('[data-testid="idle-logout-countdown"]')}.innerText`);
  check(`PM 28분 경과 → 안내(${pc})`, secs(pc) <= 117 && secs(pc) >= 112, pc);
  await A.ev(`${$('[data-testid="idle-logout-extend"]')}.click(), true`); await sleep(1500);
  check("PM 연장 → 30분 재설정", !(await dialogShown(A)) && (await getLastAgo(A, pmSid)) < 5000);
  await A.ev(`sessionStorage.setItem('veritasRestoreTab','settlements'); location.reload(); true`); await sleep(3500);
  const pmTabs = await A.ev(`(async () => { const row = document.querySelector('[data-testid^="pu-round-"]'); if (!row) return 'NO_ROUNDS:' + (document.querySelector('[data-testid="payout-unified-tab"]') ? 'list' : 'nolist'); row.click();
    for (let i = 0; i < 40 && !document.querySelector('[role=tablist]'); i++) await new Promise(r => setTimeout(r, 150));
    return [...document.querySelectorAll('[role=tablist] [role=tab]')].map(e => e.innerText) })()`);
  check(`PM 지급회차 상세 — 3개 탭만, 지급확정·은행이체 없음 (${JSON.stringify(pmTabs)})`, Array.isArray(pmTabs) && pmTabs.length === 3 && !pmTabs.includes("지급확정·은행이체"), pmTabs);

  console.log("\n[9] 관리자 지급확정·은행이체 탭 표시");
  await A.ev(`${$('[data-testid="idle-logout-now"]')} ? true : true`);
  const s4 = await mkSession(admin, 0);
  await signIn(A, admin, s4, 60); await A.ev(`sessionStorage.setItem('veritasRestoreTab','settlements'); true`); await A.goto(WEB + "/");
  await A.waitFor(`!!document.querySelector('[data-testid^="pu-round-"]')`, 20000, "관리자 지급회차 목록");
  const adTabs = await A.ev(`(async () => { document.querySelector('[data-testid^="pu-round-"]').click();
    for (let i = 0; i < 40 && !document.querySelector('[role=tablist]'); i++) await new Promise(r => setTimeout(r, 150));
    return [...document.querySelectorAll('[role=tablist] [role=tab]')].map(e => e.innerText) })()`);
  check(`관리자 4개 탭 (${JSON.stringify(adTabs)})`, adTabs.length === 4 && adTabs[3] === "지급확정·은행이체", adTabs);
} catch (e) { fail++; console.log("  ❌ 중단:", e.message); }
finally {
  try { A?.close(); Bt?.close(); } catch { /* 무시 */ }
  chrome.kill("SIGTERM"); await sleep(600); try { chrome.kill("SIGKILL"); } catch { /* 무시 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 무시 */ }
  if (createdSids.length) await pool.query(`DELETE FROM user_sessions WHERE session_id = ANY($1)`, [createdSids]);
  if (createdUsers.length) await pool.query(`DELETE FROM users WHERE id = ANY($1) AND email LIKE 'idle-e2e-%@test.local'`, [createdUsers]);
  if (createdRole) { await pool.query(`DELETE FROM role_permissions WHERE role_id = $1`, [createdRole]); await pool.query(`DELETE FROM roles WHERE id = $1 AND name LIKE 'idle-e2e-%'`, [createdRole]); }
  await pool.end();
}
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
