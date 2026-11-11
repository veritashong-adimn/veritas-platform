/**
 * DocPreviewWindow — 문서 미리보기 공통 팝업창(견적서·거래명세서)
 *
 * - 최초 화면 중앙, 제목 표시줄 드래그로 이동, 테두리·모서리 드래그로 크기 조절.
 * - 최대 높이는 화면 높이 기준, 문서가 길면 팝업 내부(본문 영역)에서 스크롤.
 * - 우측 상단 닫기(X), ESC 닫기, 바깥(어두운 배경) 클릭 닫기(드래그 중 바깥에서 놓은 경우는 닫지 않음).
 * - 위치·크기는 컴포넌트 상태로만 관리(저장하지 않음). 모바일(좁은 화면)은 전체 화면 고정.
 * - 문서 본문(children)은 그대로 렌더한다 — 인쇄/PDF 는 각 모달이 본문 ref 의 innerHTML 로 별도 창에서 처리.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';

type Rect = { x: number; y: number; w: number; h: number };
type Dir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const MARGIN = 16;            // 화면 가장자리 여백
const MIN_W = 360;
const MIN_H = 240;
const PREF_W = 900;           // A4(794) + 좌우 여백 + 스크롤바
const MOBILE_BP = 640;
const TITLE_H = 52;           // 제목 표시줄 최소 높이

const vw = () => window.innerWidth;
const vh = () => window.innerHeight;

function initialRect(): Rect {
  // 최대 높이 = 화면 높이 기준(위아래 여백), 처음에는 그보다 약간 작게 열어 이동할 여유를 둔다
  const w = Math.min(PREF_W, vw() - MARGIN * 2);
  const h = Math.max(MIN_H, Math.round((vh() - MARGIN * 2) * 0.9));
  return clampRect({ x: Math.round((vw() - w) / 2), y: Math.round((vh() - h) / 2), w, h });
}

// 팝업 전체(테두리·크기 조절 핸들 포함)가 항상 화면 안에 있도록 크기·위치 보정
function clampRect(r: Rect): Rect {
  const w = Math.max(Math.min(MIN_W, vw()), Math.min(r.w, vw() - MARGIN * 2));
  const h = Math.max(Math.min(MIN_H, vh()), Math.min(r.h, vh() - MARGIN * 2));
  const x = Math.min(Math.max(r.x, 0), Math.max(0, vw() - w));
  const y = Math.min(Math.max(r.y, 0), Math.max(0, vh() - h));
  return { x, y, w, h };
}

const HANDLES: { dir: Dir; style: React.CSSProperties; cursor: string }[] = [
  { dir: 'n',  cursor: 'ns-resize',   style: { top: 0, left: 12, right: 12, height: 8 } },
  { dir: 's',  cursor: 'ns-resize',   style: { bottom: 0, left: 12, right: 12, height: 8 } },
  { dir: 'e',  cursor: 'ew-resize',   style: { right: 0, top: 12, bottom: 12, width: 8 } },
  { dir: 'w',  cursor: 'ew-resize',   style: { left: 0, top: 12, bottom: 12, width: 8 } },
  { dir: 'ne', cursor: 'nesw-resize', style: { top: 0, right: 0, width: 16, height: 16 } },
  { dir: 'nw', cursor: 'nwse-resize', style: { top: 0, left: 0, width: 16, height: 16 } },
  { dir: 'se', cursor: 'nwse-resize', style: { bottom: 0, right: 0, width: 16, height: 16 } },
  { dir: 'sw', cursor: 'nesw-resize', style: { bottom: 0, left: 0, width: 16, height: 16 } },
];

export interface DocPreviewWindowProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** 제목 표시줄 오른쪽 동작 버튼(인쇄 등) — 닫기(X) 앞에 표시 */
  actions?: React.ReactNode;
  onClose: () => void;
  /** data-testid 접두어(예: 'quote-preview') */
  testIdPrefix: string;
  /** 닫기 버튼 data-testid — 기존 테스트 식별자 유지용 */
  closeTestId?: string;
  ariaLabel: string;
  children: React.ReactNode;
}

