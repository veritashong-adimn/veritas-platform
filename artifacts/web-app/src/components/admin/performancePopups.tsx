// ─────────────────────────────────────────────────────────────────────────────
// 수행정보 ERP 한줄 구조용 소형 팝업 (§8·§9 추가비용·차감 / 금액상세).
//  · 행을 펼치지 않고 셀 클릭 시 뜨는 모달에서 다건·금액상세를 편집.
//  · 계산 로직은 변경하지 않음 — 기존 필드에 바인딩만 유지(§15).
// ─────────────────────────────────────────────────────────────────────────────
import React from 'react';
import { createPortal } from 'react-dom';
import { C, TYPO, SP, BD, dsInputStd } from '../../lib/ds';
import { ClickSelect, GhostBtn, PrimaryBtn } from '../ui';
import {
  Row, ExpenseRow, DeductionRow, won, num, commafy, dateVal,
  EXPENSE_TYPE_SELECT_OPTS, CUSTOM_EXPENSE_VALUE, PREDEFINED_EXPENSE_VALUES,
  DEDUCTION_TYPE_OPTS, DEDUCTION_TYPE_SELECT_OPTS, CUSTOM_DEDUCTION_VALUE, PREDEFINED_DEDUCTION_VALUES, EVIDENCE_OPTS, RESIDENCY_OPTS,
  calcVendorPreview, calcIndivPreview, calcRowCostPreview,
} from './performanceShared';

const inp: React.CSSProperties = { ...dsInputStd(), minHeight: 32, padding: '4px 8px', width: '100%' };
const lbl: React.CSSProperties = { ...TYPO.fieldLabel, display: 'block', marginBottom: SP[2] };
const subTitle: React.CSSProperties = { ...TYPO.fieldLabel, fontWeight: 800, color: C.textPrimary };

const numInp = (v: unknown, on: (val: string) => void, testid: string, label: string, disabled?: boolean) => (
  <input type="number" min={0} inputMode="numeric" disabled={disabled} style={{ ...inp, textAlign: 'right', ...(disabled ? { background: C.g50, color: C.textSecondary } : {}) }}
    value={v == null || v === '' ? '' : String(v)} onChange={e => on(e.target.value)}
    data-testid={testid} aria-label={label} />
);
// 금액 입력 — 소수점 없이 천 단위 콤마(입력 중 자동 적용). 저장은 콤마 제거 숫자값.
const moneyInp = (v: unknown, on: (val: string) => void, testid: string, label: string) => (
  <input type="text" inputMode="numeric" style={{ ...inp, textAlign: 'right' }}
    value={commafy(v)} onChange={e => on(e.target.value.replace(/[^\d]/g, ''))}
    data-testid={testid} aria-label={label} />
);

