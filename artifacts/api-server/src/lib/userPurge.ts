import { sql } from "drizzle-orm";
import { usersTable } from "@workspace/db";

/**
 * 사용자 영구 비식별 처리(통합휴지통 "완전삭제") 공용 규칙.
 *  · 사용자 행은 물리 삭제하지 않는다(FK·업무이력 보존). 이메일을 아래 예약 도메인의 대체값으로 바꿔 표식으로 쓴다.
 *  · 예약 도메인 `.invalid` 는 RFC 2606 상 실제 메일 수신이 불가능한 TLD — 일반 계정이 이 도메인을 쓰지 못하게 막는다.
 */
export const PURGED_EMAIL_DOMAIN = "deleted.invalid";
export const purgedEmailFor = (userId: number) => `purged-user-${userId}@${PURGED_EMAIL_DOMAIN}`;
export const isReservedEmail = (email: string) => email.trim().toLowerCase().endsWith(`@${PURGED_EMAIL_DOMAIN}`);
export const isPurgedEmail = (email: string | null | undefined) => !!email && isReservedEmail(email);

/** SQL 조건: 영구 비식별 처리되지 않은 사용자 */
export const notPurgedSql = sql`${usersTable.email} NOT LIKE ${"%@" + PURGED_EMAIL_DOMAIN}`;

/** 이번 정책 적용 범위 — 통번역사 계정은 별도 정책(제외) */
export const PURGEABLE_ROLES = ["admin", "staff", "client", "customer"] as const;
