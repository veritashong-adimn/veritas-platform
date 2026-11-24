// ─── 판매목록 날짜별 검색 바 — [전체자료]·[현재]·[과거 CRM] 공통 ─────────────────
//  기준(판매날짜 / 계산서 발행일 / 입금일) + 시작일 ~ 종료일(양끝 포함) + [검색]·[초기화].
//  입력값은 [검색]을 눌러야 적용된다(서버 검색: dateBasis·periodFrom·periodTo). 날짜 미선택 = 전체조회.
import React, { useEffect, useState } from 'react';
import { ClickSelect } from '../ui';
import { DateField } from './DatePickerShared';

export type SaleDateBasis = 'sale' | 'invoice' | 'deposit';
export interface SalePeriod { basis: SaleDateBasis; from: string; to: string }
export const EMPTY_SALE_PERIOD: SalePeriod = { basis: 'sale', from: '', to: '' };

export const hasSalePeriod = (p: SalePeriod) => !!(p.from || p.to);
// URLSearchParams 에 날짜 검색 조건 추가(미선택이면 아무것도 넣지 않음)
export function appendSalePeriod(params: URLSearchParams, p: SalePeriod) {
  if (!hasSalePeriod(p)) return;
  params.set('dateBasis', p.basis);
  if (p.from) params.set('periodFrom', p.from);
  if (p.to) params.set('periodTo', p.to);
}

const BASIS_OPTIONS: { value: SaleDateBasis; label: string }[] = [
  { value: 'sale', label: '판매날짜' }, { value: 'invoice', label: '계산서 발행일' }, { value: 'deposit', label: '입금일' },
];

export function SaleDateSearchBar({ value, onApply, disabled, idPrefix }: {
  value: SalePeriod; onApply: (p: SalePeriod) => void; disabled?: boolean; idPrefix: string;
}) {
  const [draft, setDraft] = useState<SalePeriod>(value);
  useEffect(() => { setDraft(value); }, [value.basis, value.from, value.to]); // 탭 전환·초기화 시 적용값과 동기화

  const field: React.CSSProperties = { padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, width: 128 };
  const btn = (primary: boolean): React.CSSProperties => ({ padding: '7px 12px', borderRadius: 8, fontWeight: 700, fontSize: 13, border: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, background: primary ? '#0ea5e9' : '#e5e7eb', color: primary ? '#fff' : '#374151' });

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }} data-testid={`${idPrefix}-date-search`}>
      <ClickSelect value={draft.basis} onChange={v => setDraft(d => ({ ...d, basis: v as SaleDateBasis }))} options={BASIS_OPTIONS}
        triggerStyle={{ fontSize: 13, minWidth: 116 }} aria-label="날짜 검색 기준" data-testid={`${idPrefix}-date-basis`} />
      <DateField value={draft.from} onChange={v => setDraft(d => ({ ...d, from: v }))} style={field}
        placeholder="시작일" ariaLabel="날짜 검색 시작일" testid={`${idPrefix}-date-from`} />
      <span style={{ color: '#9ca3af', fontSize: 12 }}>~</span>
      <DateField value={draft.to} onChange={v => setDraft(d => ({ ...d, to: v }))} style={field}
        placeholder="종료일" ariaLabel="날짜 검색 종료일" testid={`${idPrefix}-date-to`} />
      <button type="button" style={btn(true)} disabled={disabled} onClick={() => onApply(draft)}
        data-testid={`${idPrefix}-date-apply`} aria-label="날짜 검색">검색</button>
      <button type="button" style={btn(false)} disabled={disabled} onClick={() => { setDraft(EMPTY_SALE_PERIOD); onApply(EMPTY_SALE_PERIOD); }}
        data-testid={`${idPrefix}-date-reset`} aria-label="날짜 검색 초기화">초기화</button>
    </div>
  );
}
