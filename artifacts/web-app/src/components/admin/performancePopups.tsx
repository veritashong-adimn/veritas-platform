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
  Row, ExpenseRow, DeductionRow, won, num, dateVal,
  EXPENSE_TYPE_OPTS, DEDUCTION_TYPE_OPTS, EVIDENCE_OPTS, RESIDENCY_OPTS,
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

// 공용 모달 셸 — 배경 클릭·닫기.
export function Modal({ title, onClose, width = 460, children, footer }: { title: string; onClose: () => void; width?: number; children: React.ReactNode; footer?: React.ReactNode }) {
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 9700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onMouseDown={onClose}>
      <div onMouseDown={e => e.stopPropagation()} style={{ background: C.bgCard, borderRadius: 12, padding: 20, width, maxWidth: '92vw', maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 10px 30px rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column', gap: SP[3] }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
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

const smallDelBtn = (on: () => void, label: string, testid: string) => (
  <button type="button" onClick={on} aria-label={label} data-testid={testid}
    style={{ fontSize: 11, padding: '4px 8px', border: `1px solid #fca5a5`, borderRadius: 6, background: '#fff1f2', color: '#b91c1c', cursor: 'pointer', whiteSpace: 'nowrap' }}>삭제</button>
);
const addBtn = (on: () => void, label: string, testid: string) => (
  <button type="button" onClick={on} aria-label={label} data-testid={testid}
    style={{ fontSize: 12, padding: '6px 10px', border: `1px dashed ${C.g300}`, borderRadius: 6, background: C.bgCard, color: C.textSecondary, cursor: 'pointer', alignSelf: 'flex-start' }}>{label}</button>
);

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
            <ClickSelect value={e.expenseType} onChange={(v: string) => patchExpense(idx, { expenseType: v })} triggerStyle={inp} options={EXPENSE_TYPE_OPTS} />
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
        기본수행료 <b>{won(cost.base)}원</b> + 추가비용 <b>{won(cost.expenseTotal)}원</b> − 차감 <b>{won(cost.deductionTotal)}원</b> = 원가합계 <b style={{ color: C.primaryText }}>{won(cost.costTotal)}원</b>
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
        <span style={TYPO.helper}>※ 원천징수 구분·세율은 행에서, 최종은 서버 재계산</span>
      </div>
    </Modal>
  );
}
