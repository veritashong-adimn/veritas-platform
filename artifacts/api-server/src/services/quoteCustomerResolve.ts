/**
 * quoteCustomerResolve — 의뢰건 → 견적 저장 시 거래처·담당자 Master 판정/연결/신규등록.
 *
 * 견적서 작성 버튼을 눌렀다고 Master 를 만들지 않는다. 판정(plan)은 읽기 전용이며,
 * 실제 신규등록·연결(execute)은 견적 저장 트랜잭션 안에서만 수행한다(실패 시 함께 롤백).
 *
 * 판정 근거는 직원이 확인·저장한 의뢰건 레코드(inquiries)다(AI 원문 분석값이 아님).
 *
 * 거래처:
 *   · 의뢰건에 연결된 거래처 → link
 *   · 정규화 회사명이 정확히 일치하는 기존 거래처가 1곳 → link(자동연결)
 *   · 2곳 이상(동명 거래처) → confirm(직원 선택)
 *   · 이름 일치 없음 + 전화번호가 같은 거래처 존재 → confirm(같은 고객일 가능성)
 *   · 없음 → create(회사명이 있을 때만) / 회사명 없음 → none
 *   (의뢰건에는 사업자등록번호가 없어 비교하지 않는다 — 원문에 있으면 직원이 거래처 Master 에서 확인)
 * 담당자(거래처가 정해진 경우만):
 *   · 의뢰건에 연결된 담당자 → link
 *   · 같은 거래처 + 이메일 일치 → link / 같은 거래처 + 휴대폰 일치 → link
 *   · 같은 거래처 + 이름만 일치(연락처 불일치/없음) → confirm
 *   · 다른 거래처에 같은 이메일 → confirm(이메일 하나로 동일인 단정하지 않음)
 *   · 없음 → create(이름 + 이메일 또는 휴대폰이 있을 때만) / 정보 부족 → none(스냅샷만 보존)
 * 기존 Master 는 수정하지 않는다.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, companiesTable, contactsTable, inquiriesTable } from "@workspace/db";

type Dbx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ResolveAction = "link" | "create" | "confirm" | "none";
export interface Candidate { id: number; name: string; sub?: string | null }
export interface CustomerPlan {
  company: { action: ResolveAction; id?: number; name?: string; reason: string; candidates: Candidate[] };
  contact: { action: ResolveAction; id?: number; name?: string; reason: string; candidates: Candidate[] };
  snapshot: CustomerSnapshot;
}
export interface CustomerSnapshot {
  customerCompanyName: string | null; customerContactName: string | null; customerContactPosition: string | null;
  customerContactDepartment: string | null; customerContactPhone: string | null; customerContactMobile: string | null; customerContactEmail: string | null;
}
/** 직원 선택(확인 필요 해소) — 저장 요청에 함께 보낸다 */
export interface CustomerChoice {
  companyId?: number | null;        // 기존 거래처 선택
  contactId?: number | null;        // 기존 담당자 선택
  createCompany?: boolean;          // 유사 거래처가 있어도 신규 등록(직원 확인)
  createContact?: boolean;          // 이름이 같은 담당자가 있어도 신규 등록(직원 확인)
  skipContact?: boolean;            // 담당자 Master 연결 없이 저장(스냅샷만)
}

type InquiryRow = typeof inquiriesTable.$inferSelect;

const normName = (s?: string | null) => (s ?? "").replace(/\(주\)|㈜|주식회사|\(재\)|재단법인|\(사\)|사단법인|\s+/g, "").toLowerCase();
const digits = (s?: string | null) => (s ?? "").replace(/\D/g, "");
const normEmail = (s?: string | null) => (s ?? "").trim().toLowerCase();
const t = (s?: string | null) => (s ?? "").trim() || null;

export function snapshotOf(inq: InquiryRow): CustomerSnapshot {
  return {
    customerCompanyName: t(inq.customerCompanyName), customerContactName: t(inq.contactName),
    customerContactPosition: t(inq.contactPosition), customerContactDepartment: t(inq.department),
    customerContactPhone: t(inq.contactPhone), customerContactMobile: t(inq.contactMobile), customerContactEmail: t(inq.contactEmail),
  };
}

