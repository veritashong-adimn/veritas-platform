import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/constants";
import { C } from "../../lib/ds";

// ─── 거래처 기업명 Alias(별칭) 관리 ──────────────────────────────────────────
// 거래처 상세 "기본정보" 아래에 표시되는 Tag 기반 별칭 CRUD 영역.
//   - Tag 목록 + 각 Tag 우측 ✕ 삭제
//   - "+ 별칭 추가" → inline input → Enter 저장 / Esc 취소
//   - Tag 클릭 → inline 수정 → Enter 저장 / Esc 취소
// 정규화·중복판정·검증은 서버가 단일 기준으로 처리하고, 여기서는 결과만 반영한다.

interface Alias {
  id: number;
  companyId: number;
  aliasName: string;
  normalizedAlias: string;
  isPrimary: boolean;
}

export function CompanyAliasSection({ companyId, token, onToast }: {
  companyId: number;
  token: string;
  onToast: (msg: string) => void;
}) {
  const authH = { Authorization: `Bearer ${token}` };
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newValue, setNewValue] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [busy, setBusy] = useState(false);
  const addInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(api(`/api/admin/companies/${companyId}/aliases`), { headers: authH });
      const data = await res.json();
      if (res.ok) setAliases(Array.isArray(data) ? data : []);
      else onToast(`오류: 별칭 조회 실패 (${res.status})`);
    } catch { onToast("오류: 별칭 조회 실패"); }
    finally { setLoading(false); }
  }, [companyId, token]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (adding) addInputRef.current?.focus(); }, [adding]);
  useEffect(() => { if (editingId !== null) editInputRef.current?.focus(); }, [editingId]);

  // 화면에는 사용자가 등록한 별칭(비-Primary)만 노출한다.
  const visibleAliases = aliases.filter(a => !a.isPrimary);

  const startAdd = () => { setNewValue(""); setAdding(true); };
  const cancelAdd = () => { setAdding(false); setNewValue(""); };

  const submitAdd = async () => {
    const name = newValue.trim();
    if (!name) { cancelAdd(); return; }
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/companies/${companyId}/aliases`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ aliasName: name }),
      });
      const data = await res.json();
      if (res.ok) {
        setAliases(prev => [...prev, data]);
        setNewValue("");
        // 연속 추가 편의를 위해 입력창 유지
        addInputRef.current?.focus();
      } else {
        onToast(`오류: ${data?.error ?? "별칭 등록 실패"}`);
      }
    } catch { onToast("오류: 별칭 등록 실패"); }
    finally { setBusy(false); }
  };

  const startEdit = (a: Alias) => { setEditingId(a.id); setEditValue(a.aliasName); };
  const cancelEdit = () => { setEditingId(null); setEditValue(""); };

  const submitEdit = async (a: Alias) => {
    const name = editValue.trim();
    if (!name || name === a.aliasName) { cancelEdit(); return; }
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/companies/${companyId}/aliases/${a.id}`), {
        method: "PUT", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ aliasName: name }),
      });
      const data = await res.json();
      if (res.ok) {
        setAliases(prev => prev.map(x => x.id === a.id ? data : x));
        cancelEdit();
      } else {
        onToast(`오류: ${data?.error ?? "별칭 수정 실패"}`);
      }
    } catch { onToast("오류: 별칭 수정 실패"); }
    finally { setBusy(false); }
  };

  const remove = async (a: Alias) => {
    if (!window.confirm(`별칭 "${a.aliasName}"을(를) 삭제할까요?`)) return;
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/companies/${companyId}/aliases/${a.id}`), { method: "DELETE", headers: authH });
      if (res.ok) setAliases(prev => prev.filter(x => x.id !== a.id));
      else { const d = await res.json().catch(() => ({})); onToast(`오류: ${d?.error ?? "별칭 삭제 실패"}`); }
    } catch { onToast("오류: 별칭 삭제 실패"); }
    finally { setBusy(false); }
  };

  const tagBase: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 6, height: 28,
    padding: "0 6px 0 10px", borderRadius: 14, fontSize: 12, fontWeight: 600,
    border: `1px solid ${C.g200}`, background: C.white, color: C.g700,
  };
  const inputBase: React.CSSProperties = {
    height: 28, padding: "0 10px", borderRadius: 14, fontSize: 12,
    border: `1px solid ${C.primaryBorder}`, outline: "none", minWidth: 120, color: C.g700,
  };

  return (
    <div style={{ marginTop: 10, background: "#f9fafb", borderRadius: 8, padding: "10px 12px", border: "1px solid #f3f4f6" }}
      data-testid="company-alias-section">
      <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>
        기업명 Alias
      </p>
      {loading ? (
        <span style={{ fontSize: 12, color: C.g400 }}>불러오는 중…</span>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {/* 공식명 기반 Primary Alias 는 화면에서 숨긴다(DB·검색·자동매칭에서는 그대로 사용). */}
          {visibleAliases.length === 0 && <span style={{ fontSize: 12, color: C.g400 }}>등록된 별칭이 없습니다.</span>}
          {visibleAliases.map(a => editingId === a.id ? (
            <input
              key={a.id}
              ref={editInputRef}
              value={editValue}
              disabled={busy}
              onChange={e => setEditValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") { e.preventDefault(); submitEdit(a); }
                else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
              }}
              onBlur={() => submitEdit(a)}
              style={inputBase}
              aria-label={`별칭 수정 입력 ${a.aliasName}`}
              data-testid={`alias-edit-input-${a.id}`}
            />
          ) : (
            <span key={a.id} style={tagBase}
              data-testid={`alias-tag-${a.id}`}>
              <span
                onClick={() => startEdit(a)}
                role="button"
                tabIndex={0}
                onKeyDown={e => { if (e.key === "Enter") startEdit(a); }}
                style={{ cursor: "pointer" }}
                aria-label={`별칭 수정 ${a.aliasName}`}
                data-testid={`alias-label-${a.id}`}
                title="클릭하여 수정"
              >
                {a.aliasName}
              </span>
              <button
                onClick={() => remove(a)}
                disabled={busy}
                aria-label={`별칭 삭제 ${a.aliasName}`}
                data-testid={`alias-delete-${a.id}`}
                style={{ border: "none", background: "transparent", cursor: "pointer", color: C.g400, fontSize: 14, lineHeight: 1, padding: "2px 4px", borderRadius: 8 }}
              >×</button>
            </span>
          ))}

          {adding ? (
            <input
              ref={addInputRef}
              value={newValue}
              disabled={busy}
              onChange={e => setNewValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") { e.preventDefault(); submitAdd(); }
                else if (e.key === "Escape") { e.preventDefault(); cancelAdd(); }
              }}
              onBlur={() => { if (!newValue.trim()) cancelAdd(); }}
              placeholder="별칭 입력 후 Enter"
              style={inputBase}
              aria-label="새 별칭 입력"
              data-testid="alias-add-input"
            />
          ) : (
            <button
              onClick={startAdd}
              aria-label="별칭 추가"
              data-testid="alias-add-button"
              style={{ ...tagBase, padding: "0 10px", cursor: "pointer", borderStyle: "dashed", color: C.primaryText, borderColor: C.primaryBorder, background: C.white }}
            >+ 별칭 추가</button>
          )}
        </div>
      )}
    </div>
  );
}

export default CompanyAliasSection;
