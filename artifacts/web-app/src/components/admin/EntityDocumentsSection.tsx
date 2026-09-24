import React, { useState, useEffect, useCallback, useRef } from "react";
import { FileText, Upload, Download, Trash2 } from "lucide-react";
import { api } from "../../lib/constants";
import { formatDisplayDate } from "../../lib/dateFormat";
import { PrimaryBtn, GhostBtn, ClickSelect, confirmDialog } from "../ui";

// ─────────────────────────────────────────────────────────────────────────────
// EntityDocumentsSection — 도메인 공용 서류관리 컴포넌트(§8 공통화).
//  · 파일 실체는 기존 R2 오브젝트 저장소를 재사용(POST /api/storage/uploads/request-url → PUT → 등록).
//    새 저장체계를 만들지 않는다. 외주업체·통번역사 등 서로 다른 도메인이 이 컴포넌트를 공유하되,
//    각 도메인의 엔드포인트(docsBaseUrl)와 FK(extraRegisterFields)는 래퍼에서 명확히 분리한다.
//  · 두 가지 모드:
//    · live 모드    : docsBaseUrl 이 있는 경우. 업로드 즉시 서버 등록/조회/다운로드/삭제(soft-delete).
//    · pending 모드 : 소유 엔티티가 아직 생성되기 전(신규 등록). R2 업로드만 하고 메타데이터는
//      부모(pendingDocs)가 메모리에 보관 → 엔티티 생성 성공 후 부모가 일괄 등록(고아 레코드 방지).
// ─────────────────────────────────────────────────────────────────────────────

const CUSTOM_TYPE = "__custom__";

// 엔티티 생성 전 메모리에 보관하는 문서(아직 DB 미등록).
export interface PendingDoc {
  documentType: string;
  documentName: string;
  originalFileName: string;
  objectPath: string;
  mimeType: string | null;
  fileSize: number | null;
  memo: string | null;
}

interface DocRow {
  id: number;
  documentType: string;
  documentName: string | null;
  originalFileName: string;
  mimeType: string | null;
  fileSize: number | null;
  memo: string | null;
  uploadedAt: string | null;
  uploaderName: string | null;
}

const sH: React.CSSProperties = {
  fontSize: 14, fontWeight: 700, color: "#111827",
  borderLeft: "3px solid #7c3aed", paddingLeft: 10, margin: 0, lineHeight: 1.5,
};
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 11px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 13, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};
const tableTh: React.CSSProperties = {
  padding: "8px 10px", textAlign: "left", fontSize: 11,
  fontWeight: 600, color: "#6b7280", background: "#f9fafb",
  borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap",
};
const tableTd: React.CSSProperties = {
  padding: "8px 10px", fontSize: 12, color: "#374151",
  borderBottom: "1px solid #edf0f3", verticalAlign: "middle",
};

function formatSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function docTypeBadge(type: string): React.ReactNode {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 4, background: "#f5f3ff", color: "#7c3aed", border: "1px solid #ddd6fe", whiteSpace: "nowrap" }}>
      <FileText size={12} /> {type}
    </span>
  );
}

export interface EntityDocumentsSectionProps {
  /** live 모드에서 필수. 예: "/api/admin/companies/123/documents". pending 모드에서는 불필요. */
  docsBaseUrl?: string | null;
  /** 문서종류 선택 옵션(직접입력 허용). */
  docTypeOptions: { value: string; label: string }[];
  /** 선택 기본값(옵션의 첫 값이 기본). */
  defaultDocType?: string;
  token: string;
  onToast: (msg: string) => void;
  /** 섹션 제목(!compact 일 때 표시). */
  title?: string;
  /** 업로드/삭제 가능 여부(권한). false 면 조회 전용 */
  canEdit?: boolean;
  /** 좁은 폭에서 사용 시 섹션 제목 숨김·여백 축소 */
  compact?: boolean;
  /** live 등록 POST body 에 병합할 도메인 FK(예: { vendorProfileId }) */
  extraRegisterFields?: Record<string, unknown>;
  /** 신규 등록 단계: 엔티티 생성 전 R2 업로드만 하고 메타데이터는 부모가 보관 */
  pendingMode?: boolean;
  pendingDocs?: PendingDoc[];
  onPendingDocsChange?: (docs: PendingDoc[]) => void;
}

