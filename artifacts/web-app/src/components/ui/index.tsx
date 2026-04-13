import React, { useState, useRef, useEffect, useCallback } from "react";
import { STATUS_LABEL, STATUS_STYLE, ROLE_LABEL, ROLE_STYLE, Role } from "../../lib/constants";

export const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", border: "1px solid #e5e7eb", borderRadius: 8,
  fontSize: 14, outline: "none", boxSizing: "border-box", background: "#fff",
};
export const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 5,
};
export const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 700, color: "#6b7280",
  textTransform: "uppercase", letterSpacing: "0.06em",
  margin: "20px 0 10px", paddingBottom: 6, borderBottom: "1px solid #f3f4f6",
};

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLE[status] ?? { background: "#f3f4f6", color: "#6b7280" };
  return (
    <span style={{
      ...style, display: "inline-block", padding: "3px 10px",
      borderRadius: 20, fontSize: 12, fontWeight: 700, whiteSpace: "nowrap",
    }}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function RoleBadge({ role }: { role: Role }) {
  return (
    <span style={{
      ...ROLE_STYLE[role], padding: "2px 9px", borderRadius: 12,
      fontSize: 11, fontWeight: 700,
    }}>
      {ROLE_LABEL[role]}
    </span>
  );
}

export function Toast({ msg, onClose }: { msg: string; onClose: () => void }) {
  if (!msg) return null;
  const isError = msg.startsWith("오류");
  return (
    <div style={{
      position: "fixed", bottom: 24, right: 24, zIndex: 9999,
      background: isError ? "#fef2f2" : "#f0fdf4",
      border: `1px solid ${isError ? "#fecaca" : "#bbf7d0"}`,
      color: isError ? "#dc2626" : "#059669",
      padding: "12px 20px", borderRadius: 12, boxShadow: "0 4px 20px rgba(0,0,0,0.12)",
      fontSize: 14, fontWeight: 600, display: "flex", gap: 10, alignItems: "center",
    }}>
      <span>{isError ? "⚠️" : "✅"} {msg}</span>
      <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "inherit", lineHeight: 1, padding: 0 }}>×</button>
    </div>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14,
      padding: "20px 22px", boxShadow: "0 1px 3px rgba(0,0,0,0.07)", ...style,
    }}>
      {children}
    </div>
  );
}

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  color?: string;
  children: React.ReactNode;
};

export function PrimaryBtn({ children, style, color, disabled, ...rest }: BtnProps) {
  const bg = color ?? "#2563eb";
  return (
    <button
      disabled={disabled}
      style={{
        background: disabled ? "#d1d5db" : bg,
        color: "#fff", border: "none", borderRadius: 8,
        padding: "8px 18px", fontSize: 14, fontWeight: 700,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 0.15s",
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

export function GhostBtn({ children, style, color, disabled, ...rest }: BtnProps) {
  const c = color ?? "#374151";
  return (
    <button
      disabled={disabled}
      style={{
        background: "transparent", color: disabled ? "#9ca3af" : c,
        border: `1px solid ${disabled ? "#e5e7eb" : c + "60"}`,
        borderRadius: 8, padding: "8px 18px", fontSize: 14, fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer", transition: "all 0.15s",
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ margin: "0 0 14px", fontSize: 16, fontWeight: 800, color: "#111827" }}>{title}</h2>
      {children}
    </div>
  );
}

export function FilterPill({
  label, active, onClick,
}: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "5px 14px", borderRadius: 20, fontSize: 13, fontWeight: active ? 700 : 500,
        cursor: "pointer", border: "1px solid", transition: "all 0.12s",
        borderColor: active ? "#2563eb" : "#e5e7eb",
        background: active ? "#2563eb" : "#fff",
        color: active ? "#fff" : "#6b7280",
      }}
    >
      {label}
    </button>
  );
}

export function ModalOverlay({ children, onClose, maxWidth = 780 }: {
  children: React.ReactNode; onClose?: () => void; maxWidth?: number;
}) {
  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        zIndex: 300, overflowY: "auto", padding: "20px 16px",
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div style={{
        background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb",
        width: "100%", maxWidth, padding: "24px 28px",
        boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
      }}>
        {children}
      </div>
    </div>
  );
}

