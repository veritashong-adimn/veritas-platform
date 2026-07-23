import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/constants";
import { C } from "../../lib/ds";

// ─── 거래처 기업명 Alias(별칭) 관리 ──────────────────────────────────────────
// Tag 기반 별칭 편집 영역. 두 가지 모드를 지원한다(동일 UI·동일 컴포넌트 재사용).
//   1) bound 모드  : companyId 지정 → 서버 CRUD 즉시 반영 (상세 모달 · 수정 화면)
//   2) draft 모드  : value/onChange 로 로컬 문자열 목록만 관리 (등록 화면 — 아직 id 없음)
//                    등록 저장 시 상위(CompanyForm)가 이 목록을 기존 Alias API 로 저장한다.
//
// UI 공통 동작:
//   - Tag 목록 + 각 Tag 우측 ✕ 삭제
//   - "+ 별칭 추가" → inline input → Enter 저장 / Esc 취소
//   - Tag 클릭 → inline 수정 → Enter 저장 / Esc 취소
// 정규화·중복판정·검증은 서버가 단일 기준으로 처리한다(draft 모드는 대소문자 무시 중복만 로컬 차단).

interface Alias {
  id: number;
  companyId: number;
  aliasName: string;
  normalizedAlias: string;
  isPrimary: boolean;
}

/** 렌더 공통 아이템 — bound: 서버 alias, draft: 로컬 문자열(index 를 key 로) */
interface DisplayItem { key: number; name: string; }

