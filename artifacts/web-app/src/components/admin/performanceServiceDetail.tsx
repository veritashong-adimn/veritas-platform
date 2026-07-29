// ─────────────────────────────────────────────────────────────────────────────
// 서비스 유형별 상세정보 셀(§3~§9·§14·§17) — 연결된 판매상품 유형에 맞는 필드만 한 줄에 표시.
//  · 통역: 기간·시간·인원·장소 / 장비: 사용기간·설치일시·사용일수·장소 / 번역: 언어·분량기준·수량·파일·판매단가.
//  · 편집 가능 필드는 실제 수행 컬럼(performanceStartDate/EndDate·quantity·unit)에 바인딩.
//  · 판매 참조값(saleUnitPrice 등)은 읽기전용 표시 — 계약단가로 복사하지 않음(§10).
//  · 존재하지 않는 값(단어수 등)은 만들지 않고, 실제 스냅샷에 있는 값만 표시.
// ─────────────────────────────────────────────────────────────────────────────
import React from 'react';
import { createPortal } from 'react-dom';
import { C, TYPO, dsInputStd } from '../../lib/ds';
import { ClickSelect } from '../ui';
import { Row, UNIT_OPTS, dateVal, num, won } from './performanceShared';

const mini: React.CSSProperties = { ...dsInputStd(), minHeight: 28, padding: '3px 6px', fontSize: 12 };
const ref: React.CSSProperties = { ...TYPO.helper, color: C.textMuted, whiteSpace: 'nowrap' };
const wrap: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' };

// 수행일수 자동계산(§3) — 시작~종료 포함 일수(2026-07-20~2026-07-22 = 3일). 유효하지 않거나 종료<시작이면 null.
function dayCount(start: string, end: string): number | null {
  const sd = new Date(`${start}T00:00:00Z`).getTime();
  const ed = new Date(`${end}T00:00:00Z`).getTime();
  if (Number.isNaN(sd) || Number.isNaN(ed) || ed < sd) return null;
  return Math.round((ed - sd) / 86400000) + 1;
}