// ─── 드롭다운 공통 디자인 토큰 ──────────────────────────────────────────────────
const CS = {
  trigger: {
    fontSize: 13, padding: "5px 10px", borderRadius: 6, border: "1px solid #d1d5db",
    background: "#fff", color: "#111827", fontWeight: 500, outline: "none",
    display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
    whiteSpace: "nowrap" as const, minWidth: 0, transition: "border-color 0.12s",
  },
  menu: {
    position: "absolute" as const, zIndex: 9999, top: "calc(100% + 2px)", left: 0,
    minWidth: "100%", maxHeight: 208, overflowY: "auto" as const, overflowX: "hidden" as const,
    background: "#fff", border: "1px solid #e2e8f0", borderRadius: 7,
    boxShadow: "0 4px 18px rgba(0,0,0,0.10)", scrollbarWidth: "thin" as const,
  },
  item: {
    padding: "5px 10px", fontSize: 12, cursor: "pointer",
    userSelect: "none" as const, transition: "background 0.08s",
    borderBottom: "1px solid #f8fafc",
  },
  chevron: { fontSize: 9, color: "#94a3b8", flexShrink: 0, lineHeight: 1 },
} as const;

// ─── ClickSelect ─────────────────────────────────────────────────────────────
/**
 * 네이티브 <select> 대체 컴포넌트 (플랫폼 전역 표준 드롭다운)
 *
 * 동작: 클릭 열림 · 같은 버튼 클릭 닫힘 · 외부 mousedown 닫힘 · ESC 닫힘 · 항목 선택 닫힘
 * 키보드: ↑↓ 탐색, Enter 선택, ESC 닫기
 * sub: 항목 설명 보조 텍스트 (작은 회색, 이름 오른쪽 또는 아래줄 표시)
 */
export type ClickSelectOption = {
  value: string;
  label: string;
  sub?: string;
  disabled?: boolean;
};

