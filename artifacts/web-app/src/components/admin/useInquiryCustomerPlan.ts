/**
 * useInquiryCustomerPlan — 의뢰건에서 작성하는 견적의 거래처·담당자 Master 판정(서버 미리보기)과 직원 선택.
 *
 *  · 판정은 서버(GET /api/admin/inquiries/:id/customer-plan, 읽기 전용)가 한다 — 저장 시 같은 규칙으로 다시 판정.
 *  · 기존 거래처/담당자가 정확히 1건 일치(link)하면 화면의 거래처·담당자 입력란에 1회 자동 선택한다.
 *  · 신규 등록(create)·확인 필요(confirm)는 저장 시 처리 — 여기서는 Master 를 만들지 않는다.
 *  · choice 는 저장 요청(inquiryCustomer)에 그대로 실려 서버 트랜잭션에서 반영된다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/constants';

export type ResolveAction = 'link' | 'create' | 'confirm' | 'none';
export interface PlanPart { action: ResolveAction; id?: number; name?: string; reason: string; candidates: Array<{ id: number; name: string; sub?: string | null }> }
export interface CustomerPlan {
  company: PlanPart; contact: PlanPart;
  snapshot: { customerCompanyName: string | null; customerContactName: string | null; customerContactPosition: string | null; customerContactDepartment: string | null; customerContactPhone: string | null; customerContactMobile: string | null; customerContactEmail: string | null };
  quoteId?: number | null;
}
export interface CustomerChoice { createCompany?: boolean; createContact?: boolean; skipContact?: boolean }

export function useInquiryCustomerPlan({ token, inquiryId, enabled, companyId, contactId, onAutoCompany, onAutoContact }: {
  token: string; inquiryId: number | null | undefined; enabled: boolean;
  companyId: number | null; contactId: number | null;
  onAutoCompany: (id: number) => void; onAutoContact: (id: number) => void;
}) {
  const [plan, setPlan] = useState<CustomerPlan | null>(null);
  const [choice, setChoice] = useState<CustomerChoice>({});
  const [tick, setTick] = useState(0);
  const autoCompanyRef = useRef(false);
  const autoContactRef = useRef(false);

  useEffect(() => {
    if (!enabled || !inquiryId) return;
    const qs = new URLSearchParams();
    if (companyId) qs.set('companyId', String(companyId));
    if (contactId) qs.set('contactId', String(contactId));
    if (choice.createCompany) qs.set('createCompany', '1');
    if (choice.createContact) qs.set('createContact', '1');
    if (choice.skipContact) qs.set('skipContact', '1');
    let alive = true;
    fetch(api(`/api/admin/inquiries/${inquiryId}/customer-plan?${qs}`), { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null).then(p => { if (alive && p) setPlan(p as CustomerPlan); }).catch(() => { /* 판정 실패 시 패널만 비움 */ });
    return () => { alive = false; };
  }, [enabled, inquiryId, companyId, contactId, choice, tick, token]);

  // 기존 Master 와 정확히 일치하면 1회 자동 선택(직원이 이후 바꾸면 다시 덮지 않음)
  useEffect(() => {
    if (!plan) return;
    if (!autoCompanyRef.current && plan.company.action === 'link' && plan.company.id && companyId == null) { autoCompanyRef.current = true; onAutoCompany(plan.company.id); }
    else if (companyId != null) autoCompanyRef.current = true;
    if (!autoContactRef.current && plan.contact.action === 'link' && plan.contact.id && contactId == null && companyId != null) { autoContactRef.current = true; onAutoContact(plan.contact.id); }
  }, [plan]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(() => setTick(t => t + 1), []);
  return { plan, choice, setChoice, refresh };
}
