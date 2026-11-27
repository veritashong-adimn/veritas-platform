// ─── 판매목록 날짜별 검색 바 — [전체자료]·[현재]·[과거 CRM] 공통 ─────────────────
//  기준(판매날짜 / 계산서 발행일 / 입금일) + 시작일 ~ 종료일(양끝 포함) + [검색]·[초기화].
//  입력값은 [검색]을 눌러야 적용된다(서버 검색: dateBasis·periodFrom·periodTo). 날짜 미선택 = 전체조회.
import React, { useEffect, useState } from 'react';
import { ClickSelect } from '../ui';
import { DateField } from './DatePickerShared';
import { listGroup, listSelectTrigger, listDateField, listBtnPrimary, listBtnGray } from '../../lib/listSearchUi';

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

export function SaleDateSearchBar({ value, onApply, disabled, idPrefix, hideReset }: {
  value: SalePeriod; onApply: (p: SalePeriod) => void; disabled?: boolean; idPrefix: string;
  /** 날짜 초기화 버튼 숨김 — 상위 검색 영역 끝의 공통 [초기화]가 날짜까지 초기화하는 화면에서 사용 */
  hideReset?: boolean;
}) {
  const [draft, setDraft] = useState<SalePeriod>(value);
  useEffect(() => { setDraft(value); }, [value.basis, value.from, value.to]); // 탭 전환·초기화 시 적용값과 동기화

  // 목록 공통 규격(높이 34 · 글자 13 · 검색 파란색/초기화 회색) — lib/listSearchUi
  const field = listDateField;

  return (
    <div style={listGroup} data-testid={`${idPrefix}-date-search`}>
      <div style={{ width: 128 }}>
        <ClickSelect value={draft.basis} onChange={v => setDraft(d => ({ ...d, basis: v as SaleDateBasis }))} options={BASIS_OPTIONS}
          style={{ width: '100%' }} triggerStyle={listSelectTrigger} aria-label="날짜 검색 기준" data-testid={`${idPrefix}-date-basis`} />
      </div>
      <DateField value={draft.from} onChange={v => setDraft(d => ({ ...d, from: v }))} style={field}
        placeholder="시작일" ariaLabel="날짜 검색 시작일" testid={`${idPrefix}-date-from`} />
      <span style={{ color: '#9ca3af', fontSize: 13 }}>~</span>
      <DateField value={draft.to} onChange={v => setDraft(d => ({ ...d, to: v }))} style={field}
        placeholder="종료일" ariaLabel="날짜 검색 종료일" testid={`${idPrefix}-date-to`} />
      <button type="button" style={listBtnPrimary(disabled)} disabled={disabled} onClick={() => onApply(draft)}
        data-testid={`${idPrefix}-date-apply`} aria-label="날짜 검색">검색</button>
      {!hideReset && (
        <button type="button" style={listBtnGray(disabled)} disabled={disabled} onClick={() => { setDraft(EMPTY_SALE_PERIOD); onApply(EMPTY_SALE_PERIOD); }}
          data-testid={`${idPrefix}-date-reset`} aria-label="날짜 검색 초기화">초기화</button>
      )}
    </div>
  );
}