export function ClickSelect({
  options, value, onChange, placeholder, disabled,
  style, triggerStyle, menuStyle, openUp = false,
}: {
  options: ClickSelectOption[];
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
  triggerStyle?: React.CSSProperties;
  menuStyle?: React.CSSProperties;
  openUp?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMD = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onMD);
    return () => document.removeEventListener("mousedown", onMD);
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHighlightIdx(0); }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlightIdx(i => Math.min(i + 1, options.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setHighlightIdx(i => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (highlightIdx >= 0 && !options[highlightIdx]?.disabled) {
        onChange(options[highlightIdx].value); setOpen(false);
      }
    }
  }, [open, highlightIdx, options, onChange]);

  useEffect(() => {
    if (!open || highlightIdx < 0 || !listRef.current) return;
    (listRef.current.children[highlightIdx] as HTMLElement | undefined)?.scrollIntoView?.({ block: "nearest" });
  }, [highlightIdx, open]);

  const selected = options.find(o => o.value === value);

  const menuPos = openUp
    ? { bottom: "calc(100% + 2px)", top: "auto" }
    : { top: "calc(100% + 2px)" };

  return (
    <div ref={containerRef} style={{ position: "relative", display: "inline-block", ...style }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => { if (!disabled) { setOpen(o => !o); setHighlightIdx(-1); } }}
        onKeyDown={onKeyDown}
        style={{
          ...CS.trigger,
          border: `1px solid ${open ? "#6366f1" : "#d1d5db"}`,
          background: disabled ? "#f9fafb" : "#fff",
          cursor: disabled ? "not-allowed" : "pointer",
          color: disabled ? "#9ca3af" : "#111827",
          ...triggerStyle,
        }}
      >
        <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis" }}>
          {selected?.label ?? placeholder ?? "선택..."}
        </span>
        <span style={{ ...CS.chevron, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.12s" }}>▼</span>
      </button>

      {open && (
        <div ref={listRef} role="listbox"
          style={{ ...CS.menu, ...menuPos, ...menuStyle }}
          onMouseDown={e => e.stopPropagation()}
        >
          {options.map((opt, idx) => {
            const isSel = opt.value === value;
            const isHi = idx === highlightIdx;
            return (
              <div key={opt.value} role="option" aria-selected={isSel}
                onMouseEnter={() => setHighlightIdx(idx)}
                onMouseLeave={() => setHighlightIdx(-1)}
                onClick={() => { if (!opt.disabled) { onChange(opt.value); setOpen(false); } }}
                style={{
                  ...CS.item,
                  color: opt.disabled ? "#cbd5e1" : "#111827",
                  background: isHi ? "#eff6ff" : isSel ? "#f0f9ff" : "transparent",
                  cursor: opt.disabled ? "not-allowed" : "pointer",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  {isSel && <span style={{ fontSize: 9, color: "#2563eb", flexShrink: 0 }}>✓</span>}
                  <span style={{ fontWeight: isSel ? 600 : 400, color: isSel ? "#1d4ed8" : "inherit" }}>
                    {opt.label}
                  </span>
                  {opt.sub && !isSel && (
                    <span style={{ fontSize: 10, color: "#94a3b8", marginLeft: 2 }}>{opt.sub}</span>
                  )}
                </div>
                {opt.sub && isSel && (
                  <div style={{ fontSize: 10, color: "#64748b", marginTop: 1, paddingLeft: 14 }}>{opt.sub}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── SearchableSelectShared ───────────────────────────────────────────────────
/**
 * 검색 가능한 드롭다운 (플랫폼 전역 표준)
 * 동작: 클릭/포커스로 열림 · 외부 mousedown·ESC에만 닫힘 (blur 닫힘 없음)
 * 키보드: ↑↓ 탐색, Enter 선택, ESC 닫기
 */
export type SSItemShared = { id: number; label: string; sub?: string };

export function SearchableSelectShared({
  items, value, onChange, placeholder, accentBorder = "#6366f1", maxResults = 20,
}: {
  items: SSItemShared[];
  value: number | null;
  onChange: (id: number | null) => void;
  placeholder?: string;
  accentBorder?: string;
  maxResults?: number;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { const t = setTimeout(() => setDebounced(query), 250); return () => clearTimeout(t); }, [query]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const selected = value != null ? items.find(i => i.id === value) : null;
  const q = debounced.toLowerCase();
  const filtered = (q
    ? items.filter(i => i.label.toLowerCase().includes(q) || (i.sub ?? "").toLowerCase().includes(q))
    : items
  ).slice(0, maxResults);

  useEffect(() => {
    if (!open || highlightIdx < 0 || !listRef.current) return;
    (listRef.current.children[highlightIdx] as HTMLElement | undefined)?.scrollIntoView?.({ block: "nearest" });
  }, [highlightIdx, open]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHighlightIdx(i => Math.min(i + 1, filtered.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setHighlightIdx(i => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (highlightIdx >= 0 && highlightIdx < filtered.length) { onChange(filtered[highlightIdx].id); setQuery(""); setOpen(false); setHighlightIdx(-1); }
    }
  };

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <div style={{
        display: "flex", alignItems: "center",
        border: `1px solid ${open ? accentBorder : "#d1d5db"}`,
        borderRadius: 8, background: "#fff", transition: "border-color 0.12s",
      }}>
        <input
          value={open ? query : (selected?.label ?? "")}
          onChange={e => { setQuery(e.target.value); setOpen(true); setHighlightIdx(-1); }}
          onFocus={() => { setOpen(true); if (selected) setQuery(""); }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? "이름으로 검색..."}
          style={{ flex: 1, padding: "8px 10px", fontSize: 13, border: "none", outline: "none", background: "transparent", borderRadius: 8, minWidth: 0 }}
        />
        {value != null && (
          <button type="button" onClick={() => { onChange(null); setQuery(""); setOpen(false); }}
            style={{ padding: "0 8px", fontSize: 16, lineHeight: 1, color: "#94a3b8", background: "none", border: "none", cursor: "pointer", flexShrink: 0 }}>×</button>
        )}
        <span onClick={() => setOpen(o => !o)}
          style={{ padding: "0 8px", color: "#94a3b8", fontSize: 10, flexShrink: 0, userSelect: "none", cursor: "pointer" }}>
          {open ? "▲" : "▼"}
        </span>
      </div>
      {open && (
        <div ref={listRef}
          style={{ ...CS.menu, position: "absolute", top: "calc(100% + 3px)", left: 0, right: 0, minWidth: "unset" }}
          onMouseDown={e => e.stopPropagation()}
        >
          {filtered.length === 0
            ? <p style={{ margin: 0, padding: "8px 10px", fontSize: 12, color: "#94a3b8" }}>검색 결과 없음</p>
            : filtered.map((item, idx) => {
              const isHi = idx === highlightIdx;
              return (
                <button key={item.id} type="button"
                  onMouseEnter={() => setHighlightIdx(idx)}
                  onMouseLeave={() => setHighlightIdx(-1)}
                  onClick={() => { onChange(item.id); setQuery(""); setOpen(false); setHighlightIdx(-1); }}
                  style={{
                    display: "block", width: "100%", textAlign: "left",
                    padding: "5px 10px", fontSize: 12,
                    color: "#111827", background: isHi ? "#eff6ff" : item.id === value ? "#f0f9ff" : "transparent",
                    border: "none", borderBottom: "1px solid #f8fafc", cursor: "pointer",
                  }}>
                  <span style={{ fontWeight: 600 }}>{item.label}</span>
                  {item.sub && <span style={{ marginLeft: 6, fontSize: 10, color: "#94a3b8" }}>{item.sub}</span>}
                </button>
              );
            })
          }
        </div>
      )}
    </div>
  );
}
