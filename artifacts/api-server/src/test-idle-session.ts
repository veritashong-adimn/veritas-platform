// @ts-nocheck — 미사용 자동 로그아웃·세션 보안 회귀 테스트(pnpm run test:idle-session)
//  ① 단위: 서버 정책(lib/idlePolicy) · 화면 계산(web-app lib/idleTimer) — 가상 시각(now 주입)으로 60분·30분을 기다리지 않고 검증
//  ② 통합: 테스트 API 서버(TEST_API, 기본 http://localhost:8090/api) + 개발 DB
//     세션의 마지막 활동 시각을 DB 에서 과거로 옮겨 경과시간을 재현한다. 테스트 계정(idle-test-*@test.local)은 끝에서 삭제.
//     운영 DB 에서는 실행하지 않는다(DATABASE_URL 이 PROD_DATABASE_URL 과 같으면 즉시 종료).
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { idleTimeoutMinutes, checkSession, activityTimeFromReport, MAX_REPORTED_IDLE_MS } from "./lib/idlePolicy";
import { idlePhase, shouldReportActivity, formatCountdown, fallbackIdleMinutes, sessionKeyOf, IDLE_WARNING_MS } from "../../web-app/src/lib/idleTimer";

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: any = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✅" : "❌"} ${n}${ok ? "" : " — " + JSON.stringify(d)}`); };
const MIN = 60_000;

// ── ① 단위 ──
console.log("\n[단위] 서버 정책");
check("최고관리자(admin, 역할 없음) 60분", idleTimeoutMinutes("admin", null) === 60);
check("일반 관리자(admin + 역할) 60분", idleTimeoutMinutes("admin", "finance") === 60);
check("관리자 역할 직원(staff + admin 역할) 60분", idleTimeoutMinutes("staff", "admin") === 60);
check("PM 직원 30분", idleTimeoutMinutes("staff", "pm") === 30);
check("재무 담당(관리자 권한 없음) 30분", idleTimeoutMinutes("staff", "finance") === 30);
check("열람·게스트 30분", idleTimeoutMinutes("staff", "viewer") === 30 && idleTimeoutMinutes("staff", null) === 30);
check("외부 계정(고객·통번역사) 미사용 만료 대상 아님", idleTimeoutMinutes("customer") === null && idleTimeoutMinutes("translator") === null);
const t0 = Date.UTC(2026, 10, 27, 12, 0, 0);
const s = (lastMinAgo: number, logout = false) => ({ exists: true, logoutAt: logout ? new Date(t0) : null, lastActivityAt: new Date(t0 - lastMinAgo * MIN) });
check("관리자 59분59초 미사용 → 유효", checkSession(s(59.99), 60, t0) === "active");
check("관리자 60분 미사용 → 만료", checkSession(s(60), 60, t0) === "expired");
check("직원 29분 → 유효 / 30분 → 만료", checkSession(s(29), 30, t0) === "active" && checkSession(s(30), 30, t0) === "expired");
check("로그아웃 세션 → 차단(시간 무관)", checkSession(s(0, true), 60, t0) === "logged_out");
check("세션 기록 없음 → 차단", checkSession({ exists: false, logoutAt: null, lastActivityAt: null }, 60, t0) === "missing");
check("외부 계정 장시간 미사용 → 만료 검사 없음", checkSession(s(600), null, t0) === "active");
check("보고 경과 90초 → 서버 시각 −90초", activityTimeFromReport(t0, 90_000).getTime() === t0 - 90_000);
check("보고 경과 상한 10분·음수·비정상값 → 0", activityTimeFromReport(t0, 99 * MIN).getTime() === t0 - MAX_REPORTED_IDLE_MS
  && activityTimeFromReport(t0, -5).getTime() === t0 && activityTimeFromReport(t0, "x").getTime() === t0);

