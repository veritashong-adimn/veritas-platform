import React, { useState, useEffect, useRef } from "react";

interface ReviewMemoPanelProps {
  storageKey: string;
  label?: string;
}

export function ReviewMemoPanel({ storageKey, label = "검수 메모" }: ReviewMemoPanelProps) {
  const lsKey = `review_memo__${storageKey}`;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const stored = localStorage.getItem(lsKey) ?? "";
    setText(stored);
  }, [lsKey]);

  useEffect(() => {
    if (open && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [open]);

  const handleSave = () => {
    localStorage.setItem(lsKey, text);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const handleClear = () => {
    if (!confirm("검수 메모를 삭제하시겠습니까?")) return;
    localStorage.removeItem(lsKey);
    setText("");
  };

  const hasContent = text.trim().length > 0;

  return (
    <div style={{ marginBottom: 8 }}>
      {/* 토글 버튼 */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          background: hasContent ? "#fef9c3" : "#f9fafb",
          border: `1px solid ${hasContent ? "#fde047" : "#d1d5db"}`,
          borderRadius: 6, padding: "4px 10px", fontSize: 11,
          fontWeight: 700, color: hasContent ? "#713f12" : "#6b7280",
          cursor: "pointer", transition: "all 0.15s",
        }}
      >
        <span>📝</span>
        <span>{label}</span>
        {hasContent && (
          <span style={{
            background: "#fbbf24", color: "#fff", borderRadius: 10,
            fontSize: 10, padding: "1px 5px", fontWeight: 700,
          }}>작성됨</span>
        )}
        <span style={{ fontSize: 10, color: "#9ca3af" }}>{open ? "▲" : "▼"}</span>
      </button>

      {/* 메모 패널 */}
      {open && (
        <div style={{
          marginTop: 6, padding: "10px 12px",
          background: "#fefce8", border: "1px solid #fde047",
          borderRadius: 8, boxShadow: "0 2px 6px rgba(0,0,0,0.06)",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#713f12" }}>
              🔍 {label} — 운영자 전용 임시 메모 (로컬 저장)
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              {hasContent && (
                <button onClick={handleClear}
                  style={{ fontSize: 10, color: "#dc2626", background: "none", border: "none", cursor: "pointer", padding: "2px 4px" }}>
                  삭제
                </button>
              )}
              <button onClick={() => setOpen(false)}
                style={{ fontSize: 12, color: "#9ca3af", background: "none", border: "none", cursor: "pointer", padding: "2px 4px" }}>
                ✕
              </button>
            </div>
          </div>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={e => { setText(e.target.value); setSaved(false); }}
            placeholder={"이 화면에서 확인이 필요한 항목, 수정 요청 사항, 누락 값 등을 메모하세요.\n예) 거래처 연결 확인 필요 / 견적 금액 재확인 / 통번역사 배정 대기 중..."}
            rows={4}
            style={{
              width: "100%", boxSizing: "border-box",
              border: "1px solid #fde047", borderRadius: 6,
              padding: "8px 10px", fontSize: 12, color: "#374151",
              background: "#fffde7", resize: "vertical", outline: "none",
              fontFamily: "inherit", lineHeight: 1.6,
            }}
            onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") handleSave(); }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
            <span style={{ fontSize: 10, color: "#a16207" }}>Ctrl+Enter로 저장 · 로컬 브라우저에만 저장됩니다</span>
            <button
              onClick={handleSave}
              style={{
                background: saved ? "#16a34a" : "#ca8a04",
                color: "#fff", border: "none", borderRadius: 6,
                padding: "4px 12px", fontSize: 11, fontWeight: 700,
                cursor: "pointer", transition: "background 0.2s",
              }}
            >
              {saved ? "✓ 저장됨" : "저장"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
