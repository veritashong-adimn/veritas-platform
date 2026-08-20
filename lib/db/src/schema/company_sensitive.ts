import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

// ─────────────────────────────────────────────────────────────────────────────
// 거래처 지급/환급 계좌정보(company_sensitive) — 국내 지급 자동화.
//  · [도메인] "외주업체 전용"이 아니라 모든 거래처(고객사/외주업체/행사·운영/기타)가 사용하는
//    정식 "지급/환급 계좌정보" 원천이다. 용역대금 지급·오송금 반환·과입금 반환·환불 등에 재사용한다.
//  · [1:1] company 당 1개의 지급/환급 계좌(companyId UNIQUE). 지급 실행의 계좌 재검증이 이 원천을 조회한다.
//  · [보안] 계좌번호는 평문 저장 금지 — AES-256-GCM 암호문(bank_account_enc)만 저장한다.
//    복호화는 IBK 대량이체 파일 생성 시 서버 내부에서만 수행하고, 화면·API·로그에는 마스킹만 노출한다.
//    (translator_sensitive.bankAccountEnc 와 동일한 암호화 유틸/정책 재사용)
//  · [additive] 기존 companies 컬럼을 건드리지 않는 별도 민감정보 테이블 — 일반 company 조회 API에
//    암호문이 섞여 노출되지 않도록 분리한다.
// ─────────────────────────────────────────────────────────────────────────────
export const companySensitiveTable = pgTable("company_sensitive", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .unique()
    .references(() => companiesTable.id, { onDelete: "cascade" }),

  // ── 지급/환급 계좌정보 ──
  bankName: text("bank_name"),
  bankAccountEnc: text("bank_account_enc"), // AES-256-GCM 암호화(평문 저장 금지)
  accountHolder: text("account_holder"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CompanySensitive = typeof companySensitiveTable.$inferSelect;
export type InsertCompanySensitive = typeof companySensitiveTable.$inferInsert;
