import { useState, useCallback, useEffect } from 'react';
import { api, Product, PRODUCT_TYPES_META } from '../../../lib/constants';
import { Card, PrimaryBtn, GhostBtn } from '../../ui';
import { Section, inputStyle } from './productShared';
import {
  useBulkSelection, useClientPagination, BulkSelectBar, bulkActionBtn, Pagination, trashRowStyle,
} from '../bulkListShared';

interface Props {
  token: string;
  user: { role: string } | null;
  setToast: (msg: string) => void;
  authHeaders: Record<string, string>;
}

/** 휴지통 — 삭제된 상품만 표시. 선택형 일괄관리: 복원(PM 가능) / 완전삭제(admin만). */
export function ProductTrashTab({ token, user, setToast, authHeaders }: Props) {
  const [trashProducts, setTrashProducts] = useState<Product[]>([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashSearch, setTrashSearch] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [purging, setPurging] = useState(false);
  const [purgeConfirmOpen, setPurgeConfirmOpen] = useState(false);
  const [hoveredId, setHoveredId] = useState<number | null>(null);

  const canPurge = user?.role === "admin";

  const sel = useBulkSelection<number>();
  const { paged, page, setPage, pageSize, setPageSize, total, totalPages, rangeStart, rangeEnd } =
    useClientPagination(trashProducts, 20);
  const pageIds = paged.map(p => p.id);
  const allSelected = sel.allSelected(pageIds);

  const fetchTrash = useCallback(async () => {
    setTrashLoading(true);
    try {
      const params = new URLSearchParams();
      if (trashSearch.trim()) params.set("search", trashSearch.trim());
      const res = await fetch(api(`/api/admin/products/trash${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) {
        const list = Array.isArray(data) ? data : [];
        setTrashProducts(list);
        sel.pruneTo(list.map((p: Product) => p.id));
      }
    } catch { setToast("오류: 휴지통 조회 실패"); }
    finally { setTrashLoading(false); }
  }, [token, trashSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchTrash(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── 선택 상품 일괄 복원 (휴지통 → 일반 목록) ───────────────────────────────
  const handleRestoreSelected = async () => {
    const ids = Array.from(sel.selectedIds);
    if (ids.length === 0) return;
    setRestoring(true);
    try {
      const results = await Promise.all(ids.map(id =>
        fetch(api(`/api/admin/products/${id}/restore`), { method: "POST", headers: authHeaders })
          .then(r => r.ok).catch(() => false)));
      const ok = results.filter(Boolean).length;
      setToast(`${ok}개 상품을 복원했습니다.${ok < ids.length ? ` (${ids.length - ok}건 실패)` : ""}`);
      sel.clear();
      await fetchTrash();
    } finally { setRestoring(false); }
  };

  // ─── 선택 상품 일괄 완전삭제 (실제 DB 삭제, admin 전용) ──────────────────────
  const handlePurgeSelected = async () => {
    const ids = Array.from(sel.selectedIds);
    if (ids.length === 0) return;
    setPurging(true);
    try {
      const results = await Promise.all(ids.map(id =>
        fetch(api(`/api/admin/products/${id}/purge`), { method: "DELETE", headers: authHeaders })
          .then(r => r.ok).catch(() => false)));
      const ok = results.filter(Boolean).length;
      setToast(`${ok}개 상품을 완전삭제했습니다.${ok < ids.length ? ` (${ids.length - ok}건 실패 — 견적/프로젝트 사용 상품 등)` : ""}`);
      setPurgeConfirmOpen(false);
      sel.clear();
      await fetchTrash();
    } catch { setToast("오류: 완전삭제 실패"); }
    finally { setPurging(false); }
  };

  const selectedCount = sel.selectedCount;

  return (
    <>
      <Section title={`휴지통 (${trashProducts.length})`} sub="삭제된 상품만 표시됩니다. 복원하면 삭제 전 상태로 일반 목록에 복귀합니다.">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
          <input value={trashSearch} onChange={e => setTrashSearch(e.target.value)}
            placeholder="휴지통 내 검색..."
            aria-label="휴지통 검색"
            style={{ ...inputStyle, maxWidth: 200, flex: "1 1 140px", padding: "8px 12px", fontSize: 13 }}
            onKeyDown={e => e.key === "Enter" && fetchTrash()} />
          <PrimaryBtn onClick={fetchTrash} disabled={trashLoading} style={{ padding: "8px 14px", fontSize: 13 }}>
            {trashLoading ? "검색 중..." : "검색"}
          </PrimaryBtn>
        </div>

        {/* 선택 기반 일괄 관리 바 */}
        <BulkSelectBar
          allSelected={allSelected}
          onToggleAll={() => sel.togglePage(pageIds)}
          selectedCount={selectedCount}>
          <button
            onClick={handleRestoreSelected}
            disabled={selectedCount < 1 || restoring}
            data-testid="bulk-restore"
            style={bulkActionBtn(selectedCount >= 1 && !restoring, "#059669", "#ecfdf5", "#a7f3d0")}>
            {restoring ? "복원 중..." : "복원"}
          </button>
          {canPurge && (
            <button
              onClick={() => setPurgeConfirmOpen(true)}
              disabled={selectedCount < 1}
              data-testid="bulk-purge"
              style={bulkActionBtn(selectedCount >= 1, "#dc2626", "#fef2f2", "#fecaca")}>
              완전삭제
            </button>
          )}
        </BulkSelectBar>

        {trashLoading ? (
          <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
        ) : trashProducts.length === 0 ? (
          <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>휴지통이 비어 있습니다.</Card>
        ) : (
          <Card style={{ padding: 0, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#f9fafb", color: "#6b7280", textAlign: "left" }}>
                  <th style={{ padding: "10px 14px", fontWeight: 600, width: 44 }}>
                    <input type="checkbox" checked={allSelected} onChange={() => sel.togglePage(pageIds)}
                      aria-label="현재 페이지 전체 선택" data-testid="select-all-head"
                      style={{ width: 16, height: 16, cursor: "pointer" }} />
                  </th>
                  <th style={{ padding: "10px 14px", fontWeight: 600 }}>상품코드</th>
                  <th style={{ padding: "10px 14px", fontWeight: 600 }}>상품명</th>
                  <th style={{ padding: "10px 14px", fontWeight: 600 }}>유형</th>
                  <th style={{ padding: "10px 14px", fontWeight: 600 }}>삭제일</th>
                  <th style={{ padding: "10px 14px", fontWeight: 600 }}>삭제자</th>
                </tr>
              </thead>
              <tbody>
                {paged.map(p => {
                  const selected = sel.isSelected(p.id);
                  return (
                    <tr key={p.id}
                      onClick={() => sel.toggle(p.id)}
                      onMouseEnter={() => setHoveredId(p.id)}
                      onMouseLeave={() => setHoveredId(prev => (prev === p.id ? null : prev))}
                      style={{ borderTop: "1px solid #f3f4f6", cursor: "pointer", ...trashRowStyle(selected, hoveredId === p.id) }}
                      data-testid={`trash-row-${p.id}`}>
                      <td style={{ padding: "10px 14px" }} onClick={e => e.stopPropagation()}>
                        <input type="checkbox" checked={selected} onChange={() => sel.toggle(p.id)}
                          aria-label={`상품 선택: ${p.name}`}
                          data-testid={`product-select-${p.id}`}
                          style={{ width: 16, height: 16, cursor: "pointer" }} />
                      </td>
                      <td style={{ padding: "10px 14px", fontFamily: "monospace", fontSize: 11, color: "#6b7280" }}>{p.code}</td>
                      <td style={{ padding: "10px 14px", fontWeight: 600, color: "#111827" }}>{p.name}</td>
                      <td style={{ padding: "10px 14px", color: "#374151" }}>{PRODUCT_TYPES_META[p.productType]?.label ?? p.productType}</td>
                      <td style={{ padding: "10px 14px", color: "#6b7280" }}>{p.deletedAt ? new Date(p.deletedAt).toLocaleString("ko-KR") : "-"}</td>
                      <td style={{ padding: "10px 14px", color: "#6b7280" }}>{p.deletedByName || p.deletedByEmail || "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}

        <Pagination total={total} totalPages={totalPages} page={page} pageSize={pageSize}
          rangeStart={rangeStart} rangeEnd={rangeEnd} setPage={setPage} setPageSize={setPageSize} />
      </Section>

      {/* 완전삭제 확인 모달 (선택 일괄) */}
      {purgeConfirmOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1001 }}>
          <Card style={{ width: 420, padding: "28px 32px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <div style={{ width: 40, height: 40, borderRadius: "50%", background: "#fee2e2", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>🗑</div>
              <div>
                <p style={{ margin: 0, fontWeight: 700, fontSize: 16, color: "#111827" }}>선택한 상품 {selectedCount}건 완전삭제</p>
                <p style={{ margin: "2px 0 0", fontSize: 12, color: "#9ca3af" }}>이 작업은 되돌릴 수 없습니다.</p>
              </div>
            </div>
            <p style={{ margin: "0 0 6px", fontSize: 13, color: "#dc2626", fontWeight: 600 }}>⚠ 주의사항</p>
            <ul style={{ margin: "0 0 20px", paddingLeft: 18, fontSize: 12, color: "#6b7280", lineHeight: 1.7 }}>
              <li>견적/프로젝트에 사용된 상품은 삭제할 수 없습니다.</li>
              <li>상품 코드는 삭제 후에도 재사용되지 않습니다.</li>
              <li>통번역사 단가 설정이 함께 삭제됩니다.</li>
            </ul>
            <div style={{ display: "flex", gap: 8 }}>
              <GhostBtn onClick={() => setPurgeConfirmOpen(false)} style={{ fontSize: 13, padding: "10px 20px", flex: 1 }}>취소</GhostBtn>
              <button onClick={handlePurgeSelected} disabled={purging}
                data-testid="confirm-purge"
                style={{ flex: 1, padding: "10px 0", fontSize: 14, borderRadius: 8, cursor: purging ? "not-allowed" : "pointer", background: purging ? "#9ca3af" : "#dc2626", color: "#fff", border: "none", fontWeight: 700 }}>
                {purging ? "삭제 중..." : "완전삭제"}
              </button>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