export function CompanyAliasSection({ companyId, token, onToast, value, onChange, compact }: {
  /** 지정 시 bound(서버 CRUD) 모드, 미지정 시 draft(로컬) 모드 */
  companyId?: number;
  token: string;
  onToast: (msg: string) => void;
  /** draft 모드 전용: 별칭 문자열 목록(제어 컴포넌트) */
  value?: string[];
  onChange?: (names: string[]) => void;
  /** 등록/수정 폼용 간결 모드 — 내부 헤더('기업명 Alias')·빈 안내문·배경 박스를 숨기고 Tag만 표시 */
  compact?: boolean;
}) {
  const draft = companyId == null;
  const authH = { Authorization: `Bearer ${token}` };
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [loading, setLoading] = useState(!draft);
  const [adding, setAdding] = useState(false);
  const [newValue, setNewValue] = useState("");
  const [editingKey, setEditingKey] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [busy, setBusy] = useState(false);
  const addInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (draft) return;
    setLoading(true);
    try {
      const res = await fetch(api(`/api/admin/companies/${companyId}/aliases`), { headers: authH });
      const data = await res.json();
      if (res.ok) setAliases(Array.isArray(data) ? data : []);
      else onToast(`오류: 별칭 조회 실패 (${res.status})`);
    } catch { onToast("오류: 별칭 조회 실패"); }
    finally { setLoading(false); }
  }, [companyId, token, draft]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (adding) addInputRef.current?.focus(); }, [adding]);
  useEffect(() => { if (editingKey !== null) editInputRef.current?.focus(); }, [editingKey]);

  // 화면에는 사용자가 등록한 별칭(비-Primary)만 노출한다. draft 모드는 value 를 그대로 노출.
  const draftValues = value ?? [];
  const items: DisplayItem[] = draft
    ? draftValues.map((name, i) => ({ key: i, name }))
    : aliases.filter(a => !a.isPrimary).map(a => ({ key: a.id, name: a.aliasName }));

  const startAdd = () => { setNewValue(""); setAdding(true); };
  const cancelAdd = () => { setAdding(false); setNewValue(""); };

  const submitAdd = async () => {
    const name = newValue.trim();
    if (!name) { cancelAdd(); return; }
    if (busy) return;
    if (draft) {
      // 로컬: 대소문자 무시 중복 차단 후 추가. 연속 추가 편의를 위해 입력창 유지.
      const exists = draftValues.some(v => v.toLowerCase() === name.toLowerCase());
      if (!exists) onChange?.([...draftValues, name]);
      setNewValue("");
      addInputRef.current?.focus();
      return;
    }
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

  const startEdit = (it: DisplayItem) => { setEditingKey(it.key); setEditValue(it.name); };
  const cancelEdit = () => { setEditingKey(null); setEditValue(""); };

  const submitEdit = async (it: DisplayItem) => {
    const name = editValue.trim();
    if (!name || name === it.name) { cancelEdit(); return; }
    if (busy) return;
    if (draft) {
      const exists = draftValues.some((v, i) => i !== it.key && v.toLowerCase() === name.toLowerCase());
      if (!exists) onChange?.(draftValues.map((v, i) => i === it.key ? name : v));
      cancelEdit();
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/companies/${companyId}/aliases/${it.key}`), {
        method: "PUT", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ aliasName: name }),
      });
      const data = await res.json();
      if (res.ok) {
        setAliases(prev => prev.map(x => x.id === it.key ? data : x));
        cancelEdit();
      } else {
        onToast(`오류: ${data?.error ?? "별칭 수정 실패"}`);
      }
    } catch { onToast("오류: 별칭 수정 실패"); }
    finally { setBusy(false); }
  };

  const remove = async (it: DisplayItem) => {
    if (draft) {
      onChange?.(draftValues.filter((_, i) => i !== it.key));
      return;
    }
    if (!window.confirm(`별칭 "${it.name}"을(를) 삭제할까요?`)) return;
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/companies/${companyId}/aliases/${it.key}`), { method: "DELETE", headers: authH });
      if (res.ok) setAliases(prev => prev.filter(x => x.id !== it.key));
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

  const containerStyle: React.CSSProperties = compact
    ? {}
    : { marginTop: 10, background: "#f9fafb", borderRadius: 8, padding: "10px 12px", border: "1px solid #f3f4f6" };

  return (
    <div style={containerStyle} data-testid="company-alias-section">
      {/* 간결 모드에서는 상위 폼이 '별칭(Alias)' 라벨을 제공하므로 내부 헤더를 숨긴다. */}
      {!compact && (
        <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          기업명 Alias
        </p>
      )}
      {loading ? (
        <span style={{ fontSize: 12, color: C.g400 }}>불러오는 중…</span>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {/* 공식명 기반 Primary Alias 는 화면에서 숨긴다(DB·검색·자동매칭에서는 그대로 사용). */}
          {items.length === 0 && !compact && <span style={{ fontSize: 12, color: C.g400 }}>등록된 별칭이 없습니다.</span>}
          {items.map(it => editingKey === it.key ? (
            <input
              key={it.key}
              ref={editInputRef}
              value={editValue}
              disabled={busy}
              onChange={e => setEditValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") { e.preventDefault(); submitEdit(it); }
                else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
              }}
              onBlur={() => submitEdit(it)}
              style={inputBase}
              aria-label={`별칭 수정 입력 ${it.name}`}
              data-testid={`alias-edit-input-${it.key}`}
            />
          ) : (
            <span key={it.key} style={tagBase}
              data-testid={`alias-tag-${it.key}`}>
              <span
                onClick={() => startEdit(it)}
                role="button"
                tabIndex={0}
                onKeyDown={e => { if (e.key === "Enter") startEdit(it); }}
                style={{ cursor: "pointer" }}
                aria-label={`별칭 수정 ${it.name}`}
                data-testid={`alias-label-${it.key}`}
                title="클릭하여 수정"
              >
                {it.name}
              </span>
              <button
                onClick={() => remove(it)}
                disabled={busy}
                aria-label={`별칭 삭제 ${it.name}`}
                data-testid={`alias-delete-${it.key}`}
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
                else if (e.key === "Backspace" && newValue === "" && items.length > 0) {
                  // 입력이 비어있을 때 Backspace → 마지막 Tag 삭제
                  e.preventDefault(); remove(items[items.length - 1]);
                }
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
