// ─────────────────────────────────────────────────────────────────────────────
// 행 제어 (공용) — 판매정보·수행정보 공용 UI. 순수 프레젠테이션(동작 로직은 호출측).
//   − 행 삭제 · + 아래 행 삽입 · ▲ 위로 이동 · ▼ 아래로 이동
//
// 판매정보(QuoteEditorWorkspace) 기존 동작 100% 보존:
//   · removeDisabled 미지정 시 total<=1 에서 삭제 비활성화(판매는 최소 1행 유지).
//   · 수행정보는 removeDisabled 로 §7-2 차단조건을, moveDisabled 로 §9 필터상태를 제어.
// ─────────────────────────────────────────────────────────────────────────────
import React from 'react';
import { C, BD } from '../../lib/ds';

export type RowControlsProps = {
  idx: number;
  total: number;
  onRemove: (i: number) => void;
  onAddBelow: (i: number) => void;
  onMoveUp: (i: number) => void;
  onMoveDown: (i: number) => void;
  removeDisabled?: boolean;   // 지정 시 total<=1 대신 이 값으로 삭제 비활성화
  moveDisabled?: boolean;     // ▲▼ 전체 비활성화(필터 적용 등)
  removeTitle?: string;       // 삭제 버튼 tooltip 재정의
  moveTitle?: string;         // ▲▼ 비활성 tooltip
};

export default function RowControls({
  idx, total, onRemove, onAddBelow, onMoveUp, onMoveDown,
  removeDisabled, moveDisabled = false, removeTitle, moveTitle,
}: RowControlsProps) {
  const btn = (dis: boolean): React.CSSProperties => ({
    background: 'none', border: BD.card, borderRadius: 4,
    cursor: dis ? 'default' : 'pointer', fontSize: 11, lineHeight: 1,
    padding: '3px 6px', color: dis ? C.g300 : C.textMuted,
  });
  const hov = (el: HTMLButtonElement, c: string) => { el.style.background = c; };
  const removeOff = removeDisabled !== undefined ? removeDisabled : total <= 1;
  const upOff = moveDisabled || idx === 0;
  const downOff = moveDisabled || idx === total - 1;
  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'center', justifyContent: 'center' }}>
      <button type="button" title={removeTitle ?? '행 삭제'} onClick={() => onRemove(idx)} disabled={removeOff}
        style={{ ...btn(removeOff), color: removeOff ? C.g300 : C.danger, borderColor: removeOff ? C.border : C.dangerBorder }}
        onMouseEnter={e => { if (!removeOff) hov(e.currentTarget, C.dangerBg); }} onMouseLeave={e => hov(e.currentTarget, 'none')}>−</button>
      <button type="button" title="아래 행 추가" onClick={() => onAddBelow(idx)} style={{ ...btn(false), color: C.primary, borderColor: C.primaryBorder }}
        onMouseEnter={e => hov(e.currentTarget, C.primaryBg)} onMouseLeave={e => hov(e.currentTarget, 'none')}>+</button>
      <button type="button" title={upOff ? (moveTitle ?? '위로 이동') : '위로 이동'} onClick={() => onMoveUp(idx)} disabled={upOff} style={btn(upOff)}
        onMouseEnter={e => { if (!upOff) hov(e.currentTarget, C.g100); }} onMouseLeave={e => hov(e.currentTarget, 'none')}>▲</button>
      <button type="button" title={downOff ? (moveTitle ?? '아래로 이동') : '아래로 이동'} onClick={() => onMoveDown(idx)} disabled={downOff} style={btn(downOff)}
        onMouseEnter={e => { if (!downOff) hov(e.currentTarget, C.g100); }} onMouseLeave={e => hov(e.currentTarget, 'none')}>▼</button>
    </div>
  );
}
