/**
 * inquiryAnalysisLookup — AI 의뢰 분석 결과로 기존 CRM 거래처·담당자와 기존 의뢰건·프로젝트 후보를 "조회만" 한다.
 *
 *  · CRM 연결 판정은 견적 저장 시 쓰는 기존 규칙(planCustomer, 읽기 전용)을 그대로 재사용한다 — 정책 이중화 방지.
 *  · 기존 의뢰건·프로젝트는 회사명·일정·서비스 유형·제목으로 연결 후보만 제시한다. 생성·연결·수정은 하지 않는다.
 */
import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { db, companiesTable, inquiriesTable, projectsTable } from "@workspace/db";
import { planCustomer, type CustomerPlan } from "./quoteCustomerResolve";

const normName = (s?: string | null) => (s ?? "").replace(/\(주\)|㈜|주식회사|\(재\)|재단법인|\(사\)|사단법인|\s+/g, "").toLowerCase();

/** 회사명이 기존 CRM 거래처와 (정규화 후) 정확히 같은지 — 고객사 후보 판단용. 목록은 요청당 1회만 읽는다. */
export function makeKnownCompanyChecker(): (name: string) => Promise<boolean> {
  let names: Promise<Set<string>> | null = null;
  return async (name: string) => {
    names ??= db.select({ name: companiesTable.name }).from(companiesTable).where(isNull(companiesTable.deletedAt))
      .then(rows => new Set(rows.map(r => normName(r.name)).filter(Boolean)))
      .catch(() => new Set<string>());
    const n = normName(name);
    return !!n && (await names).has(n);
  };
}

export interface ExistingCandidate {
  kind: "inquiry" | "project";
  id: number;
  label: string;          // 의뢰번호/프로젝트 제목
  date: string | null;    // 통역 일정(의뢰건) 또는 생성일(프로젝트)
  status: string;
  reasons: string[];
}

type AnalyzedFields = Record<string, unknown>;
const likeEsc = (s: string) => s.replace(/[%_\\]/g, "\\$&");
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** CRM 연결 판정(기존 규칙) + 기존 의뢰건·프로젝트 후보. 실패해도 분석 응답에는 영향 없음(null/빈 배열). */
export async function lookupExistingRecords(fields: AnalyzedFields, subjectLine: string): Promise<{ crmMatch: CustomerPlan | null; projectCandidates: ExistingCandidate[] }> {
  const company = str(fields.customerCompanyName);
  let crmMatch: CustomerPlan | null = null;
  try {
    if (company || str(fields.contactName)) {
      const pseudo = {
        companyId: null, contactId: null, customerCompanyName: company || null, contactName: str(fields.contactName) || null,
        contactPosition: str(fields.contactPosition) || null, department: str(fields.department) || null,
        contactPhone: str(fields.contactPhone) || null, contactMobile: str(fields.contactMobile) || null, contactEmail: str(fields.contactEmail) || null,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      crmMatch = await planCustomer(db, pseudo as any);
    }
  } catch (e) { console.error("[INQUIRY-AI] CRM 조회 실패(분석에는 영향 없음):", e); }

  const projectCandidates: ExistingCandidate[] = [];
  try {
    const companyId = crmMatch?.company.action === "link" ? crmMatch.company.id ?? null : null;
    if (!companyId && !company) return { crmMatch, projectCandidates };
    const schedDate = str(fields.scheduleFrom).slice(0, 10);
    const svc = str(fields.serviceType);
    const words = `${str(fields.subject)} ${subjectLine}`.split(/[\s,()[\]/]+/).filter(w => w.length >= 3 && !/^\d+$/.test(w)).slice(0, 12);
    const near = (d: string | null) => !!(schedDate && d && Math.abs(Date.parse(d) - Date.parse(schedDate)) <= 14 * 864e5);

    const inqRows = await db.select({
      id: inquiriesTable.id, no: inquiriesTable.inquiryNumber, status: inquiriesTable.status, subject: inquiriesTable.subject,
      scheduleFrom: inquiriesTable.scheduleFrom, serviceType: inquiriesTable.serviceType, companyName: inquiriesTable.customerCompanyName,
    }).from(inquiriesTable)
      .where(and(isNull(inquiriesTable.deletedAt), companyId
        ? or(eq(inquiriesTable.companyId, companyId), ilike(inquiriesTable.customerCompanyName, `%${likeEsc(company)}%`))
        : ilike(inquiriesTable.customerCompanyName, `%${likeEsc(company)}%`)))
      .orderBy(desc(inquiriesTable.id)).limit(50);
    for (const r of inqRows) {
      if (!companyId && normName(r.companyName) !== normName(company)) continue;
      const d = r.scheduleFrom ? new Date(r.scheduleFrom).toISOString().slice(0, 10) : null;
      const reasons = ["같은 거래처"];
      if (near(d)) reasons.push("통역 일정 근접(±14일)");
      if (svc && r.serviceType === svc) reasons.push("같은 서비스 유형");
      if (words.some(w => (r.subject ?? "").includes(w))) reasons.push("제목·주제 단어 일치");
      projectCandidates.push({ kind: "inquiry", id: r.id, label: `${r.no ?? `#${r.id}`} ${r.subject ?? ""}`.trim(), date: d, status: r.status, reasons });
    }
    if (companyId) {
      const prjRows = await db.select({ id: projectsTable.id, title: projectsTable.title, status: projectsTable.status, createdAt: projectsTable.createdAt })
        .from(projectsTable).where(eq(projectsTable.companyId, companyId)).orderBy(desc(projectsTable.id)).limit(30);
      for (const r of prjRows) {
        const reasons = ["같은 거래처"];
        if (words.some(w => r.title.includes(w))) reasons.push("제목·주제 단어 일치");
        projectCandidates.push({ kind: "project", id: r.id, label: r.title, date: r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : null, status: r.status, reasons });
      }
    }
    projectCandidates.sort((a, b) => b.reasons.length - a.reasons.length || (b.date ?? "").localeCompare(a.date ?? ""));
  } catch (e) { console.error("[INQUIRY-AI] 기존 의뢰·프로젝트 조회 실패(분석에는 영향 없음):", e); }
  return { crmMatch, projectCandidates: projectCandidates.slice(0, 5) };
}
