// ─────────────────────────────────────────────────────────────────────────────
// 공통 인라인 달력(홈택스형 좌우이동) — VERITAS ERP 톤 compact 스타일.
//
// 목적: 견적/판매/수행/납품일/지급일/입금일 등에서 쓰던 native <input type="date">
//       의 브라우저 달력을 공통 커스텀 달력으로 교체한다.
//
// 절대 불변(지시문 §10·§12):
//   · 값은 오직 "YYYY-MM-DD" 문자열로만 주고받는다(native input 과 동일 인터페이스).
//   · value/onChange 시그니처, 저장 형식, 타임존 처리, 계산 로직을 바꾸지 않는다.
//   · 문자열 ↔ 화면 변환은 로컬 Y/M/D 만 사용한다(Date.toISOString() 미사용 → 타임존 이동 없음).
//
// 제공:
//   · MonthCalendar — 팝오버 없이 렌더되는 순수 달력 그리드(단일/기간 공용 재사용).
//   · DateField     — native date input 드롭인 대체(입력칸 + 팝오버 + 바깥클릭/ESC/토글/선택시 닫힘).
//   · useDateAnchor — 트리거 기준 fixed 좌표(조상 overflow 에 안 잘림). QuoteEditor 의 패턴과 동일.
// ─────────────────────────────────────────────────────────────────────────────
import * as React from 'react';
import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { C, BD } from '../../lib/ds';

// ─── 문자열 유틸 (타임존 안전) ────────────────────────────────────────────────
const pad2 = (n: number) => String(n).padStart(2, '0');
/** (y, m0, d) → "YYYY-MM-DD". m0 은 0-based 월. Date 직렬화를 쓰지 않아 타임존 이동이 없다. */
export const toYmd = (y: number, m0: number, d: number) => `${y}-${pad2(m0 + 1)}-${pad2(d)}`;
/** "YYYY-MM-DD"(앞 10자리) → {y, m0, d} 또는 null. 표준 형식이 아니면 null(기존 값 보존). */
function parseYmd(v?: string | null): { y: number; m0: number; d: number } | null {
  const s = v ? String(v).slice(0, 10) : '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return { y: +m[1], m0: +m[2] - 1, d: +m[3] };
}

// ─── fixed 앵커 훅 — 트리거 위치에 팝오버를 붙이고 스크롤/리사이즈에 재계산 ──────
// 팝오버(달력) 대략 크기 — 뷰포트 경계에서 flip/clamp 판단용.
const CAL_W = 256, CAL_H = 300;
export function useDateAnchor(ref: React.RefObject<HTMLElement | null>, open: boolean, gap = 3) {
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !ref.current) { setPos(null); return; }
    const compute = () => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      // 세로: 아래 공간이 부족하고 위 공간이 넉넉하면 위로 flip.
      const below = r.bottom + gap;
      const top = (below + CAL_H > vh && r.top - gap - CAL_H > 0) ? (r.top - gap - CAL_H) : below;
      // 가로: 오른쪽으로 넘치면 왼쪽으로 clamp(최소 8px 여백).
      const left = Math.max(8, Math.min(r.left, vw - CAL_W - 8));
      setPos({ top, left, width: r.width });
    };
    compute();
    window.addEventListener('scroll', compute, true);   // capture — 내부 스크롤 컨테이너 포함
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [open, gap, ref]);
  return pos ?? { top: -9999, left: -9999, width: 0 };
}

// ─── 요일 헤더 ───────────────────────────────────────────────────────────────
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
// 홈택스 톤: 일요일 빨강(danger) / 토요일 파랑(primary) / 평일 기본 텍스트색.
const weekendColor = (dow: number, base: string) =>
  dow === 0 ? C.danger : dow === 6 ? C.primary : base;

