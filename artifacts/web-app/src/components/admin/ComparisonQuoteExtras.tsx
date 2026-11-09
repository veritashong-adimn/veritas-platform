/**
 * ComparisonQuoteExtras — 비교견적 작성 화면 보조 섹션(v2).
 *  · IssueTypeSelector  발행 구분(실제 업체 견적 / 내부 비교용) — 자동 확정 없음
 *  · TermsEditor        견적 조건 7개 항목 — 입력된 항목만 PDF 출력, 기본 문구 없음
 *  · BrandingPanel      업체 로고·직인(실제 등록 이미지만) + 업체별 디자인 설정
 */
import React, { useRef } from 'react';
import { COMPARISON_TERM_FIELDS, DEFAULT_COMPARISON_DOC_TITLE, type ComparisonTerms, type ComparisonIssueType } from '../../lib/comparisonQuotePdf';

const lbl: React.CSSProperties = { fontSize: 11, color: '#6b7280', fontWeight: 600, display: 'block', marginBottom: 3 };
const inp: React.CSSProperties = { width: '100%', boxSizing: 'border-box', border: '1px solid #d1d5db', borderRadius: 7, padding: '7px 10px', fontSize: 12.5, background: '#fff', fontFamily: 'inherit' };
const secTitle: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8 };
const btn = (bg: string, color: string, border = 'transparent'): React.CSSProperties => ({ padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: `1px solid ${border}`, background: bg, color });

// ── 발행 구분 ────────────────────────────────────────────────────────────────
export function IssueTypeSelector({ value, onChange, legacyUnset }: { value: ComparisonIssueType | ''; onChange: (v: ComparisonIssueType) => void; legacyUnset: boolean }) {
  const opts: Array<{ v: ComparisonIssueType; title: string; desc: string; color: string; bg: string }> = [
    { v: 'vendor_confirmed', title: '실제 업체 견적', desc: '업체가 제공·확인한 정보/금액/조건. 등록된 로고·직인만 출력', color: '#166534', bg: '#f0fdf4' },
    { v: 'internal_simulation', title: '내부 비교용 시뮬레이션', desc: '내부 가격 비교·검토용. PDF에 "내부 비교용" 표시, 로고·직인 미출력', color: '#92400e', bg: '#fffbeb' },
  ];
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={secTitle}>발행 구분 <span style={{ color: '#dc2626' }}>*</span></div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }} role="radiogroup" aria-label="비교견적 발행 구분">
        {opts.map((o) => {
          const on = value === o.v;
          return (
            <button key={o.v} type="button" role="radio" aria-checked={on} aria-label={o.title} data-testid={`cq-issue-${o.v}`}
              onClick={() => onChange(o.v)}
              style={{ textAlign: 'left', cursor: 'pointer', borderRadius: 8, padding: '9px 12px', border: `1.5px solid ${on ? o.color : '#e5e7eb'}`, background: on ? o.bg : '#fff' }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: on ? o.color : '#374151' }}>{on ? '● ' : '○ '}{o.title}</div>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{o.desc}</div>
            </button>
          );
        })}
      </div>
      {legacyUnset && value === '' && (
        <div data-testid="cq-issue-unset-note" style={{ marginTop: 6, fontSize: 11.5, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '6px 10px' }}>
          기존 비교견적으로 발행 구분이 지정되지 않았습니다. 현재는 <b>내부 비교용</b>으로 표시·출력됩니다. (저장값은 변경하지 않으며, 직접 선택한 경우에만 반영)
        </div>
      )}
    </div>
  );
}