export function EntityDocumentsSection({
  docsBaseUrl, docTypeOptions, defaultDocType,
  token, onToast, title = "서류", canEdit = true, compact = false,
  extraRegisterFields, pendingMode = false, pendingDocs, onPendingDocsChange,
}: EntityDocumentsSectionProps) {
  const authH = { Authorization: `Bearer ${token}` };
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [rows, setRows] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(!pendingMode);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState("");

  const [docTypeSel, setDocTypeSel] = useState<string>(defaultDocType ?? docTypeOptions[0]?.value ?? "");
  const [customType, setCustomType] = useState("");
  const [memo, setMemo] = useState("");

  const load = useCallback(async () => {
    if (pendingMode || !docsBaseUrl) { setLoading(false); return; }
    setLoading(true);
    try {
      const res = await fetch(api(docsBaseUrl), { headers: authH });
      const data = await res.json().catch(() => null);
      if (res.ok) setRows(Array.isArray(data?.rows) ? data.rows : []);
    } catch { /* 조회 실패는 조용히 빈 목록 */ }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docsBaseUrl, token, pendingMode]);

  useEffect(() => { load(); }, [load]);

  const resolvedType = docTypeSel === CUSTOM_TYPE ? customType.trim() : docTypeSel;

  const handlePick = () => {
    if (!resolvedType) { onToast("문서종류를 선택하거나 직접 입력하세요."); return; }
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!resolvedType) { onToast("문서종류를 먼저 지정하세요."); return; }

    setUploading(true);
    setProgress("업로드 URL 요청 중...");
    try {
      // 1) presigned URL 발급(기존 저장소 재사용)
      const urlRes = await fetch(api("/api/storage/uploads/request-url"), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      if (!urlRes.ok) { onToast("오류: 업로드 URL 발급 실패"); return; }
      const { uploadURL, objectPath } = await urlRes.json();

      // 2) R2 직접 업로드
      setProgress("파일 업로드 중...");
      const putRes = await fetch(uploadURL, {
        method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file,
      });
      if (!putRes.ok) { onToast("오류: 파일 업로드 실패"); return; }

      if (pendingMode) {
        // 3-a) 메타데이터를 부모 상태에 보관(아직 DB 미등록). 엔티티 생성 성공 후 등록됨.
        const next: PendingDoc = {
          documentType: resolvedType,
          documentName: file.name,
          originalFileName: file.name,
          objectPath,
          mimeType: file.type || null,
          fileSize: file.size,
          memo: memo.trim() || null,
        };
        onPendingDocsChange?.([...(pendingDocs ?? []), next]);
        onToast(`"${file.name}" 첨부됨 (등록 완료 시 저장)`);
        setMemo("");
      } else if (docsBaseUrl) {
        // 3-b) live 모드: 즉시 서버 등록
        setProgress("서류 정보 저장 중...");
        const regRes = await fetch(api(docsBaseUrl), {
          method: "POST", headers: { ...authH, "Content-Type": "application/json" },
          body: JSON.stringify({
            documentType: resolvedType,
            documentName: file.name,
            originalFileName: file.name,
            objectPath,
            mimeType: file.type || null,
            fileSize: file.size,
            memo: memo.trim() || null,
            ...(extraRegisterFields ?? {}),
          }),
        });
        if (!regRes.ok) {
          const d = await regRes.json().catch(() => ({}));
          onToast(`오류: ${d.error ?? "서류 정보 저장 실패"}`); return;
        }
        onToast(`"${file.name}" 서류가 등록되었습니다.`);
        setMemo("");
        await load();
      }
    } catch { onToast("오류: 서류 업로드 중 오류 발생"); }
    finally { setUploading(false); setProgress(""); }
  };

  const handleDownload = async (doc: DocRow) => {
    if (!docsBaseUrl) return;
    try {
      const r = await fetch(api(`${docsBaseUrl}/${doc.id}/download`), { headers: authH });
      if (!r.ok) { onToast("오류: 서류 다운로드 실패"); return; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = doc.originalFileName;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch { onToast("오류: 서류 다운로드 실패"); }
  };

  const handleDelete = async (doc: DocRow) => {
    if (!docsBaseUrl) return;
    const ok = await confirmDialog({
      title: "서류 삭제",
      message: `"${doc.documentName || doc.originalFileName}"을(를) 삭제하시겠습니까? (휴지통으로 이동)`,
      confirmLabel: "삭제", variant: "danger",
    });
    if (!ok) return;
    try {
      const res = await fetch(api(`${docsBaseUrl}/${doc.id}`), { method: "DELETE", headers: authH });
      if (!res.ok) { onToast("오류: 서류 삭제 실패"); return; }
      onToast("서류가 삭제되었습니다.");
      await load();
    } catch { onToast("오류: 서류 삭제 실패"); }
  };

  const removePending = (idx: number) => {
    onPendingDocsChange?.((pendingDocs ?? []).filter((_, i) => i !== idx));
  };

  const list = pendingMode ? (pendingDocs ?? []) : rows;
  const isEmpty = list.length === 0;

  return (
    <div data-testid="entity-documents-section" style={{ marginTop: compact ? 0 : 6 }}>
      {!compact && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "20px 0 10px" }}>
          <p style={sH}>{title}</p>
        </div>
      )}

      {/* 업로드 영역 */}
      {canEdit && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end", background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ minWidth: 150 }}>
            <label style={{ fontSize: 11, color: "#374151", fontWeight: 600, display: "block", marginBottom: 4 }}>문서종류</label>
            <ClickSelect
              value={docTypeSel}
              onChange={setDocTypeSel}
              triggerStyle={{ fontSize: 13, padding: "8px 11px", borderRadius: 8, minWidth: 150 }}
              options={[...docTypeOptions, { value: CUSTOM_TYPE, label: "직접입력…" }]}
            />
          </div>
          {docTypeSel === CUSTOM_TYPE && (
            <div style={{ minWidth: 150 }}>
              <label style={{ fontSize: 11, color: "#374151", fontWeight: 600, display: "block", marginBottom: 4 }}>직접입력</label>
              <input value={customType} onChange={e => setCustomType(e.target.value)}
                placeholder="문서종류 입력" data-testid="entity-doc-custom-type"
                style={{ ...inputStyle, width: 160 }} />
            </div>
          )}
          <div style={{ flex: "1 1 180px", minWidth: 160 }}>
            <label style={{ fontSize: 11, color: "#374151", fontWeight: 600, display: "block", marginBottom: 4 }}>메모(선택)</label>
            <input value={memo} onChange={e => setMemo(e.target.value)}
              placeholder="예: 2024년 계약서" data-testid="entity-doc-memo" style={inputStyle} />
          </div>
          <input ref={fileInputRef} type="file" style={{ display: "none" }}
            data-testid="entity-doc-file-input" onChange={handleFileSelected} />
          <PrimaryBtn onClick={handlePick} disabled={uploading}
            style={{ fontSize: 13, padding: "8px 16px", display: "flex", alignItems: "center", gap: 6 }}
            data-testid="entity-doc-upload-btn" aria-label="서류 추가">
            <Upload size={14} /> {uploading ? (progress || "업로드 중...") : "서류 추가"}
          </PrimaryBtn>
        </div>
      )}

      {/* 목록 */}
      {loading ? (
        <p style={{ color: "#9ca3af", fontSize: 13, padding: "4px 0" }}>불러오는 중…</p>
      ) : isEmpty ? null : (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {(pendingMode
                    ? ["문서종류", "문서명", "크기", "메모", ""]
                    : ["문서종류", "문서명", "파일명", "크기", "등록일", "메모", ""]
                  ).map((h, i, arr) => (
                    <th key={i} style={{ ...tableTh, textAlign: i === arr.length - 1 ? "right" : "left" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pendingMode
                  ? (pendingDocs ?? []).map((doc, idx) => (
                    <tr key={idx} data-testid={`entity-pending-doc-${idx}`}>
                      <td style={{ ...tableTd, whiteSpace: "nowrap" }}>{docTypeBadge(doc.documentType)}</td>
                      <td style={{ ...tableTd, minWidth: 160 }}>
                        <div style={{ fontWeight: 600, color: "#111827" }}>{doc.documentName || doc.originalFileName}</div>
                      </td>
                      <td style={{ ...tableTd, whiteSpace: "nowrap", color: "#6b7280" }}>{formatSize(doc.fileSize)}</td>
                      <td style={{ ...tableTd, maxWidth: 200, color: "#6b7280" }}>{doc.memo || "-"}</td>
                      <td style={{ ...tableTd, whiteSpace: "nowrap", textAlign: "right" }}>
                        {canEdit && (
                          <GhostBtn onClick={() => removePending(idx)} style={{ fontSize: 11, padding: "4px 8px", color: "#dc2626", display: "inline-flex", alignItems: "center", gap: 4 }}
                            data-testid={`entity-pending-doc-remove-${idx}`} aria-label="첨부 제거">
                            <Trash2 size={13} /> 제거
                          </GhostBtn>
                        )}
                      </td>
                    </tr>
                  ))
                  : rows.map(doc => (
                    <tr key={doc.id} data-testid={`entity-doc-row-${doc.id}`}>
                      <td style={{ ...tableTd, whiteSpace: "nowrap" }}>{docTypeBadge(doc.documentType)}</td>
                      <td style={{ ...tableTd, minWidth: 140 }}>
                        <div style={{ fontWeight: 600, color: "#111827" }}>{doc.documentName || doc.originalFileName}</div>
                      </td>
                      <td style={{ ...tableTd, minWidth: 120, color: "#6b7280" }}>{doc.originalFileName}</td>
                      <td style={{ ...tableTd, whiteSpace: "nowrap", color: "#6b7280" }}>{formatSize(doc.fileSize)}</td>
                      <td style={{ ...tableTd, whiteSpace: "nowrap", color: "#6b7280" }}>{doc.uploadedAt ? formatDisplayDate(doc.uploadedAt) : "-"}</td>
                      <td style={{ ...tableTd, maxWidth: 200, color: "#6b7280" }}>{doc.memo || "-"}</td>
                      <td style={{ ...tableTd, whiteSpace: "nowrap", textAlign: "right" }}>
                        <div style={{ display: "inline-flex", gap: 6 }}>
                          <GhostBtn onClick={() => handleDownload(doc)} style={{ fontSize: 11, padding: "4px 8px", display: "inline-flex", alignItems: "center", gap: 4 }}
                            data-testid={`entity-doc-download-${doc.id}`} aria-label="서류 다운로드">
                            <Download size={13} /> 다운로드
                          </GhostBtn>
                          {canEdit && (
                            <GhostBtn onClick={() => handleDelete(doc)} style={{ fontSize: 11, padding: "4px 8px", color: "#dc2626", display: "inline-flex", alignItems: "center", gap: 4 }}
                              data-testid={`entity-doc-delete-${doc.id}`} aria-label="서류 삭제">
                              <Trash2 size={13} /> 삭제
                            </GhostBtn>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default EntityDocumentsSection;