/** 판정(읽기 전용). choice 가 있으면 직원 선택을 반영해 다시 판정한다. */
export async function planCustomer(dbx: Dbx, inq: InquiryRow, choice: CustomerChoice = {}): Promise<CustomerPlan> {
  const snapshot = snapshotOf(inq);
  const plan: CustomerPlan = {
    company: { action: "none", reason: "", candidates: [] },
    contact: { action: "none", reason: "", candidates: [] },
    snapshot,
  };

  // ── 거래처 ──
  const liveCompany = async (id: number) => (await dbx.select({ id: companiesTable.id, name: companiesTable.name })
    .from(companiesTable).where(and(eq(companiesTable.id, id), isNull(companiesTable.deletedAt))).limit(1))[0];
  const chosenCo = choice.companyId ? await liveCompany(choice.companyId) : undefined;
  const linkedCo = inq.companyId ? await liveCompany(inq.companyId) : undefined;
  if (linkedCo) plan.company = { action: "link", id: linkedCo.id, name: linkedCo.name, reason: "의뢰건에 연결된 거래처", candidates: [] };
  else if (chosenCo) plan.company = {
    action: "link", id: chosenCo.id, name: chosenCo.name, candidates: [],
    // 화면이 자동 선택한 경우(회사명 정확히 일치)와 직원이 고른 경우를 구분해 안내
    reason: snapshot.customerCompanyName && normName(chosenCo.name) === normName(snapshot.customerCompanyName) ? "회사명이 정확히 일치하는 기존 거래처" : "직원이 선택한 거래처",
  };
  else if (snapshot.customerCompanyName) {
    const key = normName(snapshot.customerCompanyName);
    const all = await dbx.select({ id: companiesTable.id, name: companiesTable.name, phone: companiesTable.phone, mobile: companiesTable.mobile, businessNumber: companiesTable.businessNumber })
      .from(companiesTable).where(isNull(companiesTable.deletedAt));
    const exact = all.filter(c => normName(c.name) === key);
    if (exact.length === 1 && !choice.createCompany) {
      plan.company = { action: "link", id: exact[0].id, name: exact[0].name, reason: "정규화 회사명이 정확히 일치하는 거래처 1곳", candidates: [] };
    } else if (exact.length > 1 && !choice.createCompany) {
      plan.company = { action: "confirm", reason: `회사명이 같은 거래처가 ${exact.length}곳 — 직원 선택 필요`, candidates: exact.map(c => ({ id: c.id, name: c.name, sub: c.businessNumber })) };
    } else {
      const ph = digits(snapshot.customerContactPhone);
      const samePhone = ph.length >= 8 ? all.filter(c => digits(c.phone) === ph || digits(c.mobile) === ph) : [];
      if (samePhone.length && !choice.createCompany) {
        plan.company = { action: "confirm", reason: "회사명은 다르지만 전화번호가 같은 거래처가 있음 — 같은 고객인지 확인 필요", candidates: samePhone.map(c => ({ id: c.id, name: c.name, sub: c.phone })) };
      } else {
        plan.company = { action: "create", name: snapshot.customerCompanyName, reason: choice.createCompany ? "직원 확인 후 신규 거래처 등록" : "일치하는 거래처 없음 — 저장 시 신규 등록", candidates: exact.map(c => ({ id: c.id, name: c.name })) };
      }
    }
  } else {
    plan.company = { action: "none", reason: "회사명 없음 — 거래처 등록 불가(정보 부족)", candidates: [] };
  }

  // ── 담당자 ──
  const coId = plan.company.action === "link" ? plan.company.id! : null;
  const companyKnown = plan.company.action === "link" || plan.company.action === "create";
  const liveContact = async (id: number) => (await dbx.select({ id: contactsTable.id, name: contactsTable.name, companyId: contactsTable.companyId })
    .from(contactsTable).where(and(eq(contactsTable.id, id), isNull(contactsTable.deletedAt))).limit(1))[0];
  const linkedCt = inq.contactId ? await liveContact(inq.contactId) : undefined;
  const chosenCt = choice.contactId ? await liveContact(choice.contactId) : undefined;
  if (linkedCt) plan.contact = { action: "link", id: linkedCt.id, name: linkedCt.name, reason: "의뢰건에 연결된 담당자", candidates: [] };
  else if (chosenCt && (!coId || chosenCt.companyId === coId)) plan.contact = { action: "link", id: chosenCt.id, name: chosenCt.name, reason: "직원이 선택한 담당자", candidates: [] };
  else if (choice.skipContact) plan.contact = { action: "none", reason: "직원 선택 — 담당자 Master 연결 없이 저장(고객정보 스냅샷만 보존)", candidates: [] };
  else if (!companyKnown) plan.contact = { action: "none", reason: "거래처가 정해지지 않아 담당자를 연결·등록하지 않음", candidates: [] };
  else {
    const email = normEmail(snapshot.customerContactEmail), mobile = digits(snapshot.customerContactMobile), name = normName(snapshot.customerContactName);
    const inCompany = coId ? await dbx.select({ id: contactsTable.id, name: contactsTable.name, email: contactsTable.email, mobile: contactsTable.mobile, position: contactsTable.position })
      .from(contactsTable).where(and(eq(contactsTable.companyId, coId), isNull(contactsTable.deletedAt))) : [];
    const byEmail = email ? inCompany.filter(c => normEmail(c.email) === email) : [];
    const byMobile = mobile ? inCompany.filter(c => digits(c.mobile) === mobile) : [];
    const byName = name ? inCompany.filter(c => normName(c.name) === name) : [];
    const elsewhere = email ? await dbx.select({ id: contactsTable.id, name: contactsTable.name, companyId: contactsTable.companyId })
      .from(contactsTable).where(and(sql`lower(trim(${contactsTable.email})) = ${email}`, isNull(contactsTable.deletedAt))) : [];
    const otherCo = elsewhere.filter(c => c.companyId !== coId);
    const one = byEmail.length === 1 ? byEmail[0] : byMobile.length === 1 ? byMobile[0] : null;
    if (one && !choice.createContact) {
      plan.contact = { action: "link", id: one.id, name: one.name, reason: byEmail.length === 1 ? "같은 거래처·같은 이메일의 담당자" : "같은 거래처·같은 휴대폰의 담당자", candidates: [] };
    } else if ((byEmail.length > 1 || byMobile.length > 1 || byName.length > 0 || otherCo.length > 0) && !choice.createContact) {
      const cands = [...byEmail, ...byMobile, ...byName].filter((c, i, a) => a.findIndex(x => x.id === c.id) === i).map(c => ({ id: c.id, name: c.name, sub: c.email ?? c.mobile }));
      plan.contact = {
        action: "confirm",
        reason: otherCo.length && !cands.length ? "다른 거래처에 같은 이메일의 담당자가 있음 — 동일인인지 확인 필요" : "이름이 같은 담당자가 있음(연락처 불일치) — 동일인인지 확인 필요",
        candidates: [...cands, ...otherCo.map(c => ({ id: c.id, name: c.name, sub: `다른 거래처 #${c.companyId}` }))],
      };
    } else if (snapshot.customerContactName && (email || mobile)) {
      plan.contact = { action: "create", name: snapshot.customerContactName, reason: choice.createContact ? "직원 확인 후 신규 담당자 등록" : "일치하는 담당자 없음 — 저장 시 신규 등록", candidates: [] };
    } else {
      plan.contact = { action: "none", reason: "담당자 이름과 이메일/휴대폰이 없어 등록하지 않음(스냅샷만 보존)", candidates: [] };
    }
  }
  return plan;
}

