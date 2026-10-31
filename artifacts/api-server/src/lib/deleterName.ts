import { sql } from "drizzle-orm";

/**
 * 휴지통 목록의 삭제자 표시명 — deleted_by 가 가리키는 사용자의 현재 이름(없으면 이메일).
 * 비활성·소프트 삭제된 사용자도 행이 남아 있으므로 그대로 찾는다. 사용자를 찾지 못하면 NULL.
 *
 * 컬럼을 테이블명까지 직접 쓴다 — 단일 테이블 select 에서 ${table.deletedBy} 는 테이블명 없이 출력돼
 * 하위쿼리 안에서 users.deleted_by 로 해석되고, 삭제자를 찾지 못한다.
 */
export const deleterNameSql = (table: "inquiries" | "quotes" | "companies" | "contacts" | "users") =>
  sql<string | null>`(SELECT COALESCE(NULLIF(btrim(u.name), ''), u.email) FROM users u WHERE u.id = ${sql.raw(`${table}.deleted_by`)})`;