// ── 기간(Date Range) 단일 필드(§1) — 클릭 시 시작·종료를 한 번에 선택하는 포털 팝오버. ──
//  · 표에 가로 오버플로우가 있어 절대배치는 잘리므로 ClickSelect와 동일하게 body 포털 + fixed 배치.
//  · 값은 상위 상태로 즉시 반영(controlled). 계산·저장 로직은 상위(patch)에서 처리.
function DateRangeField({ start, end, onChange, label, placeholder = '기간 선택' }: {
  start?: string | null; end?: string | null;
  onChange: (start: string, end: string) => void;
  label: string; placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const s = dateVal(start), e = dateVal(end);

  const calc = React.useCallback(() => {
    const el = btnRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: r.left, top: r.bottom + 4 });
  }, []);
  React.useLayoutEffect(() => { if (open) calc(); else setPos(null); }, [open, calc]);
  React.useEffect(() => {
    if (!open) return;
    const reposition = () => calc();
    const onDown = (ev: MouseEvent) => {
      if (btnRef.current?.contains(ev.target as Node)) return;
      if (panelRef.current?.contains(ev.target as Node)) return;
      setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setOpen(false); };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, calc]);

  const trig: React.CSSProperties = { ...mini, width: 190, textAlign: 'left', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, background: C.bgCard };
  const fieldLbl: React.CSSProperties = { ...TYPO.helper, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, whiteSpace: 'nowrap' };
  return (
    <>
      <button type="button" ref={btnRef} aria-label={label} data-testid="perf-daterange"
        onClick={() => setOpen(o => !o)} style={trig} title={label}>
        <span style={{ color: (s || e) ? C.textPrimary : C.textMuted, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {s || e ? `${s || '____-__-__'} ~ ${e || '____-__-__'}` : placeholder}
        </span>
        <span aria-hidden style={{ color: C.textMuted, fontSize: 11 }}>▾</span>
      </button>
      {open && pos && createPortal(
        <div ref={panelRef} role="dialog" aria-label={`${label} 선택`}
          style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 9500, background: C.bgCard, border: `1px solid ${C.g200}`, borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.15)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 230 }}>
          <label style={fieldLbl}>시작일
            <input type="date" style={{ ...mini, width: 150 }} value={s} max={e || undefined}
              onChange={ev => onChange(ev.target.value, e)} aria-label={`${label} 시작일`} data-testid="perf-daterange-start" />
          </label>
          <label style={fieldLbl}>종료일
            <input type="date" style={{ ...mini, width: 150 }} value={e} min={s || undefined}
              onChange={ev => onChange(s, ev.target.value)} aria-label={`${label} 종료일`} data-testid="perf-daterange-end" />
          </label>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setOpen(false)} aria-label="기간 선택 완료" data-testid="perf-daterange-done"
              style={{ fontSize: 12, padding: '4px 12px', border: `1px solid ${C.g300}`, borderRadius: 6, background: C.bgCard, cursor: 'pointer' }}>확인</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

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

// 판매 계산식(조회 전용) — "{수량}{단위} × {단가}원 = {공급가액}원".
//   공급가액은 저장값(saleSupplyAmount)을 그대로 표시(화면 재계산 금지). 저장값 없으면 "= …원" 생략.
function saleCalc(snap: any): string {
  const q = snap.saleQuantity, u = snap.saleUnit, p = snap.saleUnitPrice, amt = snap.saleSupplyAmount;
  if (p == null) return '';
  const qty = q != null ? `${num(q).toLocaleString()}${u ? u : ''} × ` : '';
  const eq = amt != null ? ` = ${won(amt)}원` : '';
  return `${qty}${won(p)}원${eq}`;
}

// 번역 상세정보 계산식(조회·수정 공통) — "{파일명} · {수량}{단위} × {단가}원 = {공급가액}원".
//   판매정보가 없으면 실제 수량만 폴백. 내부값(id·languagePair)·"판매" 문구는 표시하지 않음.
function translationText(r: Row, snap: any): string {
  const calc = saleCalc(snap);
  const qtyOnly = r.quantity != null && r.quantity !== '' ? `${num(r.quantity).toLocaleString()}${r.unit ?? ''}` : '';
  return joinRef([snap.fileName, calc || qtyOnly]);
}

interface Props { r: Row; editable: boolean; patch: (p: Partial<Row>) => void; onEndDateChange?: (v: string) => void; }

export default function ServiceDetailCell({ r, editable, patch, onEndDateChange }: Props) {
  const snap = (r.serviceDetailSnapshot ?? {}) as any;
  const kind = svcKind(r);
  // 종료일 변경은 납품일 자동연동 처리(§8)를 거친다 — onEndDateChange 우선.
  const endOn = (v: string) => (onEndDateChange ? onEndDateChange(v) : patch({ performanceEndDate: v }));
  // 기간 변경 처리(§1·§3·§4) — 시작/종료는 각 필드로 저장(종료는 납품일 연동 endOn 경유), 기간 변경 시 수행일수 1회 자동계산.
  //   수행일수(quantity)와 기간은 독립 저장: 여기서만 자동계산하고, 이후 수량 직접수정은 이 경로를 타지 않아 날짜를 건드리지 않음(§4).
  //   장비는 수량이 세트수 의미이므로 자동계산 대상에서 제외(§5 기존 장비 입력 구조 유지).
  const onRangeChange = (start: string, end: string) => {
    const p: Partial<Row> = {};
    if (start !== dateVal(r.performanceStartDate)) p.performanceStartDate = start;
    if (start && end && kind !== 'equipment') {
      const d = dayCount(start, end);
      if (d != null) p.quantity = d;
    }
    if (Object.keys(p).length) patch(p);
    if (end !== dateVal(r.performanceEndDate)) endOn(end);
  };
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
      // 판매정보의 실제 수량·단위 추가(예: 3일) — 저장값 그대로, 재계산 안 함.
      const saleQU = snap.saleQuantity != null ? `${num(snap.saleQuantity).toLocaleString()}${snap.saleUnit ?? ''}` : '';
      text = joinRef([period, snap.operationHours, snap.interpretDuration, snap.interpreterCount ? `${snap.interpreterCount}명` : '', snap.interpretPlace, saleQU]);
    } else if (kind === 'equipment') {
      // 장비 저장 quantity = 사용일수 × 세트수(quoteItemForm 규약) → 사용일수로 나눠 순수 세트수 복원(판매정보 표시와 동일).
      //   사용일수(usagePeriod)를 수량으로 오용하지 않는다.
      const usageDays = Math.max(1, num(snap.usagePeriod) || 1);
      const rawQ = snap.saleQuantity != null ? num(snap.saleQuantity) : (r.quantity != null && r.quantity !== '' ? num(r.quantity) : null);
      const setQty = rawQ != null ? `${(rawQ / usageDays).toLocaleString()}${snap.saleUnit ?? r.unit ?? ''}` : '';
      text = joinRef([period, snap.operationHours ? `설치 ${snap.operationHours}` : '', snap.usagePeriod ? `${snap.usagePeriod}일` : '', snap.itemLocation, setQty]);
    } else if (kind === 'translation') {
      text = translationText(r, snap);
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
        <DateRangeField start={r.performanceStartDate} end={r.performanceEndDate} onChange={onRangeChange} label="수행기간" />
        {qtyUnit}
        <span style={ref}>{joinRef([snap.operationHours, snap.interpretDuration, snap.interpreterCount ? `${snap.interpreterCount}명` : '', snap.interpretPlace])}</span>
      </div>
    );
  }
  if (kind === 'equipment') {
    return (
      <div style={wrap}>
        <DateRangeField start={r.performanceStartDate} end={r.performanceEndDate} onChange={onRangeChange} label="사용기간" />
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
        <span style={ref}>{translationText(r, snap)}</span>
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
      <DateRangeField start={r.performanceStartDate} end={r.performanceEndDate} onChange={onRangeChange} label="수행기간" />
      {qtyUnit}
    </div>
  );
}