console.log("\n[단위] 화면 계산(가상 시각)");
check("관리자 57분 → 사용 중", idlePhase(t0, t0 - 57 * MIN, 60 * MIN).phase === "active");
check("관리자 58분 → 안내(남은 2:00)", (() => { const p = idlePhase(t0, t0 - 58 * MIN, 60 * MIN); return p.phase === "warning" && formatCountdown(p.remainingMs) === "2:00"; })());
check("직원 28분 → 안내 / 27분59초 → 사용 중", idlePhase(t0, t0 - 28 * MIN, 30 * MIN).phase === "warning" && idlePhase(t0, t0 - 28 * MIN + 1000, 30 * MIN).phase === "active");
check("카운트다운 1:05 · 0:01", formatCountdown(65_000) === "1:05" && formatCountdown(500) === "0:01");
check("절전 후 복귀(5시간 경과) → 즉시 만료", idlePhase(t0 + 5 * 60 * MIN, t0, 30 * MIN).phase === "expired");
check("안내 시간 2분", IDLE_WARNING_MS === 2 * MIN);
check("활동 보고: 활동 없음 → 보고 안 함", !shouldReportActivity(t0, t0 - 10 * MIN, t0 - 5 * MIN));
check("활동 보고: 활동 있음·2분 미만 → 보고 안 함", !shouldReportActivity(t0, t0 - 1000, t0 - 60_000));
check("활동 보고: 활동 있음·2분 경과 → 보고", shouldReportActivity(t0, t0 - 1000, t0 - 2 * MIN));
check("기본값(서버 응답 전): admin 60 · staff 30 · 외부 null", fallbackIdleMinutes("admin") === 60 && fallbackIdleMinutes("staff") === 30 && fallbackIdleMinutes("customer") === null);
check("탭 공유 키 = 토큰 sessionId", sessionKeyOf(jwt.sign({ id: 1, sessionId: "abc-123" }, "k")) === "abc-123");

