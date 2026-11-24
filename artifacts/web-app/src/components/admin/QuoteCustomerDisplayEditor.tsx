/**
 * QuoteCustomerDisplayEditor — 견적서 A. 기본정보 하단 [거래처정보 편집].
 *
 *  · 상호·사업자번호·대표자·담당자·연락처·이메일·주소를 이 견적서에서만 수정하고, 항목별 표시 여부를 정한다.
 *  · 처음 열면 지금 견적서에 출력되는 값(저장된 견적) 또는 선택한 거래처·담당자 Master 값을 불러온다.
 *  · 적용한 값은 견적 저장 시 quotes.customer_display 로 저장 → 미리보기·PDF 에 반영. Master·다른 견적서 무변경.
 */
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/constants';
import { buildQuotePdfData, type CustomerDisplay, type CustomerDisplayKey } from '../../lib/quotePdf';

const FIELDS: { key: CustomerDisplayKey; label: string }[] = [
  { key: 'companyName', label: '상호' },
  { key: 'businessNumber', label: '사업자번호' },
  { key: 'representativeName', label: '대표자' },
  { key: 'contactName', label: '담당자' },
  { key: 'phone', label: '연락처' },
  { key: 'email', label: '이메일' },
  { key: 'address', label: '주소' },
];
type Values = Record<CustomerDisplayKey, string>;
const EMPTY: Values = { companyName: '', businessNumber: '', representativeName: '', contactName: '', phone: '', email: '', address: '' };
const t = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function QuoteCustomerDisplayEditor({ token, savedQuoteId, companyId, contactId, value, onChange, pending = false }: {
  token: string;
  savedQuoteId: number | null;
  companyId: number | null;
  contactId: number | null;
  /** undefined = 이번 편집에서 손대지 않음(저장 시 미전달 → 기존값 보존) */
  value: CustomerDisplay | null | undefined;
  onChange: (v: CustomerDisplay) => void;
  /** 적용 후 견적 저장 전 — '저장 필요' 안내 */
  pending?: boolean;
}) {
  const authH = { Authorization: `Bearer ${token}` };
  const [stored, setStored] = useState<CustomerDisplay | null>(null);   // 저장된 편집값(요약 표시용)
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [vals, setVals] = useState<Values>(EMPTY);
  // 편집 시작 시 견적서에 출력되던 기본값 — 적용 시 이 값과 다른(직접 고친) 항목만 저장한다.
  //  (손대지 않은 항목까지 저장하면 거래처 상호 변경·담당자 정보 갱신이 견적서에 반영되지 않음)
  const [baseVals, setBaseVals] = useState<Values>(EMPTY);
  const [hidden, setHidden] = useState<Set<CustomerDisplayKey>>(new Set());

  // 저장된 견적의 편집값 — 요약 표시와 편집 시작값
  useEffect(() => {
    if (savedQuoteId == null) return;
    fetch(api(`/api/admin/quotes/${savedQuoteId}`), { headers: authH })
      .then(r => (r.ok ? r.json() : null)).then(d => setStored(d?.customerDisplay ?? null)).catch(() => {});
  }, [savedQuoteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = value !== undefined ? value : stored;

  // 선택한 거래처·담당자 Master 값
  const loadFromMaster = async (): Promise<Values> => {
    const [co, ct] = await Promise.all([
      companyId ? fetch(api(`/api/admin/companies/${companyId}`), { headers: authH }).then(r => (r.ok ? r.json() : null)).catch(() => null) : null,
      contactId ? fetch(api(`/api/admin/contacts/${contactId}`), { headers: authH }).then(r => (r.ok ? r.json() : null)).catch(() => null) : null,
    ]);
    return {
      companyName: t(co?.name), businessNumber: t(co?.businessNumber), representativeName: t(co?.representativeName),
      contactName: t(ct?.name), phone: t(ct?.phone) || t(ct?.mobile) || t(ct?.officePhone),
      email: t(ct?.email) || t(co?.email), address: t(co?.address),
    };
  };

  // 저장된 견적 — 지금 견적서에 출력되는 수신자 값(편집값 적용 전)
  const loadFromQuote = async (): Promise<Values | null> => {
    if (savedQuoteId == null) return null;
    const d = await fetch(api(`/api/admin/quotes/${savedQuoteId}`), { headers: authH }).then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (!d) return null;
    const c = buildQuotePdfData({ ...d, customerDisplay: null }).customer;
    return {
      companyName: c.brandName ? `${c.companyName} (${c.brandName})` : c.companyName, businessNumber: c.businessNumber,
      representativeName: c.representativeName, contactName: c.contactName, phone: c.contactPhone, email: c.contactEmail, address: c.address,
    };
  };

  const openEditor = async () => {
    setBusy(true);
    try {
      if (current) {
        const base = (await loadFromQuote()) ?? (await loadFromMaster());
        setBaseVals(base);
        setVals({ ...base, ...Object.fromEntries(Object.entries(current.fields ?? {}).filter(([, v]) => typeof v === 'string')) } as Values);
        setHidden(new Set(current.hidden ?? []));
      } else {
        const base = (await loadFromQuote()) ?? (await loadFromMaster());
        setBaseVals(base);
        setVals(base);
        setHidden(new Set());
      }
      setOpen(true);
    } finally { setBusy(false); }
  };

  const reloadMaster = async () => {
    setBusy(true);
    try { setVals(await loadFromMaster()); } finally { setBusy(false); }
  };

  const apply = () => {
    const changed = Object.fromEntries((Object.keys(vals) as CustomerDisplayKey[])
      .filter(k => vals[k].trim() !== (baseVals[k] ?? '').trim()).map(k => [k, vals[k]]));
    onChange({ fields: changed, hidden: [...hidden] });
    setOpen(false);
  };

  const hiddenLabels = (current?.hidden ?? []).map(k => FIELDS.find(f => f.key === k)?.label).filter(Boolean);
  const btn = (primary = false): React.CSSProperties => ({
    padding: '6px 12px', fontSize: 12, fontWeight: 700, borderRadius: 6, cursor: busy ? 'wait' : 'pointer',
    border: primary ? 'none' : '1px solid #d1d5db', background: primary ? '#2563eb' : '#fff', color: primary ? '#fff' : '#374151',
  });

  return (
    <div data-testid="quote-customer-display" style={{ marginTop: 4, borderTop: '1px dashed #e5e7eb', paddingTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => (open ? setOpen(false) : void openEditor())} disabled={busy}
          data-testid="btn-quote-customer-display" aria-label="거래처정보 편집" aria-expanded={open} style={btn()}>
          {open ? '거래처정보 편집 닫기' : '거래처정보 편집'}
        </button>
        {current && !open && (
          <span data-testid="quote-customer-display-summary" style={{ fontSize: 12, color: '#2563eb', fontWeight: 600 }}>
            이 견적서 전용 수신처 적용{hiddenLabels.length ? ` · 숨김: ${hiddenLabels.join(', ')}` : ''}
            {pending && <span data-testid="quote-customer-display-pending" style={{ marginLeft: 8, color: '#b45309', fontWeight: 700 }}>· 저장 필요</span>}
          </span>
        )}
      </div>

      {open && (
        <div style={{ marginTop: 10, border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, background: '#f9fafb' }}>
          <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 8 }}>
            이 견적서의 미리보기·PDF 에만 적용됩니다. 거래처 정보와 다른 견적서는 바뀌지 않습니다. 체크 해제한 항목은 견적서에서 숨깁니다.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 90px 1fr', gap: '6px 10px', alignItems: 'center' }}>
            {FIELDS.map(f => {
              const shown = !hidden.has(f.key);
              return (
                <React.Fragment key={f.key}>
                  <input type="checkbox" checked={shown}
                    onChange={() => setHidden(prev => { const n = new Set(prev); n.has(f.key) ? n.delete(f.key) : n.add(f.key); return n; })}
                    data-testid={`cd-show-${f.key}`} aria-label={`${f.label} 표시`} style={{ width: 15, height: 15, cursor: 'pointer' }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: shown ? '#374151' : '#9ca3af' }}>{f.label}</span>
                  <input type="text" value={vals[f.key]} onChange={e => setVals(v => ({ ...v, [f.key]: e.target.value }))}
                    data-testid={`cd-input-${f.key}`} aria-label={`${f.label} 입력`}
                    style={{ padding: '6px 9px', fontSize: 12, border: '1px solid #d1d5db', borderRadius: 6, outline: 'none', background: shown ? '#fff' : '#f3f4f6', color: shown ? '#111827' : '#9ca3af' }} />
                </React.Fragment>
              );
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button type="button" onClick={reloadMaster} disabled={busy || (!companyId && !contactId)}
              data-testid="btn-cd-reload-master" aria-label="선택한 거래처 정보 불러오기" style={btn()}>거래처 정보 불러오기</button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={() => setOpen(false)} data-testid="btn-cd-cancel" aria-label="거래처정보 편집 취소" style={btn()}>취소</button>
              <button type="button" onClick={apply} disabled={busy} data-testid="btn-cd-apply" aria-label="거래처정보 적용" style={btn(true)}>적용</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default QuoteCustomerDisplayEditor;