/** 42칸(6주) 셀 목록: 전월 말일 + 당월 + 다음월 초일. 전/다음월은 outside=true(흐림). */
function buildCells(viewY: number, viewM0: number) {
  const firstDow  = new Date(viewY, viewM0, 1).getDay();       // 0(일)~6(토)
  const daysInCur = new Date(viewY, viewM0 + 1, 0).getDate();
  const daysInPrev = new Date(viewY, viewM0, 0).getDate();
  const cells: { y: number; m0: number; d: number; dow: number; outside: boolean }[] = [];
  // 앞쪽 전월 채우기
  for (let i = firstDow - 1; i >= 0; i--) {
    const d = daysInPrev - i;
    const pm = viewM0 === 0 ? 11 : viewM0 - 1;
    const py = viewM0 === 0 ? viewY - 1 : viewY;
    cells.push({ y: py, m0: pm, d, dow: new Date(py, pm, d).getDay(), outside: true });
  }
  // 당월
  for (let d = 1; d <= daysInCur; d++) {
    cells.push({ y: viewY, m0: viewM0, d, dow: new Date(viewY, viewM0, d).getDay(), outside: false });
  }
  // 뒤쪽 다음월 채우기(6주=42칸까지)
  let nd = 1;
  while (cells.length < 42) {
    const nm = viewM0 === 11 ? 0 : viewM0 + 1;
    const ny = viewM0 === 11 ? viewY + 1 : viewY;
    cells.push({ y: ny, m0: nm, d: nd, dow: new Date(ny, nm, nd).getDay(), outside: true });
    nd++;
  }
  return cells;
}

// ─── MonthCalendar — 순수 달력 그리드(팝오버 없음, 단일/기간 공용) ─────────────
export interface MonthCalendarProps {
  value?: string | null;                 // 현재 선택 "YYYY-MM-DD" (없으면 오늘 월 표시)
  onSelect: (ymd: string) => void;       // 날짜 클릭 시 "YYYY-MM-DD" 전달
  min?: string | null;                   // 이 날짜 이전은 비활성(기간 종료일 min=시작일 등)
  max?: string | null;                   // 이 날짜 이후는 비활성
  onClear?: () => void;                  // '지우기' 버튼(제공 시에만 노출)
  autoFocus?: boolean;                   // 마운트 시 컨테이너 포커스(ESC 대비)
}

