// ─────────────────────────────────────────────────────────────────────────────
// 서비스 유형별 상세정보 셀(§3~§9·§14·§17) — 연결된 판매상품 유형에 맞는 필드만 한 줄에 표시.
//  · 통역: 기간·시간·인원·장소 / 장비: 사용기간·설치일시·사용일수·장소 / 번역: 언어·분량기준·수량·파일·판매단가.
//  · 편집 가능 필드는 실제 수행 컬럼(performanceStartDate/EndDate·quantity·unit)에 바인딩.
//  · 판매 참조값(saleUnitPrice 등)은 읽기전용 표시 — 계약단가로 복사하지 않음(§10).
//  · 존재하지 않는 값(단어수 등)은 만들지 않고, 실제 스냅샷에 있는 값만 표시.
// ─────────────────────────────────────────────────────────────────────────────
import React from 'react';
import { C, TYPO, dsInputStd } from '../../lib/ds';
import { ClickSelect } from '../ui';
import { Row, UNIT_OPTS, dateVal, num, won } from './performanceShared';

const mini: React.CSSProperties = { ...dsInputStd(), minHeight: 28, padding: '3px 6px', fontSize: 12 };
const ref: React.CSSProperties = { ...TYPO.helper, color: C.textMuted, whiteSpace: 'nowrap' };
const wrap: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' };

export type SvcKind = 'interpretation' | 'equipment' | 'translation' | 'expense' | 'generic';

// 서비스 유형 판별(§3) — serviceType(판매 item_type) → canonicalKey → productType 순.
export function svcKind(r: Row): SvcKind {
  const snap = (r.serviceDetailSnapshot ?? {}) as any;
  const t = String(r.serviceType || snap.itemType || '').toLowerCase();
  const ck = String(snap.canonicalKey || '').toLowerCase();
  const pt = String(snap.productType || '').toLowerCase();
  if (/interpret|통역/.test(t) || ck.startsWith('in:') || ck.startsWith('co:') || /interpret/.test(pt)) return 'interpretation';
  if (/equip|장비/.test(t) || ck.startsWith('eq:') || /equip/.test(pt)) return 'equipment';
  if (/translat|번역|proofread|감수|교정|dtp|media|영상|미디어|subtitle|자막/.test(t) || ck.startsWith('tr:') || ck.startsWith('dt:') || /translat/.test(pt)) return 'translation';
  if (r.performerCategory === 'expense') return 'expense';
  return 'generic';
}

const joinRef = (parts: (string | number | null | undefined)[]) =>
  parts.filter(v => v != null && v !== '').join(' · ');

// 판매 참조값(§10) — "판매 {수량}{단위} × {단가}원"
function saleRef(snap: any): string {
  const q = snap.saleQuantity, u = snap.saleUnit, p = snap.saleUnitPrice;
  if (p == null) return '';
  const qty = q != null ? `${num(q).toLocaleString()}${u ? u : ''} × ` : '';
  return `판매 ${qty}${won(p)}원`;
}

interface Props { r: Row; editable: boolean; patch: (p: Partial<Row>) => void; onEndDateChange?: (v: string) => void; }

