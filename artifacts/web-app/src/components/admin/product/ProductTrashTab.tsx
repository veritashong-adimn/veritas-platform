import { useState, useCallback, useEffect } from 'react';
import { api, Product, PRODUCT_TYPES_META } from '../../../lib/constants';
import { Card, PrimaryBtn, GhostBtn } from '../../ui';
import { Section, inputStyle } from './productShared';

interface Props {
  token: string;
  user: { role: string } | null;
  setToast: (msg: string) => void;
  authHeaders: Record<string, string>;
}

/** 휴지통 — 삭제된 상품만 표시. 복원(PM 가능) / 완전삭제(admin만). */
export function ProductTrashTab({ token, user, setToast, authHeaders }: Props) {
  const [trashProducts, setTrashProducts] = useState<Product[]>([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashSearch, setTrashSearch] = useState("");
  const [restoringId, setRestoringId] = useState<number | null>(null);
  const [deletingProduct, setDeletingProduct] = useState<{ id: number; code: string; name: string } | null>(null);
  const [purging, setPurging] = useState(false);

  const fetchTrash = useCallback(async () => {
    setTrashLoading(true);
    try {
      const params = new URLSearchParams();
      if (trashSearch.trim()) params.set("search", trashSearch.trim());
      const res = await fetch(api(`/api/admin/products/trash${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setTrashProducts(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 휴지통 조회 실패"); }
    finally { setTrashLoading(false); }
  }, [token, trashSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchTrash(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── 상품 복원 (휴지통 → 일반 목록) ──────────────────────────────────────
  const handleRestoreProduct = async (id: number) => {
    setRestoringId(id);
    try {
      const res = await fetch(api(`/api/admin/products/${id}/restore`), {
        method: "POST", headers: authHeaders,
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast(`상품 "${data.name}" (${data.code})을 복원했습니다.`);
      await fetchTrash();
    } catch { setToast("오류: 복원 실패"); }
    finally { setRestoringId(null); }
  };

  // ─── 상품 완전삭제 (실제 DB 삭제, admin 전용) ────────────────────────────
  const handlePurgeProduct = async () => {
    if (!deletingProduct) return;
    setPurging(true);
    try {
      const res = await fetch(api(`/api/admin/products/${deletingProduct.id}/purge`), {
        method: "DELETE", headers: authHeaders,
      });
      const data = await res.json();
      if (!res.ok) {
        setToast(`오류: ${data.error}`);
        setDeletingProduct(null);
        return;
      }
      setToast(`상품 "${deletingProduct.name}" (${deletingProduct.code})이 완전삭제되었습니다.`);
      setDeletingProduct(null);
      await fetchTrash();
    } catch { setToast("오류: 완전삭제 실패"); }
    finally { setPurging(false); }
  };

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
        {trashLoading ? (
          <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
        ) : trashProducts.length === 0 ? (
          <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>휴지통이 비어 있습니다.</Card>
        ) : (
          <Card style={{ padding: 0, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#f9fafb", color: "#6b7280", textAlign: "left" }}>
                  <th style={{ padding: "10px 14px", fontWeight: 600 }}>상품코드</th>
                  <th style={{ padding: "10px 14px", fontWeight: 600 }}>상품명</th>
                  <th style={{ padding: "10px 14px", fontWeight: 600 }}>유형</th>
                  <th style={{ padding: "10px 14px", fontWeight: 600 }}>삭제일</th>
                  <th style={{ padding: "10px 14px", fontWeight: 600 }}>삭제자</th>
                  <th style={{ padding: "10px 14px", fontWeight: 600, textAlign: "right" }}>기능</th>
                </tr>
              </thead>
              <tbody>
                {trashProducts.map(p => (
                  <tr key={p.id} style={{ borderTop: "1px solid #f3f4f6" }} data-testid={`trash-row-${p.id}`}>
                    <td style={{ padding: "10px 14px", fontFamily: "monospace", fontSize: 11, color: "#6b7280" }}>{p.code}</td>
                    <td style={{ padding: "10px 14px", fontWeight: 600, color: "#111827" }}>{p.name}</td>
                    <td style={{ padding: "10px 14px", color: "#374151" }}>{PRODUCT_TYPES_META[p.productType]?.label ?? p.productType}</td>
                    <td style={{ padding: "10px 14px", color: "#6b7280" }}>{p.deletedAt ? new Date(p.deletedAt).toLocaleString("ko-KR") : "-"}</td>
                    <td style={{ padding: "10px 14px", color: "#6b7280" }}>{p.deletedByName || p.deletedByEmail || "-"}</td>
                    <td style={{ padding: "10px 14px", textAlign: "right", whiteSpace: "nowrap" }}>
                      <button onClick={() => handleRestoreProduct(p.id)} disabled={restoringId === p.id}
                        aria-label="상품 복원"
                        data-testid={`product-restore-${p.id}`}
                        style={{ padding: "4px 12px", fontSize: 12, borderRadius: 6, cursor: restoringId === p.id ? "not-allowed" : "pointer", background: "#ecfdf5", color: "#059669", border: "1px solid #a7f3d0", fontWeight: 600, marginRight: 6 }}>
                        {restoringId === p.id ? "복원 중..." : "복원"}
                      </button>
                      {user?.role === "admin" && (
                        <button onClick={() => setDeletingProduct({ id: p.id, code: p.code, name: p.name })}
                          aria-label="상품 완전삭제"
                          title="완전삭제 (복구 불가)"
                          data-testid={`product-purge-${p.id}`}
                          style={{ padding: "4px 12px", fontSize: 12, borderRadius: 6, cursor: "pointer", background: "#fef2f2", color: "#dc2626", border: "1px solid #fecaca", fontWeight: 600 }}>
                          완전삭제
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Section>

      {/* 완전삭제 확인 모달 */}
      {deletingProduct && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1001 }}>
          <Card style={{ width: 420, padding: "28px 32px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <div style={{ width: 40, height: 40, borderRadius: "50%", background: "#fee2e2", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>🗑</div>
              <div>
                <p style={{ margin: 0, fontWeight: 700, fontSize: 16, color: "#111827" }}>상품 완전삭제</p>
                <p style={{ margin: "2px 0 0", fontSize: 12, color: "#9ca3af" }}>삭제 후 복구 불가</p>
              </div>
            </div>
            <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "12px 16px", marginBottom: 16 }}>
              <p style={{ margin: 0, fontSize: 13, color: "#374151" }}>
                <span style={{ fontFamily: "monospace", background: "#e5e7eb", padding: "1px 6px", borderRadius: 4, marginRight: 6 }}>{deletingProduct.code}</span>
                <strong>{deletingProduct.name}</strong>
              </p>
            </div>
            <p style={{ margin: "0 0 6px", fontSize: 13, color: "#dc2626", fontWeight: 600 }}>⚠ 주의사항</p>
            <ul style={{ margin: "0 0 20px", paddingLeft: 18, fontSize: 12, color: "#6b7280", lineHeight: 1.7 }}>
              <li>견적/프로젝트에 사용된 상품은 삭제할 수 없습니다.</li>
              <li>상품 코드는 삭제 후에도 재사용되지 않습니다.</li>
              <li>통번역사 단가 설정이 함께 삭제됩니다.</li>
            </ul>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handlePurgeProduct} disabled={purging}
                style={{ flex: 1, padding: "10px 0", fontSize: 14, borderRadius: 8, cursor: purging ? "not-allowed" : "pointer", background: purging ? "#9ca3af" : "#dc2626", color: "#fff", border: "none", fontWeight: 700 }}>
                {purging ? "삭제 중..." : "완전삭제"}
              </button>
              <GhostBtn onClick={() => setDeletingProduct(null)} style={{ fontSize: 13, padding: "10px 20px" }}>취소</GhostBtn>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
