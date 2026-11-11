/**
 * DocPreviewWindow — 문서 미리보기 공통 창(견적서·거래명세서)
 *
 * [기본] 독립 브라우저 창 — window.open 으로 별도 창(900×900)을 열고 같은 문서(children)를 React portal 로 그린다.
 *   본창 밖·다른 모니터로 이동, OS 기본 크기 조절, 창 내부 스크롤. 창을 닫으면 onClose(원래 작업 화면은 그대로).
 *   문서 디자인·금액·인쇄 로직은 각 모달 그대로(인쇄는 문서가 있는 창에서 별도 인쇄 창을 연다).
 * [대체] 팝업 차단·좁은 화면(모바일)이면 아래 화면 내부 팝업으로 표시하고 차단 안내를 띄운다.
 *
 * 화면 내부 팝업:
 * - 최초 화면 중앙, 제목 표시줄 드래그로 이동, 테두리·모서리 드래그로 크기 조절.
 * - 최대 높이는 화면 높이 기준, 문서가 길면 팝업 내부(본문 영역)에서 스크롤.
 * - 우측 상단 닫기(X), ESC 닫기, 바깥(어두운 배경) 클릭 닫기(드래그 중 바깥에서 놓은 경우는 닫지 않음).
 * - 위치·크기는 컴포넌트 상태로만 관리(저장하지 않음). 모바일(좁은 화면)은 전체 화면 고정.
 * - 문서 본문(children)은 그대로 렌더한다 — 인쇄/PDF 는 각 모달이 본문 ref 의 innerHTML 로 별도 창에서 처리.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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
  /** 독립 창의 브라우저 제목(작업표시줄·탭) — 없으면 ariaLabel */
  windowTitle?: string;
  children: React.ReactNode;
}

// ─── 공통 제목 표시줄(제목·부제·동작 버튼·닫기 X) ─────────────────────────────────
function TitleBar({ title, subtitle, actions, onClose, testIdPrefix, closeTestId, onPointerDown, draggable, sticky }: Pick<DocPreviewWindowProps, 'title' | 'subtitle' | 'actions' | 'onClose' | 'testIdPrefix' | 'closeTestId'> & {
  onPointerDown?: (e: React.PointerEvent) => void; draggable: boolean; sticky?: boolean;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      data-testid={`${testIdPrefix}-titlebar`}
      style={{
        flexShrink: 0, background: '#1e293b', padding: '10px 12px 10px 20px', minHeight: TITLE_H, boxSizing: 'border-box',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        cursor: draggable ? 'move' : 'default', touchAction: draggable ? 'none' : undefined,
        ...(sticky ? { position: 'sticky', top: 0, zIndex: 10, boxShadow: '0 2px 8px rgba(0,0,0,0.3)' } : {}),
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
  );
}

// ─── 독립 브라우저 창 ─────────────────────────────────────────────────────────────
const EXT_W = 900, EXT_H = 900;
type ExtWin = { win: Window; root: HTMLElement };

// 사용자 클릭 직후(문서 조회 직후) 호출된다. 차단되면 null.
function openExternalWindow(docTitle: string): ExtWin | null {
  if (window.innerWidth < MOBILE_BP) return null;                       // 모바일 — 화면 내부 표시
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - EXT_W) / 2));
  const top  = Math.max(0, Math.round(window.screenY + (window.outerHeight - EXT_H) / 2));
  let win: Window | null = null;
  try { win = window.open('', '', `popup=yes,width=${EXT_W},height=${EXT_H},left=${left},top=${top},resizable=yes,scrollbars=yes`); }
  catch { win = null; }
  if (!win) return null;
  try {
    const d = win.document;
    d.open();
    d.write('<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title></title></head><body></body></html>');
    d.close();
    const base = d.createElement('base'); base.href = window.location.origin + '/'; d.head.appendChild(base);
    d.title = docTitle;
    // 본창의 스타일(폰트·공통 CSS)을 그대로 복사 — 문서는 인라인 스타일 위주라 표시가 같다
    document.querySelectorAll('style, link[rel="stylesheet"]').forEach(n => d.head.appendChild(n.cloneNode(true)));
    d.body.style.margin = '0';
    d.body.style.background = '#e2e8f0';
    const root = d.createElement('div');
    d.body.appendChild(root);
    win.focus();
    return { win, root };
  } catch {
    try { win.close(); } catch { /* 무시 */ }
    return null;
  }
}

