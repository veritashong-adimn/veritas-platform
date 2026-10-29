/**
 * 원문서 형태 복수 선택 — 체크박스 메뉴(브라우저 기본 select 아님).
 *
 *  · 열림 상태는 컴포넌트 state 로만 관리한다. 항목을 체크해도 메뉴는 열린 채로 남는다.
 *  · 닫힘: 트리거 재클릭, 메뉴 바깥 클릭(mousedown), ESC.
 *    창 포커스 이동(blur·focusout)으로는 닫지 않는다 — 캡처 도구 실행 중에도 메뉴가 유지된다.
 *  · 값은 "Word, HWP" 처럼 쉼표 구분 문자열로 주고받는다(기존 단일값 "Word" 그대로 호환).
 */
import React, { useEffect, useRef, useState } from 'react';
import { DOCUMENT_TYPES, parseDocumentTypes, formatDocumentTypes } from '../../lib/inquiryMeta';

export function DocumentTypeMultiSelect({ value, onChange, style }: {
  value: string;
  onChange: (v: string) => void;
  style: React.CSSProperties;   // 폼 공통 input 스타일
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const selected = parseDocumentTypes(value);
  // 목록에 없는 기존 저장값도 체크된 항목으로 보여 준다(해제 전까지 보존)
  const options = [...DOCUMENT_TYPES, ...selected.filter(t => !(DOCUMENT_TYPES as readonly string[]).includes(t))];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const toggle = (t: string) => {
    const next = selected.includes(t) ? selected.filter(x => x !== t) : [...selected, t];
    onChange(formatDocumentTypes(next));
  };

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button
        type="button" onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox" aria-expanded={open} aria-label="원문서 형태 선택(복수 선택)" data-testid="inq-docType"
        style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, background: '#fff', cursor: 'pointer', textAlign: 'left' }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: selected.length ? '#111827' : '#9ca3af' }}>
          {selected.length ? formatDocumentTypes(selected) : '선택'}
        </span>
        <span aria-hidden style={{ fontSize: 10, color: '#6b7280' }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div role="listbox" aria-multiselectable="true" aria-label="원문서 형태" data-testid="inq-docType-menu"
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 50, minWidth: '100%', boxSizing: 'border-box',
            background: '#fff', border: '1px solid #d1d5db', borderRadius: 8, boxShadow: '0 6px 18px rgba(15,23,42,0.12)', padding: 4,
          }}>
          {options.map(t => {
            const on = selected.includes(t);
            return (
              <label key={t} role="option" aria-selected={on}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', fontSize: 13, borderRadius: 6, cursor: 'pointer', background: on ? '#eff6ff' : 'transparent', color: '#111827' }}>
                <input type="checkbox" checked={on} onChange={() => toggle(t)}
                  data-testid={`inq-docType-opt-${t}`} aria-label={`원문서 형태 ${t}`} style={{ width: 15, height: 15, margin: 0 }} />
                {t}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
