import React, { useState, useRef, useEffect, useCallback } from "react";
import { LANGUAGE_CODES } from "../../lib/constants";

export type LangSelectMode = "code" | "label";

interface Props {
  value: string;
  onChange: (val: string) => void;
  customValue?: string;
  onCustomChange?: (val: string) => void;
  mode?: LangSelectMode;
  placeholder?: string;
  style?: React.CSSProperties;
  triggerStyle?: React.CSSProperties;
  disabled?: boolean;
}

const OTHER_CODE = "other";
const OTHER_LABEL = "기타 직접입력";

function getLangOptions(mode: LangSelectMode) {
  return LANGUAGE_CODES.map(l => ({
    value: mode === "code" ? l.code : l.label,
    label: l.label,
    code: l.code,
  }));
}

function findLabel(value: string, mode: LangSelectMode): string {
  if (!value) return "";
  const opt = LANGUAGE_CODES.find(l =>
    mode === "code" ? l.code === value : l.label === value,
  );
  return opt?.label ?? value;
}

function isOther(value: string, mode: LangSelectMode): boolean {
  return mode === "code" ? value === OTHER_CODE : value === OTHER_LABEL;
}

export function LanguageSearchSelect({
  value, onChange, customValue = "", onCustomChange,
  mode = "code", placeholder = "언어 선택...",
  style, triggerStyle, disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const options = getLangOptions(mode);
  const q = query.toLowerCase();
  const filtered = q
    ? options.filter(o => o.label.toLowerCase().includes(q))
    : options;

  const selectedLabel = findLabel(value, mode);
  const showCustomInput = isOther(value, mode) && !!onCustomChange;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  useEffect(() => {
    if (!open || highlightIdx < 0 || !listRef.current) return;
    const el = listRef.current.children[highlightIdx] as HTMLElement | undefined;
    el?.scrollIntoView?.({ block: "nearest" });
  }, [highlightIdx, open]);

  const handleOpen = useCallback(() => {
    if (disabled) return;
    setOpen(true);
    setQuery("");
    setHighlightIdx(-1);
  }, [disabled]);

  const handleSelect = useCallback((optValue: string) => {
    onChange(optValue);
    setOpen(false);
    setQuery("");
    setHighlightIdx(-1);
  }, [onChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); setQuery(""); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHighlightIdx(i => Math.min(i + 1, filtered.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setHighlightIdx(i => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter" && highlightIdx >= 0 && highlightIdx < filtered.length) {
      e.preventDefault();
      handleSelect(filtered[highlightIdx].value);
    }
  }, [filtered, highlightIdx, handleSelect]);

  return (
    <div style={{ position: "relative", ...style }}>
      {/* 트리거 버튼 */}
      {!open ? (
        <button
          type="button"
          disabled={disabled}
          onClick={handleOpen}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            width: "100%", padding: "6px 10px", fontSize: 13,
            border: "1px solid #d1d5db", borderRadius: 8, background: disabled ? "#f9fafb" : "#fff",
            color: disabled ? "#9ca3af" : value ? "#111827" : "#9ca3af",
            cursor: disabled ? "not-allowed" : "pointer", outline: "none",
            textAlign: "left", gap: 4, ...triggerStyle,
          }}
        >
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {selectedLabel || placeholder}
          </span>
          <span style={{ fontSize: 8, color: "#9ca3af", flexShrink: 0 }}>▼</span>
        </button>
      ) : (
        /* 검색 입력 (열렸을 때) */
        <div
          style={{
            display: "flex", alignItems: "center",
            border: "1px solid #6366f1", borderRadius: 8, background: "#fff",
            padding: "0 8px", gap: 4,
            ...(triggerStyle ? { ...triggerStyle, border: "1px solid #6366f1" } : {}),
          }}
          onMouseDown={e => e.stopPropagation()}
        >
          <span style={{ fontSize: 12, color: "#9ca3af", flexShrink: 0 }}>🔍</span>
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setHighlightIdx(0); }}
            onKeyDown={handleKeyDown}
            placeholder="언어명 검색..."
            style={{
              flex: 1, border: "none", outline: "none", fontSize: 13,
              padding: "5px 0", background: "transparent", color: "#111827",
              minWidth: 0,
            }}
          />
          <button
            type="button"
            onClick={() => { setOpen(false); setQuery(""); }}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, color: "#9ca3af", padding: "0 2px", flexShrink: 0 }}
          >
            ✕
          </button>
        </div>
      )}

      {/* 드롭다운 리스트 */}
      {open && (
        <div
          ref={listRef}
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: "absolute", zIndex: 10000, top: "calc(100% + 3px)", left: 0,
            width: "100%", minWidth: 180,
            maxHeight: 240, overflowY: "auto",
            background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8,
            boxShadow: "0 4px 20px rgba(0,0,0,0.13)", scrollbarWidth: "thin",
            padding: "4px 0",
          }}
        >
          {filtered.length === 0 ? (
            <div style={{ padding: "8px 12px", fontSize: 12, color: "#9ca3af", textAlign: "center" }}>
              검색 결과 없음
            </div>
          ) : (
            filtered.map((opt, idx) => {
              const isSel = opt.value === value;
              const isHi = idx === highlightIdx;
              const isOtherOpt = opt.code === OTHER_CODE;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onMouseEnter={() => setHighlightIdx(idx)}
                  onMouseLeave={() => setHighlightIdx(-1)}
                  onClick={() => handleSelect(opt.value)}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    width: "100%", textAlign: "left",
                    padding: "5px 12px", fontSize: 13, border: "none",
                    background: isHi ? "#eff6ff" : isSel ? "#f0f9ff" : "transparent",
                    color: isOtherOpt ? "#6b7280" : isSel ? "#1d4ed8" : "#111827",
                    cursor: "pointer", fontWeight: isSel ? 700 : isOtherOpt ? 500 : 400,
                    borderTop: isOtherOpt ? "1px solid #f3f4f6" : "none",
                    fontStyle: isOtherOpt ? "italic" : "normal",
                  }}
                >
                  <span style={{ fontSize: 9, color: "#2563eb", opacity: isSel ? 1 : 0, flexShrink: 0 }}>✓</span>
                  {opt.label}
                  {mode === "code" && !isOtherOpt && (
                    <span style={{ fontSize: 10, color: "#9ca3af", marginLeft: "auto" }}>{opt.code}</span>
                  )}
                </button>
              );
            })
          )}
        </div>
      )}

      {/* 기타 직접입력 필드 */}
      {showCustomInput && isOther(value, mode) && (
        <input
          value={customValue}
          onChange={e => onCustomChange!(e.target.value)}
          placeholder="언어명 직접 입력..."
          style={{
            width: "100%", marginTop: 4, padding: "5px 10px", fontSize: 12,
            border: "1px solid #e5e7eb", borderRadius: 7, outline: "none",
            boxSizing: "border-box", color: "#111827",
          }}
        />
      )}
    </div>
  );
}