/** 견적서·거래명세서 미리보기 — 독립 창(기본) 또는 화면 내부 팝업(팝업 차단·모바일) */
export function DocPreviewWindow(props: DocPreviewWindowProps) {
  const { onClose, ariaLabel, windowTitle, testIdPrefix, children } = props;
  const [mode, setMode] = useState<'pending' | 'external' | 'inpage'>('pending');
  const [blocked, setBlocked] = useState(false);
  const ext = useRef<ExtWin | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // 마운트 시 1회 — 독립 창 열기 시도
  useLayoutEffect(() => {
    const opened = openExternalWindow(windowTitle || ariaLabel);
    if (!opened) {
      setBlocked(window.innerWidth >= MOBILE_BP);   // 모바일은 원래 화면 내부 표시라 차단 안내 없음
      setMode('inpage');
      return;
    }
    ext.current = opened;
    setMode('external');
    const { win } = opened;
    let done = false;
    const closedByUser = () => { if (done) return; done = true; onCloseRef.current(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closedByUser(); };
    win.addEventListener('keydown', onKey);
    win.addEventListener('pagehide', closedByUser);                    // 창 닫기(OS 닫기 버튼 포함)
    const poll = window.setInterval(() => { if (win.closed) closedByUser(); }, 500);   // pagehide 미발생 대비
    const closeChild = () => { try { if (!win.closed) win.close(); } catch { /* 무시 */ } };
    window.addEventListener('pagehide', closeChild);                    // 본창 새로고침·이동 시 함께 닫기
    return () => {
      done = true;
      window.clearInterval(poll);
      window.removeEventListener('pagehide', closeChild);
      try { win.removeEventListener('keydown', onKey); win.removeEventListener('pagehide', closedByUser); } catch { /* 무시 */ }
      closeChild();
      ext.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 제목이 바뀌면 독립 창 제목도 갱신
  useEffect(() => { if (ext.current) ext.current.win.document.title = windowTitle || ariaLabel; }, [windowTitle, ariaLabel]);

  if (mode === 'pending') return null;
  if (mode === 'external' && ext.current) {
    return createPortal(
      <div data-testid={`${testIdPrefix}-external`} role="document" aria-label={ariaLabel} style={{ minHeight: '100vh', background: '#e2e8f0' }}>
        <TitleBar {...props} draggable={false} sticky />
        {children}
      </div>,
      ext.current.root,
    );
  }
  return (
    <InPageDocWindow {...props} notice={blocked ? (
      <div data-testid={`${testIdPrefix}-popup-blocked`} role="status"
        style={{ margin: '12px 24px 0', padding: '8px 12px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 6, fontSize: 12, color: '#92400e' }}>
        브라우저가 팝업을 차단해 화면 안 미리보기로 표시합니다. 주소창의 팝업 차단 표시에서 이 사이트의 팝업을 허용하면 다음부터 별도 창으로 열립니다.
      </div>
    ) : null} />
  );
}

function InPageDocWindow({ title, subtitle, actions, onClose, testIdPrefix, closeTestId, ariaLabel, children, notice }: DocPreviewWindowProps & { notice?: React.ReactNode }) {
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
        <TitleBar title={title} subtitle={subtitle} actions={actions} onClose={onClose} testIdPrefix={testIdPrefix} closeTestId={closeTestId}
          onPointerDown={startDrag('move')} draggable={!mobile} />

        {/* 문서 본문 — 팝업 내부 스크롤(가로·세로). 문서 폭은 고정(A4)이라 창을 줄여도 레이아웃이 깨지지 않고 스크롤된다 */}
        <div data-testid={`${testIdPrefix}-body`} style={{ flex: 1, minHeight: 0, overflow: 'auto', background: '#e2e8f0' }}>
          {notice}
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
