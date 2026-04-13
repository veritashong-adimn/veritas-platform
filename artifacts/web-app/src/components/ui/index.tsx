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

// ─── ClickSelect — 클릭 전환형 드롭다운 (외부 클릭/ESC 에만 닫힘) ─────────────
/**
 * 네이티브 <select>를 대체하는 커스텀 드롭다운 컴포넌트.
 * - 클릭하면 열리고, 바깥 클릭·ESC·항목 선택 시에만 닫힘
 * - hover/blur/포커스 이동으로 닫히지 않음
 * - 키보드: ↑/↓ 탐색, Enter 선택, ESC 닫기
 */
export type ClickSelectOption = { value: string; label: string; disabled?: boolean };

export function ClickSelect({
  options, value, onChange, placeholder, disabled,
  style, triggerStyle, menuStyle,
}: {
  options: ClickSelectOption[];
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
  triggerStyle?: React.CSSProperties;
  menuStyle?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 외부 클릭 감지 (mousedown 기반 — blur 기반이 아님)
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  // 키보드 핸들러
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
      if (highlightIdx >= 0 && highlightIdx < options.length && !options[highlightIdx].disabled) {
        onChange(options[highlightIdx].value);
        setOpen(false);
      }
    }
  }, [open, highlightIdx, options, onChange]);

  // 하이라이트 항목 스크롤 유지
  useEffect(() => {
    if (!open || highlightIdx < 0 || !listRef.current) return;
    const item = listRef.current.children[highlightIdx] as HTMLElement | undefined;
    item?.scrollIntoView?.({ block: "nearest" });
  }, [highlightIdx, open]);

  const selectedLabel = options.find(o => o.value === value)?.label;

  return (
    <div ref={containerRef} style={{ position: "relative", display: "inline-block", ...style }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => { if (!disabled) { setOpen(o => !o); setHighlightIdx(-1); } }}
        onKeyDown={onKeyDown}
        style={{
          display: "flex", alignItems: "center", gap: 6, cursor: disabled ? "not-allowed" : "pointer",
          padding: "5px 8px", borderRadius: 6, border: `1px solid ${open ? "#6366f1" : "#d1d5db"}`,
          background: disabled ? "#f3f4f6" : "#fff", fontSize: 13, color: "#111827", fontWeight: 500,
          outline: "none", whiteSpace: "nowrap", minWidth: 80,
          transition: "border-color 0.15s",
          ...triggerStyle,
        }}
      >
        <span style={{ flex: 1, textAlign: "left" }}>{selectedLabel ?? placeholder ?? "선택..."}</span>
        <span style={{ fontSize: 10, color: "#9ca3af", transition: "transform 0.15s", transform: open ? "rotate(180deg)" : "none" }}>▼</span>
      </button>

      {open && (
        <div ref={listRef} role="listbox"
          style={{
            position: "absolute", top: "calc(100% + 3px)", left: 0, zIndex: 9999,
            background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8,
            boxShadow: "0 8px 28px rgba(0,0,0,0.14)", minWidth: "100%", maxHeight: 240,
            overflowY: "auto", overflowX: "hidden",
            ...menuStyle,
          }}
          onMouseDown={e => e.stopPropagation()}
        >
          {options.map((opt, idx) => {
            const isSelected = opt.value === value;
            const isHighlit = idx === highlightIdx;
            return (
              <div key={opt.value} role="option" aria-selected={isSelected}
                onMouseEnter={() => setHighlightIdx(idx)}
                onMouseLeave={() => setHighlightIdx(-1)}
                onClick={() => { if (!opt.disabled) { onChange(opt.value); setOpen(false); } }}
                style={{
                  padding: "8px 14px", fontSize: 13, cursor: opt.disabled ? "not-allowed" : "pointer",
                  color: opt.disabled ? "#9ca3af" : isSelected ? "#4f46e5" : "#111827",
                  fontWeight: isSelected ? 700 : 400,
                  background: isHighlit ? "#eff6ff" : isSelected ? "#f0fdf4" : "transparent",
                  borderBottom: "1px solid #f9fafb",
                  display: "flex", alignItems: "center", gap: 6,
                  userSelect: "none",
                }}>
                {isSelected && <span style={{ fontSize: 10, color: "#4f46e5" }}>✓</span>}
                {opt.label}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── SearchableSelectShared — SearchableSelect 공통 버전 ─────────────────────
/**
 * 검색 가능한 드롭다운 컴포넌트.
 * - 입력 필드를 통해 항목 검색
 * - 외부 클릭(mousedown) / ESC에만 닫힘 (blur 즉시 닫힘 없음)
 * - 키보드: ↑/↓ 탐색, Enter 선택, ESC 닫기
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
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
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

  const displayValue = open ? query : (selected?.label ?? "");

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlightIdx(i => Math.min(i + 1, filtered.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setHighlightIdx(i => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (highlightIdx >= 0 && highlightIdx < filtered.length) {
        onChange(filtered[highlightIdx].id);
        setQuery("");
        setOpen(false);
      }
    }
  };

  useEffect(() => {
    if (!open || highlightIdx < 0 || !listRef.current) return;
    const item = listRef.current.children[highlightIdx] as HTMLElement | undefined;
    item?.scrollIntoView?.({ block: "nearest" });
  }, [highlightIdx, open]);

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <div style={{
        display: "flex", alignItems: "center",
        border: `1px solid ${open ? accentBorder : "#d1d5db"}`,
        borderRadius: 8, background: "#fff", transition: "border-color 0.15s",
      }}>
        <input
          value={displayValue}
          onChange={e => { setQuery(e.target.value); setOpen(true); setHighlightIdx(-1); }}
          onFocus={() => { setOpen(true); if (selected) setQuery(""); }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? "이름으로 검색..."}
          style={{ flex: 1, padding: "9px 12px", fontSize: 14, border: "none", outline: "none", background: "transparent", borderRadius: 8, minWidth: 0 }}
        />
        {value != null && (
          <button type="button" onClick={() => { onChange(null); setQuery(""); setOpen(false); }}
            style={{ padding: "0 10px", fontSize: 18, lineHeight: 1, color: "#9ca3af", background: "none", border: "none", cursor: "pointer", flexShrink: 0 }}>×</button>
        )}
        <span
          onClick={() => setOpen(o => !o)}
          style={{ padding: "0 10px", color: "#9ca3af", fontSize: 12, flexShrink: 0, userSelect: "none", cursor: "pointer" }}
        >{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div ref={listRef} style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0,
          background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8,
          boxShadow: "0 6px 24px rgba(0,0,0,0.12)", zIndex: 600, maxHeight: 224, overflowY: "auto",
        }}
          onMouseDown={e => e.stopPropagation()}
        >
          {filtered.length === 0
            ? <p style={{ margin: 0, padding: "10px 14px", fontSize: 13, color: "#9ca3af" }}>검색 결과 없음</p>
            : filtered.map((item, idx) => {
              const isHighlit = idx === highlightIdx;
              return (
                <button key={item.id} type="button"
                  onMouseEnter={() => setHighlightIdx(idx)}
                  onMouseLeave={() => setHighlightIdx(-1)}
                  onClick={() => { onChange(item.id); setQuery(""); setOpen(false); }}
                  style={{
                    display: "block", width: "100%", textAlign: "left", padding: "9px 14px", fontSize: 13,
                    color: "#111827", background: isHighlit ? "#eff6ff" : item.id === value ? "#f0fdf4" : "transparent",
                    border: "none", borderBottom: "1px solid #f3f4f6", cursor: "pointer",
                  }}>
                  <span style={{ fontWeight: 600 }}>{item.label}</span>
                  {item.sub && <span style={{ marginLeft: 8, fontSize: 11, color: "#6b7280" }}>{item.sub}</span>}
                </button>
              );
            })
          }
        </div>
      )}
    </div>
  );
}