// ── ② 통합 ──
if (!process.env.DATABASE_URL || process.env.DATABASE_URL === process.env.PROD_DATABASE_URL) { console.error("\n개발 DB 전용 통합 테스트입니다(운영 DB 거부)."); process.exit(1); }
const B = process.env.TEST_API ?? "http://localhost:8090/api";
const SECRET = process.env.JWT_SECRET ?? "translation-platform-jwt-secret-dev";
const one = async (q: any) => ((await db.execute(q)).rows as any[])[0];
const call = async (tok: string, m: string, p: string, body?: any) => {
  const r = await fetch(B + p, { method: m, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, cache: r.headers.get("cache-control"), body: await r.json().catch(() => null) };
};
const tag = Date.now().toString(36);
const roleId = async (name: string) => (await one(sql`SELECT id FROM roles WHERE name = ${name}`))?.id ?? null;
const mkUser = async (kind: string, role: string, rid: number | null, pw?: string) => (await one(sql`INSERT INTO users (email, name, role, role_id, is_active, password)
  VALUES (${`idle-test-${kind}-${tag}@test.local`}, ${`idle테스트-${kind}`}, ${role}, ${rid}, true, ${pw ? await bcrypt.hash(pw, 4) : null}) RETURNING id, email, role, role_id`));
const createdSids: string[] = [];
const mkSession = async (u: any, idleMin: number) => {
  const sid = randomUUID(); createdSids.push(sid);
  await db.execute(sql`INSERT INTO user_sessions (user_id, session_id, role_type, login_at, last_activity_at, is_online, date_key)
    VALUES (${u.id}, ${sid}, ${u.role}, now() - interval '2 hours', now() - make_interval(secs => ${idleMin * 60}), true, to_char(now(), 'YYYY-MM-DD'))`);
  return { sid, token: jwt.sign({ id: u.id, email: u.email, role: u.role, roleId: u.role_id, sessionId: sid }, SECRET, { expiresIn: "1h" }) };
};
const sessRow = (sid: string) => one(sql`SELECT logout_at, last_activity_at, extract(epoch from (now() - last_activity_at)) AS idle_s FROM user_sessions WHERE session_id = ${sid}`);

const created: number[] = [];
try {
  const admin = await one(sql`SELECT id, email, role, role_id FROM users WHERE role = 'admin' AND role_id IS NULL AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1`);
  const pm = await mkUser("pm", "staff", await roleId("pm"), "IdleTest!2026pw"); created.push(pm.id);
  const fin = await mkUser("finance", "staff", await roleId("finance")); created.push(fin.id);
  const viewer = await mkUser("viewer", "staff", await roleId("viewer")); created.push(viewer.id);

  console.log("\n[통합] 로그인 → 세션 즉시 유효 · 시간 정책 응답");
  const login = (email: string, password: string, client = true) => fetch(B + "/auth/login", { method: "POST",
    headers: { "Content-Type": "application/json", ...(client ? { "X-Veritas-Client": "idle-v1" } : {}) }, body: JSON.stringify({ email, password }) })
    .then(async r => ({ status: r.status, body: await r.json() }));
  const old = await login(pm.email, "IdleTest!2026pw", false);
  check("이전 화면(버전 헤더 없음)에서 내부 계정 로그인 → 409 새로고침 안내", old.status === 409 && old.body?.code === "CLIENT_OUTDATED" && /새로고침/.test(old.body?.error ?? ""), old);
  const lg = await login(pm.email, "IdleTest!2026pw");
  const lgSid = lg.body?.token ? (jwt.decode(lg.body.token) as any)?.sessionId : null;
  check("PM 로그인 성공·토큰에 세션 ID·응답 30분", lg.status === 200 && !!lgSid && lg.body.idleTimeoutMinutes === 30, lg);
  const first = await call(lg.body.token, "GET", "/auth/permissions");
  check("로그인 직후 첫 요청 허용(세션 기록 선행)", first.status === 200 && first.body.idleTimeoutMinutes === 30, first);
  check("인증 응답 Cache-Control: no-store", first.cache === "no-store", first.cache);

  let r: any;
  console.log("\n[통합] 세션 없는 토큰 차단(예외 없음)");
  const noSess = jwt.sign({ id: admin.id, email: admin.email, role: "admin", roleId: null }, SECRET, { expiresIn: "1h" });
  for (const path of ["/auth/permissions", "/admin/projects?page=1&pageSize=1", "/admin/payout-rounds"]) {
    r = await call(noSess, "GET", path);
    check(`세션 ID 없는 관리자 토큰 → ${path} 401 SESSION_REQUIRED`, r.status === 401 && r.body?.code === "SESSION_REQUIRED", r);
  }
  r = await call(noSess, "POST", "/auth/heartbeat", { activity: true, idleMs: 0 });
  check("세션 ID 없는 토큰으로 활동 보고 불가", r.status === 401, r);
  const forged = jwt.sign({ id: admin.id, email: admin.email, role: "admin", sessionId: randomUUID() }, "translation-platform-jwt-secret-dev-wrong", { expiresIn: "1h" });
  r = await call(forged, "GET", "/auth/permissions");
  check("다른 키로 서명한 토큰 → 401", r.status === 401, r);

  console.log("\n[통합] 회원가입·고객·통번역사 로그인 유지");
  const regEmail = `idle-test-cust-${tag}@test.local`;
  const reg = await fetch(B + "/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: regEmail, password: "CustPw!2026", role: "customer", name: "idle고객" }) })
    .then(async x => ({ status: x.status, body: await x.json() }));
  if (reg.body?.user?.id) created.push(reg.body.user.id);
  const regSid = reg.body?.token ? (jwt.decode(reg.body.token) as any)?.sessionId : null;
  check("회원가입 → 세션 ID 있는 토큰 발급", reg.status === 201 && !!regSid, reg);
  r = await call(reg.body.token, "GET", "/auth/permissions");
  check("회원가입 토큰 → 본인 인증 API 정상(미사용 만료 대상 아님)", r.status === 200 && r.body.idleTimeoutMinutes === null, r);
  r = await call(reg.body.token, "GET", "/admin/projects?page=1&pageSize=1");
  check("회원가입(고객) 토큰 → 내부 업무 API 거부(403)", r.status === 403, r);
  const cl = await login(regEmail, "CustPw!2026", false);
  check("고객 로그인(이전 화면 포함) 정상", cl.status === 200 && !!(jwt.decode(cl.body.token) as any)?.sessionId, cl);
  const tr = await mkUser("translator", "translator", null, "TrPw!2026xx"); created.push(tr.id);
  const tl = await login(tr.email, "TrPw!2026xx");
  check("통번역사 로그인 정상·세션 인증", tl.status === 200 && (await call(tl.body.token, "GET", "/auth/permissions")).status === 200, tl);

  console.log("\n[통합] 이전 화면 자동 활동 보고(본문 없음) → 연장 불가");
  const lgy = await mkSession(pm, 29);
  for (let i = 0; i < 3; i++) r = await call(lgy.token, "POST", "/auth/heartbeat");
  let lrow = await sessRow(lgy.sid);
  check("본문 없는 자동 보고 3회 → 200·미반영(counted:false)·활동 시각 유지(29분)", r.status === 200 && r.body?.counted === false && Number(lrow.idle_s) >= 28.9 * 60, [r, lrow]);
  r = await call(lgy.token, "POST", "/auth/heartbeat", { idleMs: 0 });
  lrow = await sessRow(lgy.sid);
  check("activity 표시 없는 보고도 미반영", r.body?.counted === false && Number(lrow.idle_s) >= 28.9 * 60, [r, lrow]);
  await db.execute(sql`UPDATE user_sessions SET last_activity_at = last_activity_at - interval '90 seconds' WHERE session_id = ${lgy.sid}`);
  r = await call(lgy.token, "POST", "/auth/heartbeat");
  check("자동 보고가 계속돼도 30분 경과 → 401 만료", r.status === 401 && r.body?.code === "SESSION_EXPIRED", r);
  const cur = await mkSession(pm, 29);
  r = await call(cur.token, "POST", "/auth/heartbeat", { activity: true, idleMs: 1000 });
  check("최신 화면 실제 활동 보고 → 반영(counted:true)", r.status === 200 && r.body?.counted === true && Number((await sessRow(cur.sid)).idle_s) < 15, r);

  console.log("\n[통합] 관리자 60분");
  let a = await mkSession(admin, 59);
  r = await call(a.token, "GET", "/auth/permissions");
  check("관리자 59분 미사용 → 허용(60분 정책)", r.status === 200 && r.body.idleTimeoutMinutes === 60, r);
  a = await mkSession(admin, 61);
  r = await call(a.token, "GET", "/admin/projects?page=1&pageSize=1");
  check("관리자 61분 미사용 → 401 SESSION_EXPIRED", r.status === 401 && r.body?.code === "SESSION_EXPIRED", r);
  check("만료 시 세션 종료 기록", !!(await sessRow(a.sid)).logout_at);
  r = await call(a.token, "POST", "/auth/heartbeat", { activity: true, idleMs: 0 });
  check("만료 세션 로그인 연장(heartbeat) 불가", r.status === 401, r);

  console.log("\n[통합] 직원 30분(PM·재무·열람)");
  let p = await mkSession(pm, 29);
  r = await call(p.token, "GET", "/auth/permissions");
  check("PM 29분 → 허용", r.status === 200, r);
  check("PM 권한에 지급확정·은행이체(menu.payout_ops)·확정·이체 없음", r.status === 200 && !["menu.payout_ops", "payout.confirm", "payout.transfer"].some(k => r.body.permissions.includes(k)), r.body?.permissions);
  p = await mkSession(pm, 31);
  r = await call(p.token, "GET", "/auth/permissions");
  check("PM 31분 → 401 SESSION_EXPIRED", r.status === 401 && r.body?.code === "SESSION_EXPIRED", r);
  const f = await mkSession(fin, 31);
  r = await call(f.token, "GET", "/auth/permissions");
  check("재무 담당(관리자 권한 없음) 31분 → 만료(30분 정책)", r.status === 401 && r.body?.code === "SESSION_EXPIRED", r);
  const v = await mkSession(viewer, 30.5);
  r = await call(v.token, "GET", "/auth/permissions");
  check("열람 계정 30분30초 → 만료", r.status === 401, r);

  console.log("\n[통합] 활동 기준");
  const b = await mkSession(admin, 20);
  for (let i = 0; i < 3; i++) await call(b.token, "GET", "/admin/projects?page=1&pageSize=1");
  let row = await sessRow(b.sid);
  check("백그라운드 조회 3회 → 마지막 활동 시각 유지(약 20분 전)", Number(row.idle_s) >= 19.5 * 60, row);
  r = await call(b.token, "POST", "/auth/heartbeat", { activity: true, idleMs: 90_000 });
  row = await sessRow(b.sid);
  check("활동 보고(경과 90초) → 마지막 활동 = 약 90초 전", r.status === 200 && Math.abs(Number(row.idle_s) - 90) < 15, row);
  await call(b.token, "POST", "/auth/heartbeat", { activity: true, idleMs: 9 * 60_000 });
  row = await sessRow(b.sid);
  check("더 오래된 보고는 활동 시각을 앞당기지 않음", Math.abs(Number(row.idle_s) - 90) < 15, row);

  console.log("\n[통합] 로그아웃·위조 세션");
  r = await call(b.token, "POST", "/auth/logout");
  check("로그아웃 200", r.status === 200, r);
  r = await call(b.token, "GET", "/auth/permissions");
  check("로그아웃된 토큰 → 401 SESSION_ENDED", r.status === 401 && r.body?.code === "SESSION_ENDED", r);
  r = await call(b.token, "POST", "/auth/heartbeat", { activity: true, idleMs: 0 });
  check("로그아웃된 세션 연장 불가", r.status === 401, r);
  const fake = jwt.sign({ id: admin.id, email: admin.email, role: "admin", roleId: null, sessionId: randomUUID() }, SECRET, { expiresIn: "1h" });
  r = await call(fake, "GET", "/auth/permissions");
  check("세션 기록 없는 세션 ID → 401 SESSION_INVALID", r.status === 401 && r.body?.code === "SESSION_INVALID", r);
  const other = await mkSession(pm, 1);
  const cross = jwt.sign({ id: admin.id, email: admin.email, role: "admin", sessionId: other.sid }, SECRET, { expiresIn: "1h" });
  r = await call(cross, "GET", "/auth/permissions");
  check("다른 사용자의 세션 ID 사용 → 거부", r.status === 401, r);
} finally {
  if (created.length) await db.execute(sql`DELETE FROM users WHERE id IN (${sql.join(created.map(i => sql`${i}`), sql`, `)}) AND email LIKE 'idle-test-%@test.local'`);
  if (createdSids.length) await db.execute(sql`DELETE FROM user_sessions WHERE session_id IN (${sql.join(createdSids.map(i => sql`${i}`), sql`, `)})`);
}
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