// 공용 모달 셸 — 배경 클릭·닫기.
//  · draggable=true 시 제목(헤더)을 드래그 핸들로 사용해 팝업을 이동(조회 전용 팝업이 표를 가리는 문제 해소).
//    이동은 중앙 기준 오프셋(transform translate)으로만 처리 — 계산·내용은 변경하지 않음. 닫았다 열면 매 마운트마다 중앙으로 초기화.
export function Modal({ title, onClose, width = 460, children, footer, draggable }: { title: string; onClose: () => void; width?: number; children: React.ReactNode; footer?: React.ReactNode; draggable?: boolean }) {
  const cardRef = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ x: number; y: number } | null>(null);   // 중앙 대비 오프셋(px). null=중앙
  const [dragging, setDragging] = React.useState(false);
  const drag = React.useRef<{ sx: number; sy: number; bx: number; by: number } | null>(null);
  // 언마운트(닫기) 시 진행 중이던 리스너 정리 — 재오픈 시 중앙 초기화 보장
  React.useEffect(() => () => { drag.current = null; }, []);

  const onHandleDown = (e: React.MouseEvent) => {
    if (!draggable) return;
    if ((e.target as HTMLElement).closest('button')) return;   // 닫기 X 등 버튼 클릭 시 드래그 시작 안 함
    e.preventDefault();
    const base = pos ?? { x: 0, y: 0 };
    drag.current = { sx: e.clientX, sy: e.clientY, bx: base.x, by: base.y };
    setDragging(true);
    const MARGIN = 48;   // 화면 밖으로 완전히 벗어나지 않도록 최소 노출 폭
    const onMove = (ev: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      let nx = d.bx + (ev.clientX - d.sx);
      let ny = d.by + (ev.clientY - d.sy);
      const el = cardRef.current;
      if (el) {
        const w = el.offsetWidth, h = el.offsetHeight;
        const naturalLeft = (window.innerWidth - w) / 2;
        const naturalTop = (window.innerHeight - h) / 2;
        // 좌우: 팝업 일부(MARGIN)는 항상 화면 안. 상하: 제목이 위로 사라지지 않도록 top>=0 유지
        nx = Math.min(Math.max(nx, -(w - MARGIN) - naturalLeft), window.innerWidth - MARGIN - naturalLeft);
        ny = Math.min(Math.max(ny, -naturalTop), window.innerHeight - MARGIN - naturalTop);
      }
      setPos({ x: nx, y: ny });
    };
    const onUp = () => {
      drag.current = null;
      setDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const headerStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    ...(draggable ? { cursor: dragging ? 'grabbing' : 'grab', userSelect: 'none' } : {}) };

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 9400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onMouseDown={onClose}>
      <div ref={cardRef} onMouseDown={e => e.stopPropagation()} style={{ background: C.bgCard, borderRadius: 12, padding: 20, width, maxWidth: '92vw', maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 10px 30px rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column', gap: SP[3], ...(pos ? { transform: `translate(${pos.x}px, ${pos.y}px)` } : {}) }}>
        <div style={headerStyle} onMouseDown={onHandleDown}>
          <div style={{ ...TYPO.sectionTitle }}>{title}</div>
          <button type="button" onClick={onClose} aria-label="닫기" style={{ border: 'none', background: 'none', fontSize: 18, lineHeight: 1, cursor: 'pointer', color: C.textMuted }}>✕</button>
        </div>
        {children}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: SP[2] }}>
          {footer ?? <PrimaryBtn onClick={onClose} style={{ fontSize: 12, padding: '6px 14px' }} aria-label="확인">확인</PrimaryBtn>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// 삭제 버튼 — 텍스트 대신 X 아이콘만(폭 최소화). 높이는 유지, justifySelf로 그리드 셀 늘어남 방지. aria-label은 유지(접근성).
const smallDelBtn = (on: () => void, label: string, testid: string) => (
  <button type="button" onClick={on} aria-label={label} data-testid={testid}
    style={{ fontSize: 11, padding: '4px 8px', border: `1px solid #fca5a5`, borderRadius: 6, background: '#fff1f2', color: '#b91c1c', cursor: 'pointer', whiteSpace: 'nowrap', justifySelf: 'start' }}>✕</button>
);
const addBtn = (on: () => void, label: string, testid: string) => (
  <button type="button" onClick={on} aria-label={label} data-testid={testid}
    style={{ fontSize: 12, padding: '6px 10px', border: `1px dashed ${C.g300}`, borderRadius: 6, background: C.bgCard, color: C.textSecondary, cursor: 'pointer', alignSelf: 'flex-start' }}>{label}</button>
);

// ── 추가비용 항목 선택 (공용) — 목록 선택 + '직접입력' 자유 항목명 입력 ──────────
//  · value 가 사전 정의값이 아니면(빈값 제외) 직접입력으로 간주해 텍스트 입력창 표시(저장된 사용자 항목명 그대로 노출).
//  · 목록에서 '직접입력' 선택 시 텍스트 입력창으로 전환, ▾ 버튼으로 목록 선택으로 복귀. 저장·계산 로직은 변경 없음.
function ExpenseTypeField({ value, onChange, triggerStyle, testid }: { value: string; onChange: (v: string) => void; triggerStyle: React.CSSProperties; testid: string }) {
  const derivedCustom = !!value && !PREDEFINED_EXPENSE_VALUES.has(value);
  const [manualCustom, setManualCustom] = React.useState(false);
  // 값이 사전 정의값으로 바뀌면(예: 행 삭제로 인한 재사용) 수동 직접입력 플래그 해제
  React.useEffect(() => { if (value && PREDEFINED_EXPENSE_VALUES.has(value)) setManualCustom(false); }, [value]);
  const custom = derivedCustom || manualCustom;
  if (custom) {
    return (
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input type="text" style={{ ...triggerStyle, flex: 1, minWidth: 0 }} value={value} autoFocus={manualCustom}
          onChange={e => onChange(e.target.value)} placeholder="항목명 직접입력"
          data-testid={`${testid}-custom`} aria-label="추가비용 항목명 직접입력" />
        <button type="button" aria-label="목록에서 선택" title="목록에서 선택"
          onClick={() => { setManualCustom(false); onChange(''); }}
          style={{ flexShrink: 0, border: `1px solid ${C.g300}`, borderRadius: 6, background: C.bgCard, color: C.textSecondary, cursor: 'pointer', padding: '4px 7px', fontSize: 11, lineHeight: 1 }}>▾</button>
      </div>
    );
  }
  return (
    <ClickSelect value={value} triggerStyle={triggerStyle} options={EXPENSE_TYPE_SELECT_OPTS}
      onChange={(v: string) => { if (v === CUSTOM_EXPENSE_VALUE) { setManualCustom(true); onChange(''); } else onChange(v); }} />
  );
}

// ── 차감항목 선택 (공용) — 추가항목(ExpenseTypeField)과 동일 UX: 목록 선택 + '직접입력' 자유 항목명 입력 ──
//  · value 가 사전 정의값이 아니면(빈값 제외) 직접입력으로 간주해 텍스트 입력창 표시(저장된 사용자 항목명 그대로 노출).
//  · '직접입력' 선택 시 첫 칸이 텍스트 입력으로 전환, ▾ 로 목록 복귀. 저장은 deductionType 문자열 그대로(별도 사유칸 없음).
function DeductionTypeField({ value, onChange, triggerStyle, testid }: { value: string; onChange: (v: string) => void; triggerStyle: React.CSSProperties; testid: string }) {
  const derivedCustom = !!value && !PREDEFINED_DEDUCTION_VALUES.has(value);
  const [manualCustom, setManualCustom] = React.useState(false);
  React.useEffect(() => { if (value && PREDEFINED_DEDUCTION_VALUES.has(value)) setManualCustom(false); }, [value]);
  const custom = derivedCustom || manualCustom;
  if (custom) {
    return (
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input type="text" style={{ ...triggerStyle, flex: 1, minWidth: 0 }} value={value} autoFocus={manualCustom}
          onChange={e => onChange(e.target.value)} placeholder="항목명 직접입력"
          data-testid={`${testid}-custom`} aria-label="차감항목명 직접입력" />
        <button type="button" aria-label="목록에서 선택" title="목록에서 선택"
          onClick={() => { setManualCustom(false); onChange(''); }}
          style={{ flexShrink: 0, border: `1px solid ${C.g300}`, borderRadius: 6, background: C.bgCard, color: C.textSecondary, cursor: 'pointer', padding: '4px 7px', fontSize: 11, lineHeight: 1 }}>▾</button>
      </div>
    );
  }
  return (
    <ClickSelect value={value} triggerStyle={triggerStyle} options={DEDUCTION_TYPE_SELECT_OPTS}
      onChange={(v: string) => { if (v === CUSTOM_DEDUCTION_VALUE) { setManualCustom(true); onChange(''); } else onChange(v); }} />
  );
}

// ── 추가비용·차감 다건 팝업(§8·§9) ───────────────────────────────────────────
export function SubItemsPopup({ r, patch, onClose, focus }: { r: Row; patch: (p: Partial<Row>) => void; onClose: () => void; focus?: 'expenses' | 'deductions' }) {
  const expenses = r.expenses ?? [];
  const deductions = r.deductions ?? [];
  const cost = calcRowCostPreview(r);
  const setExp = (arr: ExpenseRow[]) => patch({ expenses: arr });
  const setDed = (arr: DeductionRow[]) => patch({ deductions: arr });
  const patchExpense = (idx: number, p: Partial<ExpenseRow>) => setExp(expenses.map((e, i) => i === idx ? { ...e, ...p } : e));
  const patchDeduction = (idx: number, p: Partial<DeductionRow>) => setDed(deductions.map((d, i) => i === idx ? { ...d, ...p } : d));
  return (
    <Modal title={focus === 'deductions' ? '차감 관리' : '추가비용 관리'} onClose={onClose} width={640}>
      {/* 추가비용 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={subTitle}>추가비용 <span style={TYPO.helper}>(지급대상 포함분만 원가 반영)</span></div>
          <span style={{ ...TYPO.inputValue, fontVariantNumeric: 'tabular-nums' }}>합계 <b>{won(cost.expenseTotal)}원</b></span>
        </div>
        {expenses.map((e, idx) => (
          <div key={idx} style={{ display: 'grid', gridTemplateColumns: '130px 120px 130px 92px 1fr auto', gap: SP[2], alignItems: 'center' }}>
            <ExpenseTypeField value={e.expenseType} onChange={(v: string) => patchExpense(idx, { expenseType: v })} triggerStyle={inp} testid={`pop-exp-type-${idx}`} />
            {numInp(e.amount, v => patchExpense(idx, { amount: v }), `pop-exp-amt-${idx}`, '추가비용 금액')}
            <input type="date" style={inp} value={dateVal(e.incurredDate)} onChange={ev => patchExpense(idx, { incurredDate: ev.target.value })} aria-label="발생일" />
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, ...TYPO.helper, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={e.includedInPayout !== false} onChange={ev => patchExpense(idx, { includedInPayout: ev.target.checked })} aria-label="지급대상 포함" /> 지급대상
            </label>
            <input style={inp} value={e.memo ?? ''} onChange={ev => patchExpense(idx, { memo: ev.target.value })} placeholder="비고" aria-label="추가비용 비고" />
            {smallDelBtn(() => setExp(expenses.filter((_, i) => i !== idx)), '추가비용 삭제', `pop-exp-del-${idx}`)}
          </div>
        ))}
        {addBtn(() => setExp([...expenses, { expenseType: '교통비', amount: '', incurredDate: null, includedInPayout: true, memo: '' }]), '+ 추가비용 등록', 'pop-exp-add')}
      </div>
      <div style={{ borderTop: BD.grid, margin: `${SP[2]}px 0` }} />
      {/* 차감 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={subTitle}>차감</div>
          <span style={{ ...TYPO.inputValue, fontVariantNumeric: 'tabular-nums' }}>합계 <b>{won(cost.deductionTotal)}원</b></span>
        </div>
        {deductions.map((d, idx) => (
          <div key={idx} style={{ display: 'grid', gridTemplateColumns: '150px 120px 1fr auto', gap: SP[2], alignItems: 'center' }}>
            <ClickSelect value={d.deductionType} onChange={(v: string) => patchDeduction(idx, { deductionType: v })} triggerStyle={inp} options={DEDUCTION_TYPE_OPTS} />
            {numInp(d.amount, v => patchDeduction(idx, { amount: v }), `pop-ded-amt-${idx}`, '차감 금액')}
            <input style={inp} value={d.reason ?? ''} onChange={ev => patchDeduction(idx, { reason: ev.target.value })} placeholder="차감 사유" aria-label="차감 사유" />
            {smallDelBtn(() => setDed(deductions.filter((_, i) => i !== idx)), '차감 삭제', `pop-ded-del-${idx}`)}
          </div>
        ))}
        {addBtn(() => setDed([...deductions, { deductionType: '선지급금 차감', amount: '', reason: '' }]), '+ 차감 항목 추가', 'pop-ded-add')}
      </div>
      <div style={{ ...TYPO.inputValue, fontVariantNumeric: 'tabular-nums', padding: `${SP[2]}px ${SP[3]}px`, background: C.primaryBg, borderRadius: 8 }}>
        기본수행료 <b>{won(cost.base)}원</b> + 추가비용 <b>{won(cost.expenseTotal)}원</b> − 차감 <b>{won(cost.deductionTotal)}원</b> = 지급액 <b style={{ color: C.primaryText }}>{won(cost.costTotal)}원</b>
      </div>
    </Modal>
  );
}

// ── 조정항목 팝업(§조정) — 기본수행료 외 모든 비용을 추가(+)·차감(-)으로 통합 입력 ──
//  · 조회·수정 화면 공통 컴포넌트(단일 소스). 항목명(label)·Enum·계산·검증·저장 규약을 한 곳에서 관리.
//  · 추가항목은 expenses[](지급대상 포함)로, 차감항목은 deductions[]로 저장 — 기존 DB·원가계산 그대로.
//  · 로컬 초안을 두고 [확인]에서만 커밋, [취소]는 폐기. 제목 영역 드래그로 이동 가능(표 가림 방지).
//  · 표시 규칙: 저장된 항목 중 금액 0원은 노출하지 않음(§0원 숨김) — 신규 입력 행은 그대로 편집 가능.
export function AdjustmentPopup({ r, patch, onClose }: { r: Row; patch: (p: Partial<Row>) => void; onClose: () => void }) {
  const [adds, setAdds] = React.useState<ExpenseRow[]>(() => (r.expenses ?? []).filter(e => Math.round(num(e.amount)) !== 0).map(e => ({ ...e })));
  const [subs, setSubs] = React.useState<DeductionRow[]>(() => (r.deductions ?? []).filter(d => Math.round(num(d.amount)) !== 0).map(d => ({ ...d })));
  const addSum = Math.round(adds.reduce((s, e) => s + num(e.amount), 0));
  const subSum = Math.round(subs.reduce((s, d) => s + num(d.amount), 0));
  const net = addSum - subSum;
  const patchAdd = (i: number, p: Partial<ExpenseRow>) => setAdds(prev => prev.map((e, idx) => idx === i ? { ...e, ...p } : e));
  const patchSub = (i: number, p: Partial<DeductionRow>) => setSubs(prev => prev.map((d, idx) => idx === i ? { ...d, ...p } : d));
  // 추가항목은 항상 지급대상 포함(원가 반영). 기존 부가필드(발생일·비고·증빙)는 보존.
  const confirm = () => { patch({ expenses: adds.map(e => ({ ...e, includedInPayout: true })), deductions: subs }); onClose(); };
  return (
    <Modal title="추가비용" onClose={onClose} width={560} draggable
      footer={<>
        <GhostBtn onClick={onClose} style={{ fontSize: 12, padding: '6px 14px' }} aria-label="취소">취소</GhostBtn>
        <PrimaryBtn onClick={confirm} style={{ fontSize: 12, padding: '6px 14px' }} data-testid="adj-confirm" aria-label="확인">확인</PrimaryBtn>
      </>}>
      {/* 추가항목(+) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
        <div style={subTitle}>추가항목 <span style={TYPO.helper}>(+)</span></div>
        {adds.map((e, idx) => (
          <div key={idx} style={{ display: 'grid', gridTemplateColumns: '160px 140px auto', gap: SP[2], alignItems: 'center' }}>
            <ExpenseTypeField value={e.expenseType} onChange={(v: string) => patchAdd(idx, { expenseType: v })} triggerStyle={inp} testid={`adj-add-type-${idx}`} />
            {moneyInp(e.amount, v => patchAdd(idx, { amount: v }), `adj-add-amt-${idx}`, '추가항목 금액')}
            {smallDelBtn(() => setAdds(adds.filter((_, i) => i !== idx)), '추가항목 삭제', `adj-add-del-${idx}`)}
          </div>
        ))}
        {addBtn(() => setAdds([...adds, { expenseType: '교통비', amount: '', includedInPayout: true }]), '+ 추가항목', 'adj-add')}
      </div>
      <div style={{ borderTop: BD.grid, margin: `${SP[2]}px 0` }} />
      {/* 차감항목(-) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
        <div style={subTitle}>차감항목 <span style={TYPO.helper}>(-)</span></div>
        {subs.map((d, idx) => (
          <div key={idx} style={{ display: 'grid', gridTemplateColumns: '160px 140px auto', gap: SP[2], alignItems: 'center' }}>
            <DeductionTypeField value={d.deductionType} onChange={(v: string) => patchSub(idx, { deductionType: v })} triggerStyle={inp} testid={`adj-sub-type-${idx}`} />
            {moneyInp(d.amount, v => patchSub(idx, { amount: v }), `adj-sub-amt-${idx}`, '차감항목 금액')}
            {smallDelBtn(() => setSubs(subs.filter((_, i) => i !== idx)), '차감항목 삭제', `adj-sub-del-${idx}`)}
          </div>
        ))}
        {addBtn(() => setSubs([...subs, { deductionType: '패널티', amount: '' }]), '+ 차감항목', 'adj-sub')}
      </div>
      {/* 합계 */}
      <div style={{ display: 'flex', gap: SP[6], flexWrap: 'wrap', ...TYPO.inputValue, fontVariantNumeric: 'tabular-nums', padding: `${SP[2]}px ${SP[3]}px`, background: C.primaryBg, borderRadius: 8 }}>
        <span>추가 <b>{won(addSum)}원</b></span>
        <span>차감 <b>{won(subSum)}원</b></span>
        <span>추가비용 합계 <b style={{ color: C.primaryText }} data-testid="adj-total">{won(net)}원</b></span>
      </div>
    </Modal>
  );
}

// ── 금액상세 팝업 — 카테고리별 기본원가 입력(§금액입력 결정) ───────────────────
export function AmountDetailPopup({ r, patch, onClose }: { r: Row; patch: (p: Partial<Row>) => void; onClose: () => void }) {
  const cat = r.performerCategory;
  if (cat === 'vendor') {
    const v = calcVendorPreview(r);
    const vatEditable = r.purchaseEvidenceType === 'other' || r.purchaseEvidenceType === 'none';
    return (
      <Modal title="외주 매입 금액상세" onClose={onClose}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: SP[3] }}>
          <div>
            <label style={lbl}>매입증빙 유형</label>
            <ClickSelect value={r.purchaseEvidenceType ?? ''} onChange={(val: string) => patch({ purchaseEvidenceType: val })} triggerStyle={inp} options={EVIDENCE_OPTS} />
          </div>
          <div>
            <label style={lbl}>발행일</label>
            <input type="date" style={inp} value={dateVal(r.purchaseInvoiceDate)} onChange={e => patch({ purchaseInvoiceDate: e.target.value })} aria-label="매입세금계산서 발행일" />
          </div>
          <div>
            <label style={lbl}>공급가액</label>
            {numInp(r.supplyAmount, val => patch({ supplyAmount: val }), 'pop-supply', '공급가액')}
          </div>
          <div>
            <label style={lbl}>부가세{vatEditable ? '' : ' (자동)'}</label>
            {vatEditable
              ? numInp(r.vatAmount, val => patch({ vatAmount: val }), 'pop-vat', '부가세')
              : <div style={{ ...inp, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', background: C.g50, color: C.textSecondary, fontVariantNumeric: 'tabular-nums' }}>{won(v.vat)}원</div>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: SP[6], flexWrap: 'wrap', ...TYPO.inputValue, fontVariantNumeric: 'tabular-nums' }}>
          <span>공급가액 <b>{won(v.supply)}원</b></span>
          <span>부가세 <b>{won(v.vat)}원</b></span>
          <span>합계 <b style={{ color: C.primaryText }}>{won(v.total)}원</b></span>
          <span style={TYPO.helper}>※ 저장 시 서버가 최종 재계산</span>
        </div>
      </Modal>
    );
  }
  if (cat === 'expense') {
    return (
      <Modal title="경비 금액상세" onClose={onClose} width={360}>
        <div>
          <label style={lbl}>직접금액 (원)</label>
          {numInp(r.directAmount, val => patch({ directAmount: val }), 'pop-direct', '직접금액')}
        </div>
        <div style={TYPO.helper}>경비는 지급대상자 없이 직접 원가로 계상됩니다.</div>
      </Modal>
    );
  }
  // individual
  const preview = calcIndivPreview(r);
  return (
    <Modal title="개인 금액상세 (원천징수 대상 기본료)" onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: SP[3], alignItems: 'end' }}>
        <div>
          <label style={lbl}>거주구분</label>
          <ClickSelect value={r.residencyType ?? ''} onChange={(val: string) => patch({ residencyType: val })} triggerStyle={inp} options={RESIDENCY_OPTS} />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, ...TYPO.helper, cursor: 'pointer', paddingBottom: 8 }}>
          <input type="checkbox" checked={!!r.isDirectAmount} onChange={e => patch({ isDirectAmount: e.target.checked })} aria-label="직접금액 입력" /> 직접금액 입력(계약단가×수량 대신)
        </label>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: SP[3] }}>
        {r.isDirectAmount && (
          <div>
            <label style={lbl}>직접금액</label>
            {numInp(r.directAmount, val => patch({ directAmount: val }), 'pop-idirect', '직접금액')}
          </div>
        )}
        <div>
          <label style={lbl}>수행료 (원천징수 대상)</label>
          {numInp(r.baseFee, val => patch({ baseFee: val }), 'pop-basefee', '수행료')}
        </div>
      </div>
      <div style={{ display: 'flex', gap: SP[6], flexWrap: 'wrap', ...TYPO.inputValue, fontVariantNumeric: 'tabular-nums' }}>
        <span>세전 <b>{won(preview.gross)}원</b></span>
        <span>원천세 <b style={{ color: preview.confirmed ? C.g900 : C.g400 }}>{preview.confirmed ? won(preview.tax) + '원' : '미확정'}</b></span>
        <span>세후 <b style={{ color: C.primaryText }}>{won(preview.net)}원</b></span>
        <span style={TYPO.helper}>※ 세금처리 구분은 행에서 선택, 최종은 서버 재계산</span>
      </div>
    </Modal>
  );
}