export default function ServiceDetailCell({ r, editable, patch, onEndDateChange }: Props) {
  const snap = (r.serviceDetailSnapshot ?? {}) as any;
  const kind = svcKind(r);
  const dateIn = (val: string | null | undefined, on: (v: string) => void, label: string) => (
    <input type="date" style={{ ...mini, width: 130 }} value={dateVal(val)} onChange={e => on(e.target.value)} aria-label={label} />
  );
  // 종료일 변경은 납품일 자동연동 처리(§8)를 거친다 — onEndDateChange 우선.
  const endOn = (v: string) => (onEndDateChange ? onEndDateChange(v) : patch({ performanceEndDate: v }));
  const qtyUnit = (
    <>
      <input type="number" min={0} inputMode="numeric" style={{ ...mini, width: 72, textAlign: 'right' }}
        value={r.quantity == null || r.quantity === '' ? '' : String(r.quantity)} onChange={e => patch({ quantity: e.target.value })} aria-label="수량" placeholder="수량" />
      <div style={{ width: 76 }}><ClickSelect value={r.unit ?? ''} onChange={(v: string) => patch({ unit: v })} triggerStyle={mini} menuStyle={{ fontSize: 12 }} options={UNIT_OPTS} /></div>
    </>
  );

  // ── 조회모드: 컴팩트 텍스트(§17) ──
  if (!editable) {
    const period = joinRef([dateVal(r.performanceStartDate), dateVal(r.performanceEndDate)].filter(Boolean)).replace(' · ', '~');
    let text = '';
    if (kind === 'interpretation') {
      text = joinRef([period, snap.operationHours, snap.interpretDuration, snap.interpreterCount ? `${snap.interpreterCount}명` : '', snap.interpretPlace]);
    } else if (kind === 'equipment') {
      text = joinRef([period, snap.operationHours ? `설치 ${snap.operationHours}` : '', snap.usagePeriod ? `${snap.usagePeriod}일` : '', snap.itemLocation, r.quantity != null && r.quantity !== '' ? `${num(r.quantity).toLocaleString()}${r.unit ?? ''}` : '']);
    } else if (kind === 'translation') {
      text = joinRef([snap.fileName, snap.languagePair, r.quantity != null && r.quantity !== '' ? `${num(r.quantity).toLocaleString()}${r.unit ?? ''}` : '', saleRef(snap)]);
    } else if (kind === 'expense') {
      text = joinRef([r.productNameSnapshot, r.quantity != null && r.quantity !== '' ? `${num(r.quantity).toLocaleString()}${r.unit ?? ''}` : '']);
    } else {
      text = joinRef([period, r.quantity != null && r.quantity !== '' ? `${num(r.quantity).toLocaleString()}${r.unit ?? ''}` : '']);
    }
    return <span style={{ ...ref, color: C.textSecondary }} title={text}>{text || '—'}</span>;
  }

  // ── 수정모드: 유형별 입력(§7·§14) — 한 줄 가로 배치 ──
  if (kind === 'interpretation') {
    return (
      <div style={wrap}>
        {dateIn(r.performanceStartDate, v => patch({ performanceStartDate: v }), '수행 시작일')}
        <span style={ref}>~</span>
        {dateIn(r.performanceEndDate, endOn, '수행 종료일')}
        {qtyUnit}
        <span style={ref}>{joinRef([snap.operationHours, snap.interpretDuration, snap.interpreterCount ? `${snap.interpreterCount}명` : '', snap.interpretPlace])}</span>
      </div>
    );
  }
  if (kind === 'equipment') {
    return (
      <div style={wrap}>
        {dateIn(r.performanceStartDate, v => patch({ performanceStartDate: v }), '사용 시작일')}
        <span style={ref}>~</span>
        {dateIn(r.performanceEndDate, endOn, '사용 종료일')}
        {qtyUnit}
        <span style={ref}>{joinRef([snap.operationHours ? `설치 ${snap.operationHours}` : '', snap.usagePeriod ? `${snap.usagePeriod}일` : '', snap.itemLocation])}</span>
      </div>
    );
  }
  if (kind === 'translation') {
    return (
      <div style={wrap}>
        <span style={ref}>분량기준</span>
        {qtyUnit}
        <span style={ref}>{joinRef([snap.fileName, snap.languagePair, saleRef(snap)])}</span>
      </div>
    );
  }
  if (kind === 'expense') {
    return (
      <div style={wrap}>
        {qtyUnit}
        <span style={ref}>금액은 「기본수행료」 셀의 금액상세에서 입력</span>
      </div>
    );
  }
  return (
    <div style={wrap}>
      {dateIn(r.performanceStartDate, v => patch({ performanceStartDate: v }), '시작일')}
      <span style={ref}>~</span>
      {dateIn(r.performanceEndDate, endOn, '종료일')}
      {qtyUnit}
    </div>
  );
}
