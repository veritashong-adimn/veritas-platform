import React from "react";
import { AdminContact } from "../../lib/constants";
import { formatPhoneDisplay } from "../../lib/utils";
import { DraggableModal } from "./DraggableModal";

interface ContactMergeModalProps {
  contacts: AdminContact[];
  selectedIds: Set<number>;
  primaryId: number | null;
  merging: boolean;
  onSelectPrimary: (id: number) => void;
  onMerge: () => void;
  onClose: () => void;
}

export function ContactMergeModal({ contacts, selectedIds, primaryId, merging, onSelectPrimary, onMerge, onClose }: ContactMergeModalProps) {
  const selectedContacts = contacts.filter(c => selectedIds.has(c.id));
  return (
    <DraggableModal title="중복 담당자 통합" onClose={onClose} width={680} zIndex={400} bodyPadding="20px 28px">
      <p style={{ margin: "0 0 6px", fontSize: 13, color: "#374151" }}>대표 담당자를 선택하세요.</p>
      <p style={{ margin: "0 0 16px", fontSize: 12, color: "#9ca3af" }}>통합 후 나머지 담당자는 비활성 처리됩니다. 기존 프로젝트 이력은 대표 담당자로 연결됩니다.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
        {selectedContacts.map(c => (
          <label key={c.id} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "12px 14px", borderRadius: 10, border: `2px solid ${primaryId === c.id ? "#2563eb" : "#e5e7eb"}`, background: primaryId === c.id ? "#eff6ff" : "#fff", cursor: "pointer" }}>
            <input type="radio" name="primaryContact" value={c.id}
              checked={primaryId === c.id}
              onChange={() => onSelectPrimary(c.id)}
              style={{ marginTop: 2, accentColor: "#2563eb" }} />
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                <span style={{ fontWeight: 700, fontSize: 14, color: "#111827" }}>{c.name}</span>
                {primaryId === c.id && <span style={{ fontSize: 10, background: "#dbeafe", color: "#1d4ed8", borderRadius: 4, padding: "1px 6px", fontWeight: 700 }}>대표</span>}
                {(c as any).isPrimary && <span style={{ fontSize: 10, background: "#d1fae5", color: "#065f46", borderRadius: 4, padding: "1px 5px", fontWeight: 600 }}>기본담당자</span>}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 16px", fontSize: 12, color: "#6b7280" }}>
                <span>거래처: {c.companyName ?? "-"}</span>
                <span>부서/직책: {[c.department, c.position].filter(Boolean).join(" / ") || "-"}</span>
                <span>휴대폰: {formatPhoneDisplay((c as any).mobile ?? c.phone)}</span>
                <span>이메일: {c.email ?? "-"}</span>
                <span>등록일: {new Date(c.createdAt).toLocaleDateString("ko-KR")}</span>
                <span>ID: #{c.id}</span>
              </div>
            </div>
          </label>
        ))}
      </div>
      {!primaryId && (
        <p style={{ margin: "0 0 12px", fontSize: 12, color: "#dc2626", fontWeight: 600 }}>대표 담당자를 선택해주세요.</p>
      )}
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button onClick={onClose}
          style={{ padding: "10px 20px", borderRadius: 8, border: "1px solid #d1d5db", background: "#f9fafb", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#374151" }}>
          취소
        </button>
        <button onClick={onMerge} disabled={!primaryId || merging}
          style={{ padding: "10px 20px", borderRadius: 8, border: "none", background: primaryId ? "#2563eb" : "#93c5fd", color: "#fff", fontSize: 13, fontWeight: 700, cursor: primaryId ? "pointer" : "not-allowed" }}>
          {merging ? "통합 중..." : `${selectedIds.size}명 통합`}
        </button>
      </div>
    </DraggableModal>
  );
}