export function DocPreviewWindow({ title, subtitle, actions, onClose, testIdPrefix, closeTestId, ariaLabel, children }: DocPreviewWindowProps) {
  const [rect, setRect] = useState<Rect>(initialRect);
  const [mobile, setMobile] = useState(() => vw() < MOBILE_BP);
  const [busy, setBusy] = useState(false);              // 이동·크기 조절 중(텍스트 선택 방지)
  const drag = useRef<{ mode: 'move' | Dir; sx: number; sy: number; start: Rect } | null>(null);
  const downOnBackdrop = useRef(false);

  // ESC 닫기
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  // 브라우저 창 크기 변경 — 팝업이 화면 밖으로 나가지 않게 보정, 모바일 전환
  useEffect(() => {
    const h = () => { setMobile(vw() < MOBILE_BP); setRect(r => clampRect(r)); };
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy, s = d.start;
    if (d.mode === 'move') { setRect(clampRect({ ...s, x: s.x + dx, y: s.y + dy })); return; }
    let { x, y, w, h } = s;
    // 크기 조절 — 최소 크기 유지, 화면 밖으로 넘지 않게(반대편 테두리는 고정)
    if (d.mode.includes('e')) w = Math.min(Math.max(MIN_W, s.w + dx), vw() - s.x);
    if (d.mode.includes('s')) h = Math.min(Math.max(MIN_H, s.h + dy), vh() - s.y);
    if (d.mode.includes('w')) { w = Math.min(Math.max(MIN_W, s.w - dx), s.x + s.w); x = s.x + s.w - w; }
    if (d.mode.includes('n')) { h = Math.min(Math.max(MIN_H, s.h - dy), s.y + s.h); y = s.y + s.h - h; }
    setRect({ x, y, w, h });
  }, []);

  const endDrag = useCallback(() => {
    drag.current = null; setBusy(false);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
  }, [onPointerMove]);
  useEffect(() => endDrag, [endDrag]);

  const startDrag = (mode: 'move' | Dir) => (e: React.PointerEvent) => {
    if (mobile || e.button !== 0) return;
    // 제목 표시줄의 버튼(인쇄·닫기) 클릭은 이동으로 처리하지 않음
    if (mode === 'move' && (e.target as HTMLElement).closest('button, a, input, select')) return;
    e.preventDefault(); e.stopPropagation();
    drag.current = { mode, sx: e.clientX, sy: e.clientY, start: rect };
    setBusy(true);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  };

  const box: React.CSSProperties = mobile
    ? { position: 'fixed', inset: 0, width: '100%', height: '100%', borderRadius: 0 }
    : { position: 'fixed', left: rect.x, top: rect.y, width: rect.w, height: rect.h, borderRadius: 10 };

  return (
    <div
      data-testid={`${testIdPrefix}-backdrop`}
      style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(15,23,42,0.6)', userSelect: busy ? 'none' : undefined, cursor: busy && drag.current?.mode === 'move' ? 'move' : undefined }}
      onPointerDown={e => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={e => { if (e.target === e.currentTarget && downOnBackdrop.current) onClose(); downOnBackdrop.current = false; }}
    >
      <div
        role="dialog" aria-modal="true" aria-label={ariaLabel}
        data-testid={`${testIdPrefix}-window`}
        style={{ ...box, display: 'flex', flexDirection: 'column', background: '#e2e8f0', boxShadow: '0 24px 64px rgba(0,0,0,0.45)', overflow: 'hidden' }}
      >
        {/* 제목 표시줄 — 드래그로 이동 */}
        <div
          onPointerDown={startDrag('move')}
          data-testid={`${testIdPrefix}-titlebar`}
          style={{
            flexShrink: 0, background: '#1e293b', padding: '10px 12px 10px 20px', minHeight: TITLE_H, boxSizing: 'border-box',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            cursor: mobile ? 'default' : 'move', touchAction: 'none',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, overflow: 'hidden' }}>
            <span style={{ color: '#fff', fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap' }}>{title}</span>
            {subtitle && <span style={{ color: '#94a3b8', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subtitle}</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {actions}
            <button type="button" onClick={onClose}
              data-testid={closeTestId ?? `${testIdPrefix}-close`} aria-label="미리보기 닫기" title="닫기 (ESC)"
              style={{ width: 34, height: 34, borderRadius: 7, border: '1px solid #475569', background: 'transparent', color: '#cbd5e1', fontSize: 16, lineHeight: 1, cursor: 'pointer' }}>
              ✕
            </button>
          </div>
        </div>

        {/* 문서 본문 — 팝업 내부 스크롤(가로·세로). 문서 폭은 고정(A4)이라 창을 줄여도 레이아웃이 깨지지 않고 스크롤된다 */}
        <div data-testid={`${testIdPrefix}-body`} style={{ flex: 1, minHeight: 0, overflow: 'auto', background: '#e2e8f0' }}>
          {children}
        </div>

        {/* 크기 조절 핸들 — 테두리 4곳 + 모서리 4곳(모바일 제외) */}
        {!mobile && HANDLES.map(h => (
          <div key={h.dir} onPointerDown={startDrag(h.dir)}
            data-testid={`${testIdPrefix}-resize-${h.dir}`} aria-hidden="true"
            style={{ position: 'absolute', zIndex: 5, cursor: h.cursor, touchAction: 'none', ...h.style }} />
        ))}
      </div>
    </div>
  );
}

export default DocPreviewWindow;
