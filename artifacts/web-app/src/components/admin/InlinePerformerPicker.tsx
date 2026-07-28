// ─────────────────────────────────────────────────────────────────────────────
// 수행자·업체 인라인 검색선택 (수정모드 컬럼용, §5·§6·§11).
//  · 개인 → 통번역사 검색 / 외주업체 → 업체 검색 / 경비 → 지급대상 직접입력(선택).
//  · 검색결과 드롭다운은 portal 로 렌더 → 테이블 overflow 에 잘리지 않음(z-index 9600).
//  · 선택 후 성명만 간결 표시(말줄임 + title 로 전체 확인).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useRef, useState, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { C, TYPO, dsInputStd } from '../../lib/ds';
import { Row, VENDOR_TYPE_LABEL } from './performanceShared';

interface Props {
  r: Row; i: number;
  searchIdx: number | null;
  searchResults: any[];
  onSearchTranslator: (i: number, q: string) => void;
  onSearchVendor: (i: number, q: string) => void;
  onPickTranslator: (i: number, result: any) => void;
  onPickVendor: (i: number, result: any) => void;
  onClear: (i: number) => void;
  patch: (p: Partial<Row>) => void;
}

const inp: React.CSSProperties = { ...dsInputStd(), fontSize: 12, minHeight: 30, padding: '4px 8px', width: '100%' };

export default function InlinePerformerPicker(props: Props) {
  const { r, i, searchIdx, searchResults, onSearchTranslator, onSearchVendor, onPickTranslator, onPickVendor, onClear, patch } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const cat = r.performerCategory;
  const open = searchIdx === i && searchResults.length > 0;

  useLayoutEffect(() => {
    if (open && inputRef.current) {
      const b = inputRef.current.getBoundingClientRect();
      setRect({ left: b.left, top: b.bottom + 2, width: Math.max(b.width, 240) });
    } else setRect(null);
  }, [open, searchResults]);

  // 경비 — 지급대상 직접입력(선택), 비활성화하지 않음(§6-3)
  if (cat === 'expense') {
    return (
      <input style={inp} value={r.performerNameSnapshot ?? ''} placeholder="지급대상 선택 또는 직접입력"
        onChange={e => patch({ performerNameSnapshot: e.target.value })}
        data-testid={`perf-payee-${i}`} aria-label="지급대상" />
    );
  }

  // 선택완료 — 성명만 간결 표시
  if (r.performerNameSnapshot) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }} title={r.performerNameSnapshot}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 600 }}>{r.performerNameSnapshot}</span>
        <button type="button" onClick={() => onClear(i)} title="변경" aria-label="수행자 변경"
          style={{ flexShrink: 0, fontSize: 11, lineHeight: 1, padding: '2px 6px', border: `1px solid ${C.g300}`, borderRadius: 4, background: C.bgCard, color: C.textMuted, cursor: 'pointer' }}>변경</button>
      </div>
    );
  }

  const isVendor = cat === 'vendor';
  // 구분값에 맞춘 검색 placeholder(§7) — 예: 장비업체 검색 / 번역업체 검색 / 외주업체 검색 / 통번역사 검색
  const placeholder = isVendor ? `${r.lineCategory || '외주업체'} 검색` : '통번역사 검색';
  const onSearch = (q: string) => (isVendor ? onSearchVendor(i, q) : onSearchTranslator(i, q));
  const onPick = (x: any) => (isVendor ? onPickVendor(i, x) : onPickTranslator(i, x));

  return (
    <>
      <input ref={inputRef} style={inp} placeholder={placeholder}
        onChange={e => onSearch(e.target.value)} onFocus={e => onSearch(e.target.value)}
        data-testid={`perf-inline-search-${i}`} aria-label={placeholder} />
      {open && rect && createPortal(
        <div style={{ position: 'fixed', left: rect.left, top: rect.top, width: rect.width, zIndex: 9600, background: C.bgCard, border: `1px solid ${C.g200}`, borderRadius: 8, boxShadow: '0 4px 14px rgba(0,0,0,0.12)', maxHeight: 260, overflowY: 'auto' }}>
          {searchResults.map((x: any) => (
            <button key={x.id} type="button" onMouseDown={e => { e.preventDefault(); onPick(x); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', border: 'none', borderBottom: `1px solid ${C.g100}`, background: 'transparent', cursor: 'pointer' }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{x.name || x.email}</div>
              <div style={{ ...TYPO.helper }}>
                {isVendor
                  ? `${VENDOR_TYPE_LABEL[x.vendorType] ?? x.vendorType ?? '외주'}${x.businessNumber ? ` · ${x.businessNumber}` : ''}${x.representativeName ? ` · ${x.representativeName}` : ''}`
                  : `${x.languagePairs || ''}${x.specializations ? ` · ${x.specializations}` : ''}${x.region ? ` · ${x.region}` : ''}`}
              </div>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