export function MonthCalendar({ value, onSelect, min, max, onClear, autoFocus }: MonthCalendarProps) {
  const today = new Date();
  const sel = parseYmd(value);
  // 표시 기준 월: 선택값 있으면 그 월, 없으면 오늘 월. (컴포넌트가 열릴 때마다 새로 초기화됨)
  const [viewY, setViewY] = useState(sel ? sel.y : today.getFullYear());
  const [viewM0, setViewM0] = useState(sel ? sel.m0 : today.getMonth());
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (autoFocus) rootRef.current?.focus(); }, [autoFocus]);

  const selStr   = sel ? toYmd(sel.y, sel.m0, sel.d) : '';
  const todayStr = toYmd(today.getFullYear(), today.getMonth(), today.getDate());
  const cells    = buildCells(viewY, viewM0);

  // 연도 dropdown 범위 — 업무 날짜 중심(현재±). 뷰가 벗어나도 항상 뷰연도를 포함.
  const yFrom = Math.min(2015, viewY - 5), yTo = Math.max(2035, viewY + 5);
  const years: number[] = [];
  for (let y = yFrom; y <= yTo; y++) years.push(y);

  const stepMonth = (delta: number) => {
    let m = viewM0 + delta, y = viewY;
    if (m < 0) { m = 11; y -= 1; } else if (m > 11) { m = 0; y += 1; }
    setViewM0(m); setViewY(y);
  };

  const goToday = () => {
    setViewY(today.getFullYear()); setViewM0(today.getMonth());
    onSelect(todayStr);
  };

  const navBtn: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 22, height: 22, border: `1px solid ${C.g200}`, borderRadius: 5,
    background: C.white, color: C.g600, fontSize: 12, lineHeight: 1, cursor: 'pointer',
    padding: 0, userSelect: 'none', flexShrink: 0,
  };
  const selectStyle: React.CSSProperties = {
    height: 24, border: `1px solid ${C.g300}`, borderRadius: 5, background: C.white,
    color: C.textPrimary, fontSize: 12, fontWeight: 600, padding: '0 4px', cursor: 'pointer',
  };

  return (
    <div ref={rootRef} tabIndex={-1} style={{ outline: 'none', width: 236 }} data-testid="month-calendar">
      {/* 상단 네비게이션: ≪ 〈 [연도▼] [월▼] 〉 ≫ */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, marginBottom: 8 }}>
        <button type="button" style={navBtn} onClick={() => setViewY(y => y - 1)} aria-label="이전 연도" data-testid="cal-prev-year" title="이전 연도">≪</button>
        <button type="button" style={navBtn} onClick={() => stepMonth(-1)} aria-label="이전 달" data-testid="cal-prev-month" title="이전 달">〈</button>
        <select value={viewY} onChange={e => setViewY(+e.target.value)} style={selectStyle} aria-label="연도 선택" data-testid="cal-year-select">
          {years.map(y => <option key={y} value={y}>{y}년</option>)}
        </select>
        <select value={viewM0} onChange={e => setViewM0(+e.target.value)} style={selectStyle} aria-label="월 선택" data-testid="cal-month-select">
          {Array.from({ length: 12 }, (_, i) => <option key={i} value={i}>{i + 1}월</option>)}
        </select>
        <button type="button" style={navBtn} onClick={() => stepMonth(1)} aria-label="다음 달" data-testid="cal-next-month" title="다음 달">〉</button>
        <button type="button" style={navBtn} onClick={() => setViewY(y => y + 1)} aria-label="다음 연도" data-testid="cal-next-year" title="다음 연도">≫</button>
      </div>

      {/* 요일 헤더 — 일 빨강 / 토 파랑 / 평일 muted */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', marginBottom: 2 }}>
        {WEEKDAYS.map((w, i) => (
          <div key={w} style={{ textAlign: 'center', fontSize: 11, fontWeight: 700, padding: '2px 0', color: weekendColor(i, C.textMuted) }}>{w}</div>
        ))}
      </div>

      {/* 날짜 그리드 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1 }}>
        {cells.map((c, idx) => {
          const ds = toYmd(c.y, c.m0, c.d);
          const disabled = (!!min && ds < min) || (!!max && ds > max);
          const selected = !!selStr && ds === selStr;
          const isToday  = ds === todayStr;
          // 색 우선순위: 선택 > 비활성 > 전/다음월(흐림) > 주말색 > 평일 기본.
          let color = weekendColor(c.dow, C.textPrimary);
          if (c.outside) color = C.g300;                 // 전/다음월 흐린 회색
          if (disabled)  color = C.g300;
          if (selected)  color = C.white;                // 선택 강조 우선
          return (
            <button
              key={idx}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(ds)}
              aria-label={ds}
              data-testid={`cal-day-${ds}`}
              aria-pressed={selected}
              style={{
                height: 28, border: selected ? 'none' : (isToday ? `1px solid ${C.primaryBorder}` : '1px solid transparent'),
                borderRadius: 6, background: selected ? C.primary : (isToday ? C.primaryBg : 'transparent'),
                color, fontSize: 12, fontWeight: selected ? 700 : (isToday ? 600 : 400),
                cursor: disabled ? 'default' : 'pointer', padding: 0, opacity: disabled ? 0.55 : 1,
                fontVariantNumeric: 'tabular-nums',
              }}
            >{c.d}</button>
          );
        })}
      </div>

      {/* 하단 — [오늘] / (지우기) */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 8 }}>
        <button type="button" onClick={goToday} aria-label="오늘" data-testid="cal-today"
          style={{ border: `1px solid ${C.g300}`, borderRadius: 6, padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', background: C.g50, color: C.textSecondary }}>오늘</button>
        {onClear && (
          <button type="button" onClick={onClear} aria-label="날짜 지우기" data-testid="cal-clear"
            style={{ border: `1px solid ${C.g300}`, borderRadius: 6, padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', background: C.white, color: C.textMuted }}>지우기</button>
        )}
      </div>
    </div>
  );
}

// ─── DateField — native <input type="date"> 드롭인 대체 ───────────────────────
export interface DateFieldProps {
  value: string;                          // "YYYY-MM-DD" 또는 ''(빈 값)
  onChange: (value: string) => void;      // native input 과 동일: 선택값 문자열 전달('' 가능)
  min?: string;
  max?: string;
  disabled?: boolean;
  style?: React.CSSProperties;            // 트리거 박스 스타일(기존 native input style 그대로 전달)
  placeholder?: string;
  allowClear?: boolean;                   // 하단 '지우기' 노출(기본 true)
  testid?: string;
  ariaLabel?: string;
  title?: string;
}

export function DateField({
  value, onChange, min, max, disabled, style, placeholder = '날짜 선택',
  allowClear = true, testid, ariaLabel, title,
}: DateFieldProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const anchor = useDateAnchor(ref, open, 2);

  useEffect(() => {
    if (!open) return;
    // 바깥클릭·ESC 로 닫는다(§4·§6). 달력 팝오버는 body 로 포털되므로(조상 transform/overflow 회피)
    // 트리거(ref)뿐 아니라 포털된 달력(popRef) 내부 클릭도 '안'으로 간주해 닫지 않는다.
    // listener 는 open 동안에만 등록/해제 → 중복 누적/누수 방지.
    const onKey  = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setOpen(false); };
    const onDown = (ev: MouseEvent) => {
      const t = ev.target as Node;
      if (ref.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const pick = (ds: string) => { onChange(ds); setOpen(false); };   // 날짜 선택 → 적용 + 닫힘(§4)
  const clear = () => { onChange(''); setOpen(false); };

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex', ...(style?.width ? { width: style.width } : {}) }}>
      {/* 트리거 — native input 자리. 기존 style 을 그대로 적용해 크기/테두리 유지 */}
      <div
        onClick={() => { if (disabled) return; setOpen(o => !o); }}   // 재클릭 토글(§4)
        role="button" tabIndex={disabled ? -1 : 0}
        onKeyDown={e => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen(o => !o); } }}
        aria-label={ariaLabel || title || '날짜 선택'} aria-haspopup="dialog" aria-expanded={open}
        data-testid={testid} title={title}
        style={{
          // 기존 native input 의 style(테두리·padding·width·height·background·color)을 그대로 적용해
          // 크기/모양을 보존한다. flex 로 값 텍스트와 달력 아이콘을 한 줄에 배치.
          display: 'flex', alignItems: 'center', gap: 4, cursor: disabled ? 'default' : 'pointer',
          overflow: 'hidden', boxSizing: 'border-box', opacity: disabled ? 0.6 : 1,
          ...style,
        }}
      >
        <span style={{ flex: 1, minWidth: 0, fontSize: (style?.fontSize as number) ?? 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: value ? (style?.color ?? C.textPrimary) : C.g400 }}>
          {value || placeholder}
        </span>
        {/* 달력 아이콘 */}
        <span aria-hidden style={{ flexShrink: 0, display: 'flex', color: C.g400 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
          </svg>
        </span>
      </div>
      {open && createPortal(
        <div
          ref={popRef}
          data-datefield-calendar
          /* body 로 포털됐으므로 상위 팝오버(기간 선택기·설치일시·금액 팝업 등)의 document mousedown
             바깥클릭 리스너 입장에선 이 달력이 '바깥'으로 보인다. 전파를 여기서 멈춰 상위 팝오버가
             달력 조작 중 닫히지 않게 한다(모든 상위 리스너는 bubble-phase mousedown 사용). */
          onMouseDown={e => e.stopPropagation()}
          style={{ position: 'fixed', top: anchor.top, left: anchor.left, zIndex: 10000, background: C.bgCard, border: BD.card, borderRadius: 10, boxShadow: BD.shadow.popover, padding: 10 }}
          data-testid={testid ? `${testid}-popover` : 'datefield-popover'}
        >
          <MonthCalendar value={value} onSelect={pick} min={min} max={max} onClear={allowClear ? clear : undefined} autoFocus />
        </div>,
        document.body,
      )}
    </div>
  );
}
