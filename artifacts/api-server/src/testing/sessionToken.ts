// 테스트 전용 인증 — 실제 로그인과 같은 방식으로 user_sessions 행을 만들고 그 세션 ID 로 토큰을 발급한다.
//   서버 인증에는 예외가 없다(세션 없는 토큰은 모두 거부): 테스트도 정상 세션을 사용한다.
//   · 기존 사용자: testSessionToken(db, userId)
//   · 역할별 사용자: testSessionToken(db, { role: "staff", roleName: "pm" }) — 테스트 계정(session-test-*@test.local)을 만들어 사용
//     (서버는 토큰의 역할이 아니라 DB 의 역할로 권한을 판정하므로, 역할별 검증은 실제 그 역할의 계정이 필요하다)
//   운영 DB 에서는 동작하지 않는다(DATABASE_URL 이 PROD_DATABASE_URL 과 같으면 오류). 서버 코드에서 가져다 쓰지 않는다.
import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { signToken, type UserRole } from "../middlewares/auth";

type Dbx = { execute: (q: any) => Promise<{ rows: any[] }> };
type Who = number | { role: UserRole; roleName?: string | null };

function assertNotProduction() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url || (process.env.PROD_DATABASE_URL && url === process.env.PROD_DATABASE_URL)) throw new Error("testSessionToken: 운영 DB 에서는 사용할 수 없습니다.");
}

export async function testSessionToken(dbx: Dbx, who: Who, opts: { lastActivityMinutesAgo?: number } = {}): Promise<string> {
  assertNotProduction();
  let user: { id: number; email: string; role: UserRole; role_id: number | null };
  if (typeof who === "number") {
    user = (await dbx.execute(sql`SELECT id, email, role, role_id FROM users WHERE id = ${who}`)).rows[0];
    if (!user) throw new Error(`testSessionToken: 사용자 ${who} 없음`);
  } else {
    const roleId = who.roleName ? (await dbx.execute(sql`SELECT id FROM roles WHERE name = ${who.roleName}`)).rows[0]?.id ?? null : null;
    if (who.roleName && roleId == null) throw new Error(`testSessionToken: 역할 ${who.roleName} 없음`);
    const email = `session-test-${who.roleName ?? who.role}-${randomUUID().slice(0, 8)}@test.local`;
    user = (await dbx.execute(sql`INSERT INTO users (email, name, role, role_id, is_active)
      VALUES (${email}, ${`테스트 ${who.roleName ?? who.role}`}, ${who.role}, ${roleId}, true) RETURNING id, email, role, role_id`)).rows[0];
  }
  const sessionId = randomUUID();
  const idleSec = Math.max(0, (opts.lastActivityMinutesAgo ?? 0) * 60);
  await dbx.execute(sql`INSERT INTO user_sessions (user_id, session_id, role_type, login_at, last_activity_at, user_agent, is_online, date_key)
    VALUES (${user.id}, ${sessionId}, ${user.role}, now(), now() - make_interval(secs => ${idleSec}), 'automated-test', true, to_char(now(), 'YYYY-MM-DD'))`);
  return signToken({ id: user.id, email: user.email, role: user.role, roleId: user.role_id, sessionId });
}

/** 테스트가 만든 세션·계정 정리(선택) — session-test-*@test.local 계정과 automated-test 세션 */
export async function cleanupTestSessions(dbx: Dbx): Promise<void> {
  assertNotProduction();
  await dbx.execute(sql`DELETE FROM user_sessions WHERE user_agent = 'automated-test'`);
  await dbx.execute(sql`DELETE FROM users WHERE email LIKE 'session-test-%@test.local'`);
}
