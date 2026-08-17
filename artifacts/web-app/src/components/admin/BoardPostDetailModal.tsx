import React from "react";
import { BoardPost, BOARD_CATEGORY_LABEL } from "../../lib/constants";
import { DraggableModal } from "./DraggableModal";

interface BoardPostDetailModalProps {
  post: BoardPost;
  onClose: () => void;
  onDelete: (id: number) => void;
}

export function BoardPostDetailModal({ post, onClose, onDelete }: BoardPostDetailModalProps) {
  return (
    <DraggableModal
      title={post.title}
      subtitle={`${post.authorEmail} · ${new Date(post.createdAt).toLocaleDateString("ko-KR")}`}
      onClose={onClose}
      width={680}
      zIndex={300}
      bodyPadding="20px 28px"
      headerExtra={
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {post.pinned && <span style={{ background: "#fef3c7", color: "#d97706", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10 }}>📌 고정</span>}
          <span style={{ background: "#eff6ff", color: "#2563eb", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10 }}>{BOARD_CATEGORY_LABEL[post.category] ?? post.category}</span>
          {post.visibleToAll && <span style={{ background: "#f0fdf4", color: "#059669", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10 }}>공개</span>}
        </div>
      }
    >
      <div style={{ background: "#f9fafb", borderRadius: 10, padding: "16px 18px", fontSize: 14, color: "#374151", lineHeight: 1.7, whiteSpace: "pre-wrap", marginBottom: 16, border: "1px solid #e5e7eb" }}>
        {post.content ?? "내용 없음"}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={() => onDelete(post.id)} style={{ background: "#fee2e2", color: "#dc2626", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>삭제</button>
      </div>
    </DraggableModal>
  );
}
