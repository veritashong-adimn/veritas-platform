import React, { useCallback, useEffect, useState } from "react";
import { formatDisplayDate } from '../../lib/dateFormat';
import { api, BoardPost, BOARD_CATEGORY_LABEL } from "../../lib/constants";
import { DraggableModal } from "./DraggableModal";
import { confirmDialog } from "../ui";
import { StaffTargetPicker, BoardFilePicker, uploadBoardFiles, downloadBoardFile, staffLabel, fmtSize } from "./BoardStaffOnly";

interface BoardPostDetailModalProps {
  post: BoardPost;
  onClose: () => void;
  onDelete: (id: number) => void;
  // (2026-11-22) 상세 조회(본문·첨부)·직원전용 관리용 — 전달되지 않으면 기존처럼 목록 값만 표시
  token?: string;
  isAdmin?: boolean;
  onToast?: (m: string) => void;
  onChanged?: () => void;
}

const badge = (bg: string, color: string): React.CSSProperties => ({ background: bg, color, fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10 });
const box: React.CSSProperties = { width: "100%", boxSizing: "border-box", fontSize: 13, padding: "7px 10px", borderRadius: 8, border: "1px solid #d1d5db" };
const btn = (bg: string, color: string): React.CSSProperties => ({ background: bg, color, border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" });

export function BoardPostDetailModal({ post: initial, onClose, onDelete, token, isAdmin = false, onToast, onChanged }: BoardPostDetailModalProps) {
  const [post, setPost] = useState<BoardPost>(initial);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ title: string; content: string; targets: number[] } | null>(null);
  const [newFiles, setNewFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const staffOnly = post.category === "staff_only";
  const canManage = !staffOnly || isAdmin;   // 직원전용은 관리자만 수정·삭제(서버도 동일 차단)
  const toast = (m: string) => onToast?.(m);

  const load = useCallback(async () => {
    if (!token) return;
    const r = await fetch(api(`/api/admin/board/${initial.id}`), { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json().catch(() => ({}));
    if (r.ok) { setPost(d); setLoadErr(null); } else setLoadErr(d.error ?? "게시글을 불러오지 못했습니다.");
  }, [token, initial.id]);
  useEffect(() => { void load(); }, [load]);

  const saveEdit = async () => {
    if (!token || !edit) return;
    if (!edit.title.trim() || !edit.content.trim()) { toast("제목과 내용을 입력하세요."); return; }
    if (staffOnly && edit.targets.length === 0) { toast("대상 직원을 1명 이상 선택하세요."); return; }
    setBusy(true);
    try {
      const r = await fetch(api(`/api/admin/board/${post.id}`), {
        method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: edit.title, content: edit.content, ...(staffOnly ? { targetUserIds: edit.targets } : {}) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast(`오류: ${d.error ?? "수정 실패"}`); return; }
      setEdit(null); toast("게시물이 수정되었습니다."); await load(); onChanged?.();
    } finally { setBusy(false); }
  };
  const addFiles = async () => {
    if (!token || !newFiles.length) return;
    setBusy(true);
    try {
      const e = await uploadBoardFiles(token, post.id, newFiles);
      if (e) { toast(`오류: ${e}`); return; }
      setNewFiles([]); toast("첨부파일이 등록되었습니다."); await load(); onChanged?.();
    } finally { setBusy(false); }
  };
  const removeFile = async (f: { id: number; originalFileName: string }) => {
    if (!token) return;
    if (!(await confirmDialog({ title: "첨부파일 삭제", message: `${f.originalFileName} 파일을 삭제하시겠습니까?`, confirmLabel: "삭제", variant: "danger" }))) return;
    const r = await fetch(api(`/api/admin/board/${post.id}/files/${f.id}`), { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(`오류: ${d.error ?? "삭제 실패"}`); return; }
    toast("첨부파일이 삭제되었습니다."); await load(); onChanged?.();
  };
  const download = async (f: { id: number; originalFileName: string }) => {
    if (!token) return;
    const e = await downloadBoardFile(token, post.id, f);
    if (e) toast(`오류: ${e}`);
  };

  return (
    <DraggableModal
      title={post.title}
      subtitle={`${post.authorEmail} · ${formatDisplayDate(post.createdAt)}`}
      onClose={onClose}
      width={680}
      zIndex={300}
      bodyPadding="20px 28px"
      headerExtra={
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {post.pinned && <span style={badge("#fef3c7", "#d97706")}>📌 고정</span>}
          <span style={badge(staffOnly ? "#eef2ff" : "#eff6ff", staffOnly ? "#4338ca" : "#2563eb")}>{BOARD_CATEGORY_LABEL[post.category] ?? post.category}</span>
          {post.visibleToAll && <span style={badge("#f0fdf4", "#059669")}>공개</span>}
        </div>
      }
    >
      {loadErr && <div role="alert" style={{ color: "#b91c1c", fontSize: 13, marginBottom: 10 }}>{loadErr}</div>}
      {edit ? (
        <div style={{ display: "grid", gap: 10, marginBottom: 16 }} data-testid="board-edit-form">
          <input value={edit.title} onChange={e => setEdit({ ...edit, title: e.target.value })} style={box} aria-label="제목" data-testid="board-edit-title" />
          <textarea value={edit.content} onChange={e => setEdit({ ...edit, content: e.target.value })} rows={6} style={{ ...box, resize: "vertical" }} aria-label="내용" data-testid="board-edit-content" />
          {staffOnly && token && (
            <div>
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>대상 직원 *</div>
              <StaffTargetPicker token={token} value={edit.targets} known={post.targets ?? []} onChange={ids => setEdit({ ...edit, targets: ids })} />
            </div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setEdit(null)} disabled={busy} style={btn("#f3f4f6", "#374151")} data-testid="board-edit-cancel" aria-label="수정 취소">취소</button>
            <button onClick={saveEdit} disabled={busy} style={btn("#2563eb", "#fff")} data-testid="board-edit-save" aria-label="수정 저장">{busy ? "저장 중…" : "저장"}</button>
          </div>
        </div>
      ) : (
        <div style={{ background: "#f9fafb", borderRadius: 10, padding: "16px 18px", fontSize: 14, color: "#374151", lineHeight: 1.7, whiteSpace: "pre-wrap", marginBottom: 16, border: "1px solid #e5e7eb" }}>
          {post.content ?? "내용 없음"}
        </div>
      )}

      {staffOnly && isAdmin && !edit && (
        <div style={{ fontSize: 13, color: "#374151", marginBottom: 12 }} data-testid="board-targets">
          <b style={{ fontSize: 12, color: "#6b7280" }}>대상 직원</b>{" "}
          {(post.targets ?? []).length ? (post.targets ?? []).map(staffLabel).join(", ") : "—"}
        </div>
      )}

      {(staffOnly || (post.files ?? []).length > 0) && (
        <div style={{ marginBottom: 16 }} data-testid="board-files">
          <div style={{ fontSize: 12, color: "#6b7280", fontWeight: 700, marginBottom: 6 }}>첨부파일 {(post.files ?? []).length}개</div>
          {(post.files ?? []).map(f => (
            <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, padding: "4px 0" }}>
              <button onClick={() => download(f)} data-testid={`board-file-download-${f.id}`} aria-label={`${f.originalFileName} 다운로드`}
                style={{ border: "none", background: "transparent", color: "#2563eb", cursor: "pointer", fontSize: 13, padding: 0, textAlign: "left" }}>📎 {f.originalFileName}</button>
              <span style={{ color: "#9ca3af", fontSize: 11 }}>{fmtSize(f.fileSize)}</span>
              {staffOnly && isAdmin && (
                <button onClick={() => removeFile(f)} data-testid={`board-file-delete-${f.id}`} aria-label={`${f.originalFileName} 삭제`}
                  style={{ border: "none", background: "transparent", color: "#dc2626", cursor: "pointer", fontSize: 12 }}>삭제</button>
              )}
            </div>
          ))}
          {staffOnly && isAdmin && (
            <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
              <BoardFilePicker files={newFiles} onChange={setNewFiles} testId="board-detail-file-input" />
              {newFiles.length > 0 && <button onClick={addFiles} disabled={busy} style={btn("#eef2ff", "#4338ca")} data-testid="board-file-upload" aria-label="첨부파일 추가">{busy ? "업로드 중…" : `${newFiles.length}개 첨부`}</button>}
            </div>
          )}
        </div>
      )}

      {canManage && !edit && (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {staffOnly && token && (
            <button onClick={() => setEdit({ title: post.title, content: post.content ?? "", targets: (post.targets ?? []).map(t => t.id) })}
              style={btn("#eff6ff", "#2563eb")} data-testid="board-edit" aria-label="게시물 수정">수정</button>
          )}
          <button onClick={() => onDelete(post.id)} style={btn("#fee2e2", "#dc2626")} data-testid="board-delete" aria-label="게시물 삭제">삭제</button>
        </div>
      )}
    </DraggableModal>
  );
}
