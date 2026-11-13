// ─── 거래처 기본 세금 유형(견적 작성 시 추천용) ─────────────────────────────────
//  일반과세 · 영세율 · 면세 · 미확인 + 적용 근거 · 확인일 · 확인 담당자.
//  추천값일 뿐: 견적에는 담당자가 최종 선택한 유형이 저장되고, 이 값을 바꿔도 기존 견적·판매·청구는 바뀌지 않는다.
//  국제기구·면세기관이라는 이유만으로 자동 적용하지 않도록 근거 입력을 함께 받는다.
import React, { useEffect, useState } from 'react';
import { Receipt } from 'lucide-react';
import { api } from '../../lib/constants';
import { ClickSelect } from '../ui';
import { COMPANY_TAX_TYPE_OPTIONS, companyTaxTypeLabel } from '../../lib/quoteTaxType';

type TaxInfo = { defaultTaxType: string | null; taxTypeBasis: string | null; taxTypeConfirmedAt: string | null; confirmedByName: string | null };

export function CompanyTaxTypeSection({ companyId, token, onToast }: { companyId: number; token: string; onToast: (msg: string) => void }) {
  const [info, setInfo] = useState<TaxInfo | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftType, setDraftType] = useState('');
  const [draftBasis, setDraftBasis] = useState('');
  const [saving, setSaving] = useState(false);
  const authH = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    let alive = true;
    fetch(api(`/api/admin/companies/${companyId}/tax-type`), { headers: authH })
      .then(r => r.ok ? r.json() : null).then(d => { if (alive) setInfo(d); }).catch(() => {});
    return () => { alive = false; };
  }, [companyId, token]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!info) return null;
  const startEdit = () => { setDraftType(info.defaultTaxType ?? ''); setDraftBasis(info.taxTypeBasis ?? ''); setEditing(true); };
  const save = async () => {
    if (draftType && draftType !== 'taxable' && !draftBasis.trim()) { onToast('영세율·면세는 적용 근거(확인 자료)를 입력하세요.'); return; }
    setSaving(true);
    try {
      const r = await fetch(api(`/api/admin/companies/${companyId}/tax-type`), {
        method: 'PUT', headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultTaxType: draftType || null, taxTypeBasis: draftBasis.trim() || null }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { onToast(d.error ?? '세금 유형 저장 실패'); return; }
      setInfo(d); setEditing(false); onToast('기본 세금 유형을 저장했습니다. (기존 견적·판매에는 반영되지 않습니다)');
    } finally { setSaving(false); }
  };

  const unconfirmed = !info.defaultTaxType;
  return (
    <div data-testid="company-tax-type-section" style={{ background: '#fff', borderRadius: 10, border: '1px solid #e5e7eb', padding: '12px 20px', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Receipt size={17} color="#6b7280" style={{ flexShrink: 0 }} />
        <span style={{ fontSize: 13, color: '#6b7280', fontWeight: 600 }}>기본 세금 유형</span>
        {!editing && (
          <>
            <span data-testid="company-tax-type-value" style={{ fontSize: 12, borderRadius: 20, padding: '2px 10px', fontWeight: 700,
              background: unconfirmed ? '#fffbeb' : '#eff6ff', color: unconfirmed ? '#b45309' : '#1d4ed8', border: `1px solid ${unconfirmed ? '#fde68a' : '#93c5fd'}` }}>
              {companyTaxTypeLabel(info.defaultTaxType)}
            </span>
            {info.taxTypeConfirmedAt && <span style={{ fontSize: 12, color: '#6b7280' }}>확인 {info.taxTypeConfirmedAt}{info.confirmedByName ? ` · ${info.confirmedByName}` : ''}</span>}
            <button type="button" onClick={startEdit} data-testid="btn-company-tax-type-edit" aria-label="기본 세금 유형 수정"
              style={{ marginLeft: 'auto', fontSize: 12, padding: '3px 10px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>수정</button>
          </>
        )}
      </div>
      {!editing && info.taxTypeBasis && <div style={{ marginTop: 6, fontSize: 12.5, color: '#374151', whiteSpace: 'pre-wrap' }}>근거: {info.taxTypeBasis}</div>}
      {!editing && <div style={{ marginTop: 4, fontSize: 11.5, color: '#9ca3af' }}>견적 작성 시 추천값으로만 사용됩니다. 실제 공급 용역의 적용 요건을 확인해 주세요.</div>}
      {editing && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ width: 200 }}>
            <ClickSelect value={draftType} onChange={setDraftType} aria-label="기본 세금 유형 선택" data-testid="select-company-tax-type"
              options={COMPANY_TAX_TYPE_OPTIONS.map(o => ({ value: o.value, label: o.label }))} />
          </div>
          <textarea value={draftBasis} onChange={e => setDraftBasis(e.target.value)} rows={2} placeholder="적용 근거·확인 자료 (예: 2026-10 영세율 세금계산서 발행 실적, 국외 용역 공급 확인서)"
            data-testid="input-company-tax-basis" aria-label="세금 유형 적용 근거"
            style={{ fontSize: 13, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, resize: 'vertical', fontFamily: 'inherit' }} />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setEditing(false)} disabled={saving} data-testid="btn-company-tax-type-cancel" aria-label="세금 유형 수정 취소"
              style={{ fontSize: 12, padding: '4px 12px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>취소</button>
            <button type="button" onClick={save} disabled={saving} data-testid="btn-company-tax-type-save" aria-label="세금 유형 저장"
              style={{ fontSize: 12, padding: '4px 12px', borderRadius: 6, border: '1px solid #2563eb', background: '#2563eb', color: '#fff', cursor: 'pointer' }}>{saving ? '저장 중…' : '저장'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 거래처 등록·수정 폼용(CompanyForm) — 같은 API(PUT /tax-type)로 저장해 확인일·확인 담당자·감사로그를 한 곳에서 기록 ───
export type CompanyTaxDraft = { type: string; basis: string };
export const COMPANY_TAX_FORM_LABEL: Record<string, string> = { '': '미확인', taxable: '일반과세 (10%)', zero_rate: '영세율 (0%)', exempt: '면세' };

/** 영세율·면세는 근거 필수 — 오류 문구(없으면 null) */
export function companyTaxDraftError(d: CompanyTaxDraft): string | null {
  return d.type && d.type !== 'taxable' && !d.basis.trim() ? '영세율·면세는 적용 근거(확인 자료)를 입력하세요.' : null;
}
/** 변경된 경우에만 저장(미변경이면 호출 없음 — 확인일·담당자 갱신 안 함) */
export async function saveCompanyTaxDraft(companyId: number, token: string, draft: CompanyTaxDraft, initial: CompanyTaxDraft): Promise<string | null> {
  if (draft.type === initial.type && draft.basis.trim() === initial.basis.trim()) return null;
  const r = await fetch(api(`/api/admin/companies/${companyId}/tax-type`), {
    method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ defaultTaxType: draft.type || null, taxTypeBasis: draft.basis.trim() || null }),
  });
  if (r.ok) return null;
  const d = await r.json().catch(() => ({}));
  return d.error ?? '세금 유형 저장 실패';
}

export function CompanyTaxTypeFields({ value, onChange, confirmedInfo, inputStyle }: {
  value: CompanyTaxDraft; onChange: (v: CompanyTaxDraft) => void;
  confirmedInfo?: { at: string | null; by: string | null } | null; inputStyle: React.CSSProperties;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="company-form-tax-type">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ width: 200 }}>
          <ClickSelect value={value.type} onChange={v => onChange({ ...value, type: v })} aria-label="기본 세금 유형" data-testid="select-company-form-tax-type"
            options={COMPANY_TAX_TYPE_OPTIONS.map(o => ({ value: o.value, label: COMPANY_TAX_FORM_LABEL[o.value] }))} />
        </div>
        {confirmedInfo?.at && <span style={{ fontSize: 12, color: '#6b7280' }}>확인 {confirmedInfo.at}{confirmedInfo.by ? ` · ${confirmedInfo.by}` : ''}</span>}
      </div>
      <textarea value={value.basis} onChange={e => onChange({ ...value, basis: e.target.value })} rows={2}
        placeholder="적용 근거·확인 자료 (영세율·면세는 필수 — 예: 영세율 전자세금계산서 발행 실적, 국외 용역 공급 확인서)"
        data-testid="input-company-form-tax-basis" aria-label="세금 유형 적용 근거" style={{ ...inputStyle, resize: 'vertical', minHeight: 40 }} />
      <span style={{ fontSize: 11.5, color: '#9ca3af' }}>견적 작성 시 추천값으로만 사용됩니다(기존 견적·판매·청구는 변경되지 않음). 국제기구·면세기관이라도 실제 공급 용역의 적용 요건을 확인해 주세요.</span>
    </div>
  );
}