/** 확인이 필요한 항목이 남아 있으면 그 사유(저장 차단용). 없으면 null. */
export function unresolved(plan: CustomerPlan): string | null {
  const r = [plan.company.action === "confirm" ? `거래처: ${plan.company.reason}` : "", plan.contact.action === "confirm" ? `담당자: ${plan.contact.reason}` : ""].filter(Boolean);
  return r.length ? r.join(" / ") : null;
}

/**
 * 실행 — 견적 저장 트랜잭션(tx) 안에서만 호출. plan 대로 신규 거래처·담당자를 만들고 ID 를 돌려준다.
 * 기존 Master 는 수정하지 않는다. 호출 측이 같은 tx 로 견적·의뢰건 연결을 이어서 기록한다.
 */
export async function executeCustomer(tx: Dbx, plan: CustomerPlan, inq: InquiryRow): Promise<{ companyId: number | null; contactId: number | null; created: { company?: number; contact?: number } }> {
  const created: { company?: number; contact?: number } = {};
  let companyId: number | null = plan.company.action === "link" ? plan.company.id! : null;
  if (plan.company.action === "create") {
    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const [co] = await tx.insert(companiesTable).values({
      name: plan.snapshot.customerCompanyName!,
      registeredAt: today, companyType: "client", customerType: "CORPORATE", isCustomer: true, isVendor: false,
      notes: `의뢰건 ${inq.inquiryNumber ?? `#${inq.id}`} 견적 저장 시 등록(중복검증 통과)`,
    }).returning({ id: companiesTable.id });
    companyId = co.id; created.company = co.id;
  }
  let contactId: number | null = plan.contact.action === "link" ? plan.contact.id! : null;
  if (plan.contact.action === "create" && companyId) {
    const s = plan.snapshot;
    const [ct] = await tx.insert(contactsTable).values({
      companyId, name: s.customerContactName!, department: s.customerContactDepartment, position: s.customerContactPosition,
      email: s.customerContactEmail, phone: s.customerContactPhone, mobile: s.customerContactMobile, isQuoteContact: true,
      notes: `의뢰건 ${inq.inquiryNumber ?? `#${inq.id}`} 견적 저장 시 등록(중복검증 통과)`,
    }).returning({ id: contactsTable.id });
    contactId = ct.id; created.contact = ct.id;
  }
  return { companyId, contactId, created };
}
