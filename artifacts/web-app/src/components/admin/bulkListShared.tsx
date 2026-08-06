import React, { useEffect, useState } from 'react';
import { bulkBtnStyle, pageNavBtnStyle, inputStyle } from './product/productShared';

// ─────────────────────────────────────────────────────────────────────────────
// 휴지통·목록 공통 UX 프리미티브
//
// 플랫폼 전역(상품·거래처·담당자·견적 등)의 목록/휴지통 화면이
// 동일한 선택형 일괄관리 UX를 공유하도록 만든 공통 모듈.
// 상품목록(ProductListTab)의 체크박스·일괄버튼·페이지네이션 디자인을 단일 소스로 재사용한다.
// ─────────────────────────────────────────────────────────────────────────────

export const PAGE_SIZE_OPTIONS = [20, 50, 100];

// ─── 선택 상태 훅 ────────────────────────────────────────────────────────────
// selectedIds 는 페이지를 넘겨도 유지된다. 전체선택/해제는 "현재 페이지" 기준.
export function useBulkSelection<ID>() {
  const [selectedIds, setSelectedIds] = useState<Set<ID>>(new Set());

  const toggle = (id: ID) =>
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const clear = () => setSelectedIds(new Set());

  const isSelected = (id: ID) => selectedIds.has(id);

  /** 현재 페이지 id 목록 전체선택 ↔ 해제 토글 */
  const togglePage = (pageIds: ID[]) =>
    setSelectedIds(prev => {
      const next = new Set(prev);
      const allOn = pageIds.length > 0 && pageIds.every(id => next.has(id));
      if (allOn) pageIds.forEach(id => next.delete(id));
      else pageIds.forEach(id => next.add(id));
      return next;
    });

  /** 목록에서 사라진 항목(복원/영구삭제 후 등)을 선택에서 제거 */
  const pruneTo = (validIds: ID[]) =>
    setSelectedIds(prev => {
      const valid = new Set(validIds);
      const next = new Set<ID>();
      prev.forEach(id => { if (valid.has(id)) next.add(id); });
      return next.size === prev.size ? prev : next;
    });

  const allSelected = (pageIds: ID[]) => pageIds.length > 0 && pageIds.every(id => selectedIds.has(id));

  return { selectedIds, setSelectedIds, toggle, clear, isSelected, togglePage, pruneTo, allSelected, selectedCount: selectedIds.size };
}

// ─── 클라이언트 페이지네이션 훅 ───────────────────────────────────────────────
// 이미 가져온 배열을 페이지 단위로 잘라 표시한다(서버 API 변경 불필요).
export function useClientPagination<T>(items: T[], initialSize = 20) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialSize);

  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const curPage = Math.min(page, totalPages);

  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [totalPages, page]);
  useEffect(() => { setPage(1); }, [pageSize]);

  const rangeStart = total === 0 ? 0 : (curPage - 1) * pageSize + 1;
  const rangeEnd = Math.min(curPage * pageSize, total);
  const paged = items.slice((curPage - 1) * pageSize, curPage * pageSize);

  return { paged, page: curPage, setPage, pageSize, setPageSize, total, totalPages, rangeStart, rangeEnd };
}

// ─── 행 스타일 (hover / 선택) ─────────────────────────────────────────────────
// 상품목록 카드 선택 스타일과 동일한 색상(#eff6ff / #bfdbfe)을 표(row)에 적용.
// 선택: 옅은 파란 배경 + 얇은 파란 테두리(inset box-shadow로 레이아웃 흔들림 방지)
// hover: 옅은 회색 배경
export function trashRowStyle(selected: boolean, hovered: boolean): React.CSSProperties {
  if (selected) return { background: "#eff6ff", boxShadow: "inset 0 0 0 1px #bfdbfe" };
  if (hovered) return { background: "#f9fafb" };
  return {};
}

