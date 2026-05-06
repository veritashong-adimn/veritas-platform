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

const CUSTOM_CODE = "custom";
const CUSTOM_LABEL = "기타 직접입력";

type LangOption = { value: string; label: string; code: string };

function getLangOptions(mode: LangSelectMode): LangOption[] {
  return LANGUAGE_CODES.map(l => ({
    value: mode === "code" ? l.code : l.label,
    label: l.label,
    code: l.code,
  }));
}

function findOption(value: string, mode: LangSelectMode): LangOption | undefined {
  return LANGUAGE_CODES.map(l => ({
    value: mode === "code" ? l.code : l.label,
    label: l.label,
    code: l.code,
  })).find(o => o.value === value);
}

function isCustom(value: string, mode: LangSelectMode): boolean {
  return mode === "code" ? value === CUSTOM_CODE : value === CUSTOM_LABEL;
}

export function LanguageSearchSelect({
  value, onChange, customValue = "", onCustomChange,
  mode = "code", placeholder = "언어 선택...",
  style, triggerStyle, disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const customInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const allOptions = getLangOptions(mode);
  const q = query.toLowerCase().trim();
  const filtered = q
    ? allOptions.filter(
        o =>
          o.label.toLowerCase().includes(q) ||
          o.code.toLowerCase().includes(q),
      )
    : allOptions;

  const selected = findOption(value, mode);
  const showTriggerLabel = selected
    ? selected.label
    : value
    ? value
    : "";

  const showCustomInput = isCustom(value, mode) && !!onCustomChange;

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
    if (open && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [open]);

  useEffect(() => {
    if (showCustomInput && customInputRef.current) {
      customInputRef.current.focus();
    }
  }, [showCustomInput]);

  useEffect(() => {
    if (!open || highlightIdx < 0 || !listRef.current) return;
    const el = listRef.current.children[highlightIdx] as HTMLElement | undefined;
    el?.scrollIntoView?.({ block: "nearest" });
  }, [highlightIdx, open]);

  const handleOpen = useCallback(() => {
    if (disabled) return;
    setOpen(true);
    setQuery("");
    setHighlightIdx(0);
  }, [disabled]);

  const handleSelect = useCallback(
    (optValue: string) => {
      onChange(optValue);
      setOpen(false);
      setQuery("");
      setHighlightIdx(0);
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        setQuery("");
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
        setHighlightIdx(i => Math.min(i + 1, filtered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIdx(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" && highlightIdx >= 0 && highlightIdx < filtered.length) {
        e.preventDefault();
        handleSelect(filtered[highlightIdx].value);
      }
    },
    [filtered, highlightIdx, handleSelect],
  );

  const triggerBase: React.CSSProperties = {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    width: "100%", padding: "6px 10px", fontSize: 13,
    border: "1px solid #d1d5db", borderRadius: 8,
    background: disabled ? "#f9fafb" : "#fff",
    color: disabled ? "#9ca3af" : showTriggerLabel ? "#111827" : "#9ca3af",
    cursor: disabled ? "not-allowed" : "pointer",
    outline: "none", textAlign: "left" as const, gap: 4,
  };

  return (
    <div ref={containerRef} style={{ position: "relative", ...style }}>
      {/* ── 트리거 ── */}
      {!open ? (
        <button
          type="button"
          disabled={disabled}
          onClick={handleOpen}
          style={{ ...triggerBase, ...triggerStyle }}
        >
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {showTriggerLabel || placeholder}
          </span>
          {selected && selected.code !== CUSTOM_CODE && (
            <span style={{ fontSize: 10, color: "#9ca3af", fontFamily: "monospace", flexShrink: 0 }}>
              {selected.code}
            </span>
          )}
          <span style={{ fontSize: 8, color: "#9ca3af", flexShrink: 0, marginLeft: 2 }}>▼</span>
        </button>
      ) : (
        /* ── 검색 입력 ── */
        <div
          style={{
            display: "flex", alignItems: "center",
            border: "1px solid #6366f1", borderRadius: 8, background: "#fff",
            padding: "0 8px", gap: 4,
            ...(triggerStyle
              ? { ...triggerStyle, border: "1px solid #6366f1", padding: "0 8px" }
              : {}),
          }}
          onMouseDown={e => e.stopPropagation()}
        >
          <span style={{ fontSize: 11, color: "#9ca3af", flexShrink: 0 }}>🔍</span>
          <input
            ref={searchInputRef}
            value={query}
            onChange={e => {
              setQuery(e.target.value);
              setHighlightIdx(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="언어명 또는 코드 검색..."
            style={{
              flex: 1, border: "none", outline: "none", fontSize: 13,
              padding: "5px 0", background: "transparent", color: "#111827", minWidth: 0,
            }}
          />
          <button
            type="button"
            onClick={() => { setOpen(false); setQuery(""); }}
            style={{
              background: "none", border: "none", cursor: "pointer",
              fontSize: 14, color: "#9ca3af", padding: "0 2px", flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* ── 드롭다운 목록 ── */}
      {open && (
        <div
          ref={listRef}
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: "absolute", zIndex: 10000,
            top: "calc(100% + 3px)", left: 0, width: "100%", minWidth: 200,
            maxHeight: 240, overflowY: "auto",
            background: "#fff", border: "1px solid #e2e8f0",
            borderRadius: 8, boxShadow: "0 4px 20px rgba(0,0,0,0.13)",
            scrollbarWidth: "thin", padding: "4px 0",
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
              const isCustomOpt = opt.code === CUSTOM_CODE;
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
                    color: isCustomOpt ? "#6b7280" : isSel ? "#1d4ed8" : "#111827",
                    cursor: "pointer",
                    fontWeight: isSel ? 700 : 400,
                    borderTop: isCustomOpt ? "1px solid #f3f4f6" : "none",
                    fontStyle: isCustomOpt ? "italic" : "normal",
                  }}
                >
                  <span style={{ fontSize: 9, color: "#2563eb", opacity: isSel ? 1 : 0, flexShrink: 0 }}>
                    ✓
                  </span>
                  <span style={{ flex: 1 }}>{opt.label}</span>
                  {!isCustomOpt && (
                    <span
                      style={{
                        fontSize: 10, color: isHi ? "#64748b" : "#c0c7d3",
                        fontFamily: "monospace", flexShrink: 0,
                      }}
                    >
                      {opt.code}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      )}

      {/* ── 기타 직접입력 필드 ── */}
      {showCustomInput && (
        <div style={{ marginTop: 5 }}>
          <label style={{ fontSize: 11, color: "#6b7280", display: "block", marginBottom: 2 }}>
            직접 입력 언어
          </label>
          <input
            ref={customInputRef}
            value={customValue}
            onChange={e => onCustomChange!(e.target.value)}
            placeholder="예: 카자흐어, 세르비아어..."
            style={{
              width: "100%", padding: "6px 10px", fontSize: 13,
              border: "1px solid #a5b4fc", borderRadius: 7, outline: "none",
              boxSizing: "border-box", color: "#111827",
              background: "#faf5ff",
            }}
          />
        </div>
      )}
    </div>
  );
}
