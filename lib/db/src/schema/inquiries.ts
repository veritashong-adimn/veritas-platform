import { pgTable, serial, integer, text, varchar, timestamp, pgEnum, jsonb, date, time } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

/**
 * inquiries — 의뢰건 접수 (pre-sales 단계, 견적 이전)
 *
 * 견적/판매(quotes/projects)와 독립된 채널 비종속 접수 테이블.
 * 상태 중복 저장 방지: DB에는 pre-quote 수기 상태만 저장(new/reviewing/closed_no_quote).
 * 「견적작성중/견적발송/판매전환」 은 연결된 quote.status에서 파생(API/UI에서 계산) — 저장하지 않는다.
 * companyId/contactId/divisionId/quoteId/assignedPmId 는 projects.ts 와 동일하게 느슨한 정수 참조(FK 제약 없음)로 둔다.
 */

// pre-quote 수기 상태만 저장 (견적 이후 상태는 quote에서 파생)
export const inquiryStatusEnum = pgEnum("inquiry_status", ["new", "reviewing", "closed_no_quote"]);
// 접수 경로 (채널 독립형)
export const inquiryChannelEnum = pgEnum("inquiry_channel", ["homepage", "email", "phone", "kakao", "other"]);
// AI 분석 상태 (향후 자동접수 확장용)
export const inquiryAiStatusEnum = pgEnum("inquiry_ai_status", ["none", "draft", "confirmed"]);

export const inquiriesTable = pgTable("inquiries", {
  // ── 식별 ──────────────────────────────────────────────
  id: serial("id").primaryKey(),
  inquiryNumber: varchar("inquiry_number", { length: 30 }),   // R000001 (견적번호와 별개 시퀀스)

  // ── 접수 ──────────────────────────────────────────────
  // 목록·일별 집계·정렬 기준 일시(기존 의미 유지). 신규 등록은 저장 시각이 들어간다 — 고객 접수일시가 아니다.
  receivedAt: timestamp("received_at").notNull().defaultNow(),
  // 고객 접수일시(고객이 실제 의뢰를 제출한 일시) — received_at·created_at(시스템 등록일시)과 별개. 모두 NULL 허용.
  //  · date/time 분리: 원문에 시각이 없으면 time=NULL(00:00/09:00 생성 금지)
  //  · status: confirmed | needs_review | not_provided — NULL = 기존 자료(미분류, received_at 을 복사하지 않음)
  //  · source: homepage | email_received | email_sent | manual | unknown
  customerReceivedDate: date("customer_received_date", { mode: "string" }),
  customerReceivedTime: time("customer_received_time"),
  customerReceivedStatus: varchar("customer_received_status", { length: 20 }),
  customerReceivedSource: varchar("customer_received_source", { length: 20 }),
  channel: inquiryChannelEnum("channel").notNull().default("phone"),
  status: inquiryStatusEnum("status").notNull().default("new"),
  assignedPmId: integer("assigned_pm_id"),                     // 담당 PM (users.id)
  createdBy: integer("created_by"),                           // 접수 등록자 (users.id)

  // ── 고객 원문정보 (기존 거래처/담당자 미연결 상태로도 접수 가능) ──
  customerCompanyName: text("customer_company_name"),
  contactName: text("contact_name"),
  department: text("department"),
  contactPosition: text("contact_position"),                  // 직함
  contactPhone: text("contact_phone"),
  contactMobile: text("contact_mobile"),                      // 휴대폰
  contactEmail: text("contact_email"),

  // ── 확정 연결 (PM 확인 후 기존 거래처/담당자 연결, nullable) ──
  companyId: integer("company_id"),
  contactId: integer("contact_id"),
  divisionId: integer("division_id"),

  // ── 의뢰내용 (공통) ────────────────────────────────────
  serviceType: text("service_type"),                          // translation | interpretation | equipment | expense | other
  // 복수 선택(2026-10 승인) — 선택한 서비스 유형 전체 / 기타 세부 서비스. null 이면 기존 단일 service_type 1개로 간주.
  //   service_type 은 대표값(선택 목록의 첫 유형)으로 계속 저장해 기존 화면·API 와 호환한다.
  serviceTypes: jsonb("service_types").$type<string[]>(),     // 예: ["interpretation","equipment","other"]
  otherServices: jsonb("other_services").$type<string[]>(),   // 예: ["감수","공증","자막 제작"] (기타 선택 시만)
  languageFrom: text("language_from"),
  languageTo: text("language_to"),
  scheduleFrom: timestamp("schedule_from"),                   // 통역 시작일시 (통역)
  scheduleTo: timestamp("schedule_to"),                       // 통역 종료일시 (통역)
  place: text("place"),                                       // 통역 장소
  volume: text("volume"),                                     // 분량 (자유입력: 페이지/단어/자 등)
  subject: text("subject"),                                   // 주제/내용
  requirements: text("requirements"),                         // 요구사항
  quoteDueDate: timestamp("quote_due_date"),                  // 견적서 수령 희망일 (공통, 선택)
  // ── 통역 전용 (기존 VERITAS 통역 카테고리 라벨 재사용, text 저장) ──
  interpretType: text("interpret_type"),                      // 동시통역/순차통역/수행통역 등
  interpretDuration: text("interpret_duration"),              // 1일 통역시간 (자유입력)
  // ── 번역 전용 ──────────────────────────────────────────
  documentType: text("document_type"),                        // 원문서 형태 (Word/Excel/PDF/한글/이미지/기타)
  documentUsage: text("document_usage"),                      // 문서 사용처
  desiredCompletionDate: timestamp("desired_completion_date"),// 번역 완료 희망일
  // ── 통역장비/장비 단독 (복수행 JSON 배열: [{kind,quantity,unit,location,note}]) ──
  //  · 통역 의뢰 + 「통역장비 필요」 체크 시, 또는 장비 단독 의뢰 시 사용. attachmentsJson 과 동일 패턴.
  equipmentJson: text("equipment_json"),
  // ── 접수 원문/첨부 ─────────────────────────────────────
  rawSource: text("raw_source"),                              // 접수 원문 보존 (채널 원본)
  attachmentsJson: text("attachments_json"),                  // 첨부 메타 JSON 배열

  // ── 견적 연결 (1:N 확장 가능 — 현재 대표 견적 1건만 저장) ──
  quoteId: integer("quote_id"),

  // ── 종결 (견적 없이 종결 시 사유 필수) ──────────────────
  closeReasonCode: varchar("close_reason_code", { length: 40 }),
  closeReasonDetail: text("close_reason_detail"),
  closedAt: timestamp("closed_at"),
  closedBy: integer("closed_by"),

  // ── 향후 AI 확장용 (사람 확정 vs AI 생성 구분) ──────────
  aiDraftJson: text("ai_draft_json"),
  aiStatus: inquiryAiStatusEnum("ai_status").notNull().default("none"),

  // ── 감사 / soft delete (플랫폼 표준 패턴) ───────────────
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
  deletedBy: integer("deleted_by"),
  deletionReason: text("deletion_reason"),
});

export const insertInquirySchema = createInsertSchema(inquiriesTable);
