/**
 * 회사 자료보관함 — 공통 상수·가드·파일 규칙·업무연결 라벨 해석.
 */
import type { Request, Response, NextFunction } from "express";
import path from "node:path";
import {
  db, companiesTable, contactsTable, quotesTable, inquiriesTable, projectsTable, usersTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { loadArchiveActor, type ArchiveActor } from "./archiveAccess";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { archiveActor?: ArchiveActor }
  }
}

/** requireAuth 뒤에 사용. 모듈 권한(menu.archive) 없는 사용자는 403. */
export async function requireArchiveModule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = await loadArchiveActor(req);
    if (!actor.hasModule) { res.status(403).json({ error: "회사 자료보관함 접근 권한이 없습니다." }); return; }
    req.archiveActor = actor;
    next();
  } catch (err) {
    req.log.error({ err }, "[archive] actor load failed");
    res.status(500).json({ error: "권한 확인 중 오류가 발생했습니다." });
  }
}

// ─── 하위 메뉴 키 ───────────────────────────────────────────────────────────
export const ARCHIVE_MENU_KEYS = ["forms", "manuals", "contracts", "records", "hr", "management"] as const;

// ─── 기본 분류 체계 (관리자가 「기본 분류 생성」 시 1회 생성) ──────────────────
export const DEFAULT_TAXONOMY: Array<{ name: string; menuKey: string | null; children: string[] }> = [
  { name: "회사 경영·관리", menuKey: "management", children: ["회사소개 및 사업자서류", "내부규정 및 상도의각서", "경영전략 및 사업계획", "재무·회계·세무", "경영통계 및 보고서"] },
  { name: "영업·고객관리", menuKey: "manuals", children: ["영업매뉴얼", "고객응대 및 상담", "영업정책", "제안서 및 고객사 자료"] },
  { name: "통번역 운영", menuKey: "manuals", children: ["통역 업무프로세스", "번역 업무프로세스", "통번역사 관리", "납품 및 품질관리", "통역장비 및 행사운영"] },
  { name: "계약·법무", menuKey: "contracts", children: ["고객사 계약서", "통번역사·외주 계약서", "업무협약서(MOU)", "비밀유지계약서(NDA)", "각서 및 법률자료", "분쟁 관련 자료"] },
  { name: "인사·노무·복지", menuKey: "hr", children: ["채용 및 인사관리", "근로계약 및 인사규정", "근태·휴가·퇴사", "직원교육 및 평가", "복리후생"] },
  { name: "서류양식", menuKey: "forms", children: ["인사·노무 서식", "계약·협약 서식", "영업·거래 서식", "통번역 업무 서식", "회계·세무 서식", "공문·증명서·신청서", "기타 표준서식"] },
  { name: "업무기록·커뮤니케이션", menuKey: "records", children: ["이메일", "공문", "회의록", "업무일지", "업무지시 및 인수인계", "의사결정 기록"] },
  { name: "기획·연구·사업개발", menuKey: "management", children: ["신규사업", "AI 및 플랫폼 개발", "정부지원사업", "제휴 및 협력", "시장조사 및 경쟁사 분석"] },
  { name: "홍보·브랜드", menuKey: null, children: ["회사소개서", "홍보자료", "로고 및 디자인", "콘텐츠"] },
];

export const DOC_TYPES = ["general", "form_template", "form_issued", "contract", "manual", "policy", "email", "record", "report", "other"] as const;
export const SECURITY_LEVELS = ["internal", "restricted", "confidential", "secret"] as const;
export const DOC_STATUSES = ["draft", "in_review", "approved", "revised", "discarded"] as const;

// ─── 파일 규칙 (기존 /api/upload 10MB 정책 유지) ──────────────────────────────
export const ARCHIVE_MAX_FILE_SIZE = 10 * 1024 * 1024;

const EXT_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".hwp": "application/x-hwp",
  ".hwpx": "application/haansofthwpx",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".eml": "message/rfc822",
  ".msg": "application/vnd.ms-outlook",
};
export const ARCHIVE_ALLOWED_EXTS = Object.keys(EXT_MIME);

export function archiveFileInfo(fileName: string): { ext: string; mime: string } | null {
  const ext = path.extname(fileName).toLowerCase();
  const mime = EXT_MIME[ext];
  return mime ? { ext, mime } : null;
}

/** 브라우저가 원본 그대로 미리보기 가능한 형식 */
export function isInlinePreviewable(mime: string | null | undefined): boolean {
  if (!mime) return false;
  return mime === "application/pdf" || mime.startsWith("image/") || mime.startsWith("text/");
}

// ─── 업무 연결 ──────────────────────────────────────────────────────────────
export const LINK_ENTITY_TYPES = ["company", "contact", "inquiry", "quote", "project", "translator", "settlement", "payment", "user"] as const;

/** 연결된 업무 표시 라벨(기존 테이블 읽기 전용 조회). */
export async function resolveLinkLabels(links: Array<{ entityType: string; entityId: number }>): Promise<Map<string, string>> {
  const by = new Map<string, number[]>();
  for (const l of links) { const a = by.get(l.entityType) ?? []; a.push(l.entityId); by.set(l.entityType, a); }
  const out = new Map<string, string>();
  const key = (t: string, id: number) => `${t}:${id}`;
  const ids = (t: string) => [...new Set(by.get(t) ?? [])];
  const jobs: Promise<void>[] = [];
  if (ids("company").length) jobs.push(db.select({ id: companiesTable.id, n: companiesTable.name }).from(companiesTable).where(inArray(companiesTable.id, ids("company")))
    .then(r => r.forEach(x => out.set(key("company", x.id), x.n))));
  if (ids("contact").length) jobs.push(db.select({ id: contactsTable.id, n: contactsTable.name }).from(contactsTable).where(inArray(contactsTable.id, ids("contact")))
    .then(r => r.forEach(x => out.set(key("contact", x.id), x.n))));
  if (ids("quote").length) jobs.push(db.select({ id: quotesTable.id, no: quotesTable.quoteNumber, t: quotesTable.title }).from(quotesTable).where(inArray(quotesTable.id, ids("quote")))
    .then(r => r.forEach(x => out.set(key("quote", x.id), [x.no, x.t].filter(Boolean).join(" ") || `견적 #${x.id}`))));
  if (ids("inquiry").length) jobs.push(db.select({ id: inquiriesTable.id, no: inquiriesTable.inquiryNumber, c: inquiriesTable.customerCompanyName }).from(inquiriesTable).where(inArray(inquiriesTable.id, ids("inquiry")))
    .then(r => r.forEach(x => out.set(key("inquiry", x.id), [x.no, x.c].filter(Boolean).join(" ") || `의뢰 #${x.id}`))));
  if (ids("project").length) jobs.push(db.select({ id: projectsTable.id, t: projectsTable.title }).from(projectsTable).where(inArray(projectsTable.id, ids("project")))
    .then(r => r.forEach(x => out.set(key("project", x.id), x.t))));
  const userIds = [...ids("translator"), ...ids("user")];
  if (userIds.length) jobs.push(db.select({ id: usersTable.id, n: usersTable.name, e: usersTable.email }).from(usersTable).where(inArray(usersTable.id, userIds))
    .then(r => r.forEach(x => { const n = x.n || x.e; out.set(key("translator", x.id), n); out.set(key("user", x.id), n); })));
  await Promise.all(jobs);
  for (const l of links) if (!out.has(key(l.entityType, l.entityId))) out.set(key(l.entityType, l.entityId), `#${l.entityId}`);
  return out;
}

export function parseId(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
