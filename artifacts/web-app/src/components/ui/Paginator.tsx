import React, { useState } from 'react';
import { C } from '../../lib/ds';

// ─── VERITAS 공통 Pagination ──────────────────────────────────────────────────
// 플랫폼 전체 목록 화면(거래처·담당자·통번역사·견적·판매·결제·정산·채권 등)에서
// 동일하게 재사용하는 서버 페이지네이션 컨트롤.
//   - 현재 표시 범위(1~20 / 전체 489건)
//   - 페이지당 표시 개수 선택(20 / 30 / 50 / 100)
//   - 이전 · 1 2 3 … · 다음 (현재 페이지 강조, 다수 시 … 축약)
// 디자인은 ds.ts 토큰(C)을 따른다.

const DEFAULT_PAGE_SIZES = [20, 30, 50, 100];

export interface PaginationProps {
  page: number;                          // 1-based
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  pageSizeOptions?: number[];
  unit?: string;                         // '건' | '명' 등
  disabled?: boolean;
  /** 스크린리더/테스트 식별용 접두어(거래처/담당자 등) */
  idPrefix?: string;
}

/** 표시할 페이지 번호 목록(… 포함). 항상 1과 마지막, 현재±1을 노출한다. */
function buildPageItems(current: number, totalPages: number): (number | 'ellipsis')[] {
  const set = new Set<number>();
  set.add(1);
  set.add(totalPages);
  for (let p = current - 1; p <= current + 1; p++) {
    if (p >= 1 && p <= totalPages) set.add(p);
  }
  const sorted = [...set].sort((a, b) => a - b);
  const out: (number | 'ellipsis')[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) out.push('ellipsis');
    out.push(p);
    prev = p;
  }
  return out;
}

const navBtnBase: React.CSSProperties = {
  minWidth: 32, height: 32, padding: '0 9px', borderRadius: 6,
  fontSize: 13, fontWeight: 600, cursor: 'pointer',
  border: `1px solid ${C.g200}`, background: C.white, color: C.g700,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  transition: 'all 0.12s', lineHeight: 1,
};

function PageBtn({ children, active, disabled, onClick, label, testid }: {
  children: React.ReactNode; active?: boolean; disabled?: boolean;
  onClick?: () => void; label: string; testid?: string;
}) {
  const [hov, setHov] = useState(false);
  const style: React.CSSProperties = {
    ...navBtnBase,
    ...(active ? { background: C.primary, borderColor: C.primary, color: C.white, cursor: 'default' } : {}),
    ...(hov && !active && !disabled ? { background: C.primaryBg, borderColor: C.primaryBorder, color: C.primaryText } : {}),
    ...(disabled ? { opacity: 0.45, cursor: 'not-allowed' } : {}),
  };
  return (
    <button
      type="button"
      onClick={disabled || active ? undefined : onClick}
      disabled={disabled}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      data-testid={testid}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={style}
    >
      {children}
    </button>
  );
}

export function Pagination({
  page, pageSize, total, onPageChange, onPageSizeChange,
  pageSizeOptions = DEFAULT_PAGE_SIZES, unit = '건', disabled = false, idPrefix = 'list',
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const rangeStart = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const rangeEnd = Math.min(safePage * pageSize, total);
  const items = buildPageItems(safePage, totalPages);

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 12, flexWrap: 'wrap', marginTop: 14,
    }} data-testid={`${idPrefix}-pagination`}>
      {/* 좌: 현재 표시 범위 + 페이지당 개수 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: C.textMuted, whiteSpace: 'nowrap' }}>
          {rangeStart.toLocaleString()}~{rangeEnd.toLocaleString()} / 전체 <b style={{ color: C.g700 }}>{total.toLocaleString()}</b>{unit}
        </span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.textMuted }}>
          페이지당
          <select
            value={pageSize}
            disabled={disabled}
            aria-label="페이지당 표시 개수"
            data-testid={`${idPrefix}-pagination-pagesize`}
            onChange={e => onPageSizeChange(Number(e.target.value))}
            style={{
              height: 32, padding: '0 26px 0 10px', borderRadius: 6, fontSize: 13, fontWeight: 600,
              border: `1px solid ${C.g200}`, background: C.white, color: C.g700, cursor: 'pointer',
              appearance: 'none', WebkitAppearance: 'none',
              backgroundImage: 'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%236b7280\' stroke-width=\'2\'><path d=\'M6 9l6 6 6-6\'/></svg>")',
              backgroundRepeat: 'no-repeat', backgroundPosition: 'right 8px center',
            }}
          >
            {pageSizeOptions.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>

      {/* 우: 페이지 네비게이션 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <PageBtn label="이전 페이지" disabled={disabled || safePage <= 1}
          onClick={() => onPageChange(safePage - 1)} testid={`${idPrefix}-pagination-prev`}>
          이전
        </PageBtn>
        {items.map((it, i) =>
          it === 'ellipsis'
            ? <span key={`e${i}`} style={{ minWidth: 24, textAlign: 'center', color: C.g400, fontSize: 13 }}>…</span>
            : <PageBtn key={it} label={`${it}페이지`} active={it === safePage} disabled={disabled}
                onClick={() => onPageChange(it)} testid={`${idPrefix}-pagination-page-${it}`}>
                {it}
              </PageBtn>,
        )}
        <PageBtn label="다음 페이지" disabled={disabled || safePage >= totalPages}
          onClick={() => onPageChange(safePage + 1)} testid={`${idPrefix}-pagination-next`}>
          다음
        </PageBtn>
      </div>
    </div>
  );
}

export default Pagination;
