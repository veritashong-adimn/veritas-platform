import React from "react";
import { DraggableModal } from "./DraggableModal";
import { PrimaryBtn, GhostBtn } from "../ui";

// ─── 공통 스타일 ────────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 14, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};

interface ResetPasswordModalProps {
  userId: number;
  value: string;
  loading: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export function ResetPasswordModal({ userId, value, loading, onChange, onSubmit, onClose }: ResetPasswordModalProps) {
  return (
    <DraggableModal
      title="비밀번호 재설정"
      subtitle={`사용자 #${userId}의 비밀번호를 재설정합니다.`}
      onClose={onClose}
      width={400}
      zIndex={400}
      bodyPadding="20px 28px"
    >
      <input
        type="password"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="새 비밀번호 (최소 6자)"
        onKeyDown={e => e.key === "Enter" && onSubmit()}
        style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 14 }}
        autoFocus
      />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <GhostBtn onClick={onClose}>취소</GhostBtn>
        <PrimaryBtn onClick={onSubmit} disabled={loading || value.length < 6} style={{ padding: "8px 18px" }}>
          {loading ? "처리 중..." : "재설정"}
        </PrimaryBtn>
      </div>
    </DraggableModal>
  );
}