// ─── 선택 작업바 공통 Sticky 스타일 ──────────────────────────────────────────
// 플랫폼의 모든 선택형 목록 화면이 동일한 Sticky 동작을 공유하도록 하는 단일 소스.
//
// 위치 기준: 관리자 레이아웃의 스크롤 컨테이너(AdminDashboard의 overflowY:auto 영역)
// 안에서 top:0 으로 고정된다. 상단 54px 글로벌 헤더는 스크롤 컨테이너 "밖"에 있으므로
// top:0 만으로 헤더 바로 아래에 고정된다(별도 header 높이 변수 불필요).
//
// z-index: 모달/드롭다운(9000+) > Sticky 작업바(30) > 일반 목록 순서를 유지.
// 기존 패널 배경(#f8fafc)을 그대로 두어 스크롤 전/후 시각 차이를 최소화하고,
// 아주 약한 그림자로만 목록과 구분한다(#5).
//
// ⚠️ 사용 시: 이 스타일은 각 화면 작업바 컨테이너 style 뒤에 spread 하여
//    position/top/zIndex/boxShadow 가 항상 적용되도록 한다.
export const stickyBulkBarStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 30,
  boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
};

// ─── 선택 기반 일괄 관리 바 ──────────────────────────────────────────────────
// 좌측: 현재 페이지 전체선택 + 선택 n건 / 우측: 일괄 작업 버튼(children)
export function BulkSelectBar({ allSelected, onToggleAll, selectedCount, children }: {
  allSelected: boolean;
  onToggleAll: () => void;
  selectedCount: number;
  children?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12, padding: "10px 14px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, ...stickyBulkBarStyle }}>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#374151", cursor: "pointer", fontWeight: 600 }}>
        <input type="checkbox" checked={allSelected} onChange={onToggleAll}
          aria-label="현재 페이지 전체 선택" data-testid="select-all"
          style={{ width: 16, height: 16, cursor: "pointer" }} />
        현재 페이지 전체선택
      </label>
      <span data-testid="selected-count" style={{ fontSize: 13, fontWeight: 700, color: selectedCount > 0 ? "#2563eb" : "#9ca3af" }}>
        선택 {selectedCount}건
      </span>
      <div style={{ flex: 1 }} />
      {children}
    </div>
  );
}

/** 일괄 관리 버튼 (상품목록과 동일 스타일: 6px 14px 패딩) */
export function bulkActionBtn(enabled: boolean, color: string, bg: string, border: string): React.CSSProperties {
  return bulkBtnStyle(enabled, color, bg, border, { padding: "6px 14px" });
}

// ─── 페이지네이션 (상품목록과 동일) ──────────────────────────────────────────
export function Pagination({ total, totalPages, page, pageSize, rangeStart, rangeEnd, setPage, setPageSize }: {
  total: number; totalPages: number; page: number; pageSize: number;
  rangeStart: number; rangeEnd: number;
  setPage: (n: number) => void; setPageSize: (n: number) => void;
}) {
  if (total <= 0) return null;

  const pageNumbers = (): number[] => {
    const maxButtons = 7;
    if (totalPages <= maxButtons) return Array.from({ length: totalPages }, (_, i) => i + 1);
    let start = Math.max(1, page - 3);
    const end = Math.min(totalPages, start + maxButtons - 1);
    start = Math.max(1, end - maxButtons + 1);
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginTop: 16 }}>
      <span data-testid="pagination-info" style={{ fontSize: 13, color: "#6b7280" }}>
        전체 {total}건 중 {rangeStart}–{rangeEnd}건 표시
        <span style={{ marginLeft: 8, color: "#9ca3af" }}>({total}건 / {totalPages}페이지)</span>
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))}
          aria-label="페이지당 표시 수" data-testid="page-size"
          style={{ ...inputStyle, padding: "6px 8px", fontSize: 12, width: "auto", minWidth: 110 }}>
          {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>페이지당 {n}건</option>)}
        </select>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <button data-testid="page-prev" disabled={page <= 1}
            onClick={() => { if (page > 1) setPage(page - 1); }} style={pageNavBtnStyle(page > 1)}>이전</button>
          {pageNumbers().map(n => (
            <button key={n} data-testid={`page-${n}`} onClick={() => setPage(n)}
              style={{
                fontSize: 12, minWidth: 32, padding: "6px 10px", borderRadius: 7, cursor: "pointer", fontWeight: n === page ? 700 : 500,
                border: `1px solid ${n === page ? "#2563eb" : "#e5e7eb"}`,
                background: n === page ? "#2563eb" : "#fff",
                color: n === page ? "#fff" : "#374151",
              }}>
              {n}
            </button>
          ))}
          <button data-testid="page-next" disabled={page >= totalPages}
            onClick={() => { if (page < totalPages) setPage(page + 1); }} style={pageNavBtnStyle(page < totalPages)}>다음</button>
        </div>
      </div>
    </div>
  );
}