// ── 견적 조건 ────────────────────────────────────────────────────────────────
export function TermsEditor({ terms, onChange }: { terms: ComparisonTerms; onChange: (t: ComparisonTerms) => void }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={secTitle}>견적 조건 <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>(업체가 제시·확인한 내용만 입력 · 입력한 항목만 PDF에 표시)</span></div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {COMPARISON_TERM_FIELDS.map((f) => (
          <div key={f.key} style={f.key === 'otherNotes' || f.key === 'scope' ? { gridColumn: '1 / 3' } : undefined}>
            <label style={lbl} htmlFor={`cq-term-${f.key}`}>{f.label}</label>
            <textarea id={`cq-term-${f.key}`} rows={f.key === 'otherNotes' ? 2 : 1} value={terms[f.key] ?? ''} placeholder={f.placeholder}
              onChange={(e) => onChange({ ...terms, [f.key]: e.target.value })}
              aria-label={f.label} data-testid={`cq-term-${f.key}`} style={{ ...inp, resize: 'vertical' }} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── 로고·직인·디자인 ─────────────────────────────────────────────────────────
export type ImgAction = 'keep' | 'clear' | 'vendor';
export interface ImgState { action: ImgAction; preview: string | null }
const ACCENTS = ['#0f766e', '#1d4ed8', '#334155', '#7c2d12', '#6d28d9', '#047857'];

export function BrandingPanel(props: {
  vendorSelected: boolean;
  isSimulation: boolean;
  logo: ImgState; stamp: ImgState;
  onRemove: (kind: 'logo' | 'stamp') => void;
  onUpload: (kind: 'logo' | 'stamp', file: File) => void;
  onDeleteFromVendor: (kind: 'logo' | 'stamp') => void;
  busy: boolean;
  design: { accentColor: string; docTitle: string };
  onDesign: (d: { accentColor: string; docTitle: string }) => void;
}) {
  const logoRef = useRef<HTMLInputElement>(null);
  const stampRef = useRef<HTMLInputElement>(null);
  const slot = (kind: 'logo' | 'stamp', title: string, st: ImgState, ref: React.RefObject<HTMLInputElement | null>) => (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
      <div style={{ width: 64, height: 64, flexShrink: 0, border: '1px dashed #d1d5db', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fafafa' }}>
        {st.preview ? <img src={st.preview} alt={title} style={{ maxWidth: 60, maxHeight: 60, objectFit: 'contain' }} /> : <span style={{ fontSize: 10.5, color: '#9ca3af' }}>없음</span>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>{title}</div>
        <div style={{ fontSize: 10.5, color: '#9ca3af', margin: '2px 0 6px' }}>
          {st.preview ? (props.isSimulation ? '내부 비교용은 PDF에 출력하지 않음' : 'PDF에 출력됨') : '등록된 이미지가 없으면 출력하지 않습니다'}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <input ref={ref} type="file" accept="image/png,image/jpeg" style={{ display: 'none' }} aria-label={`${title} 파일 선택`} data-testid={`cq-${kind}-file`}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) props.onUpload(kind, f); e.target.value = ''; }} />
          <button type="button" disabled={!props.vendorSelected || props.busy} onClick={() => ref.current?.click()}
            aria-label={`업체 ${title} 등록`} data-testid={`cq-${kind}-upload`}
            title={props.vendorSelected ? '' : '저장된 업체를 선택해야 등록할 수 있습니다'}
            style={{ ...btn('#fff', '#0f766e', '#99f6e4'), opacity: props.vendorSelected ? 1 : 0.5 }}>
            업체에 {st.preview ? '교체' : '등록'}
          </button>
          {st.preview && (
            <button type="button" onClick={() => props.onRemove(kind)} aria-label={`이 견적에서 ${title} 제외`} data-testid={`cq-${kind}-remove`} style={btn('#f9fafb', '#374151', '#d1d5db')}>이 견적에서 제외</button>
          )}
          {props.vendorSelected && st.preview && st.action === 'vendor' && (
            <button type="button" disabled={props.busy} onClick={() => props.onDeleteFromVendor(kind)} aria-label={`업체 ${title} 삭제`} data-testid={`cq-${kind}-vendor-delete`} style={btn('#fef2f2', '#b91c1c', '#fecaca')}>업체에서 삭제</button>
          )}
        </div>
      </div>
    </div>
  );
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={secTitle}>업체 로고 · 직인 / 디자인 <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>(PNG·JPG 2MB 이하 · 실제 업체 이미지만 등록)</span></div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        {slot('logo', '업체 로고', props.logo, logoRef)}
        {slot('stamp', '직인 / 서명', props.stamp, stampRef)}
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <span style={lbl}>견적서 강조색</span>
          <div style={{ display: 'flex', gap: 6 }} role="radiogroup" aria-label="견적서 강조색">
            {ACCENTS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={props.design.accentColor === c} aria-label={`강조색 ${c}`} data-testid={`cq-accent-${c.slice(1)}`}
                onClick={() => props.onDesign({ ...props.design, accentColor: c })}
                style={{ width: 24, height: 24, borderRadius: 999, background: c, cursor: 'pointer', border: props.design.accentColor === c ? '3px solid #fde68a' : '2px solid #fff', boxShadow: '0 0 0 1px #d1d5db' }} />
            ))}
          </div>
        </div>
        <div style={{ width: 180 }}>
          <label style={lbl} htmlFor="cq-doc-title">견적서 제목</label>
          <input id="cq-doc-title" value={props.design.docTitle} onChange={(e) => props.onDesign({ ...props.design, docTitle: e.target.value })}
            placeholder={DEFAULT_COMPARISON_DOC_TITLE} aria-label="견적서 제목" data-testid="cq-doc-title" style={inp} />
        </div>
        <span style={{ fontSize: 11, color: '#9ca3af' }}>디자인은 [선택 업체 갱신] 시 업체별로 저장됩니다</span>
      </div>
    </div>
  );
}
