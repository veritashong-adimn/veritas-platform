import React, { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../../lib/constants";
import { DocumentPreviewModal } from "./DocumentPreviewModal";
import { DocumentAnalyzePanel } from "./DocumentAnalyzePanel";

// ── 허용 형식 ─────────────────────────────────────────────────────────────────
const DOC_ALLOWED_EXTS = [".jpg", ".jpeg", ".png", ".pdf"] as const;
const DOC_ACCEPT = ".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf";
const DOC_HINT = "JPG · PNG · PDF (최대 10 MB)";
const DOC_UPLOAD_ERROR_MSG = "JPG, PNG, PDF 형식만 업로드할 수 있습니다.";

function getDocExt(name: string | null | undefined): string {
  if (!name) return "";
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
}
function canPreviewDoc(ext: string) {
  return [".jpg", ".jpeg", ".png", ".pdf"].includes(ext);
}
function getDocDisplayName(name: string | null | undefined) {
  return name || "파일";
}

interface DocMeta {
  idCardExists: boolean;
  idCardFileName: string | null;
  bankbookExists: boolean;
  bankbookFileName: string | null;
}

export interface TranslatorEvidenceDocumentsSectionProps {
  docType: "id_card" | "bankbook";
  /** "detail" = 기존 번역사 (translatorId 필수), "create" = 등록 중 (로컬 파일 상태) */
  mode: "detail" | "create";
  translatorId?: number;
  token: string;
  onToast: (msg: string) => void;
  /** create 모드: 현재 선택된 파일 (parent가 관리) */
  file?: File | null;
  /** create 모드: 파일 변경 콜백 */
  onFileChange?: (file: File | null) => void;
  /** detail 모드: AI 분석 결과가 승인 반영(저장)된 후 호출 — parent가 번역사 데이터를 새로고침해야 함 */
  onAnalysisApplied?: (fields: string[]) => void;
}

const btnBase: React.CSSProperties = {
  fontSize: 11, padding: "3px 8px", borderRadius: 5,
  border: "1px solid #d1d5db", background: "#fff",
  cursor: "pointer", color: "#374151", whiteSpace: "nowrap",
};
const btnDanger: React.CSSProperties = { ...btnBase, color: "#dc2626", border: "1px solid #fca5a5" };

export function TranslatorEvidenceDocumentsSection({
  docType,
  mode,
  translatorId,
  token,
  onToast,
  file: externalFile,
  onFileChange,
  onAnalysisApplied,
}: TranslatorEvidenceDocumentsSectionProps) {
  const label       = docType === "id_card" ? "신분증" : "통장사본";
  const icon        = docType === "id_card" ? "🪪" : "🏦";
  const nameColor   = docType === "id_card" ? "#9a3412" : "#065f46";
  const cardBg      = docType === "id_card" ? "#fff7ed" : "#f0fdf4";
  const cardBorder  = docType === "id_card" ? "#fed7aa" : "#a7f3d0";

  // detail 모드 상태
  const [docMeta, setDocMeta]           = useState<DocMeta | null>(null);
  const [uploading, setUploading]       = useState(false);
  const [deleting, setDeleting]         = useState(false);

  // 미리보기 모달
  const [preview, setPreview] = useState<{ url: string; fileName: string } | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  // AI 분석 패널 (detail 모드 + 파일 존재 시에만 사용 가능)
  const [showAnalyzePanel, setShowAnalyzePanel] = useState(false);

  const [dragOver, setDragOver] = useState(false);

  const authH = { Authorization: `Bearer ${token}` };

  // ── 파생값 ─────────────────────────────────────────────────────────────────
  const exists: boolean =
    mode === "create"
      ? !!externalFile
      : (docType === "id_card" ? docMeta?.idCardExists : docMeta?.bankbookExists) ?? false;

  const fileName: string | null =
    mode === "create"
      ? (externalFile?.name ?? null)
      : (docType === "id_card" ? docMeta?.idCardFileName : docMeta?.bankbookFileName) ?? null;

  // ── detail 모드: 서버에서 docMeta 조회 ─────────────────────────────────────
  const fetchDocMeta = useCallback(async () => {
    if (mode !== "detail" || !translatorId) return;
    try {
      const r = await fetch(api(`/api/admin/translators/${translatorId}/document-meta`), { headers: authH });
      const text = await r.text();
      if (r.ok) setDocMeta(JSON.parse(text) as DocMeta);
      else console.error("[document-meta]", r.status, text);
    } catch (e) {
      console.error("[document-meta] 네트워크 오류:", e);
    }
  }, [mode, translatorId, token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mode === "detail") fetchDocMeta();
  }, [mode, fetchDocMeta]);

  // blob URL 정리
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

  // ── 업로드 ─────────────────────────────────────────────────────────────────
  const handleUpload = async (uploadFile: File) => {
    const ext = uploadFile.name.slice(uploadFile.name.lastIndexOf(".")).toLowerCase();
    if (!(DOC_ALLOWED_EXTS as readonly string[]).includes(ext)) {
      onToast(DOC_UPLOAD_ERROR_MSG);
      return;
    }

    // create 모드: 로컬 상태만 업데이트
    if (mode === "create") {
      onFileChange?.(uploadFile);
      return;
    }

    // detail 모드: API 업로드
    if (!translatorId) return;
    if (exists && !window.confirm(`기존 ${label}을 새 파일로 교체하시겠습니까?`)) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", uploadFile);
      const r = await fetch(
        api(`/api/admin/translators/${translatorId}/document-upload?type=${docType}`),
        { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd },
      );
      const d = await r.json();
      if (r.ok) {
        // 낙관적 업데이트
        setDocMeta(prev => {
          const next = prev
            ? { ...prev }
            : { idCardExists: false, idCardFileName: null, bankbookExists: false, bankbookFileName: null };
          if (docType === "id_card") { next.idCardExists = true; next.idCardFileName = d.fileName ?? null; }
          else { next.bankbookExists = true; next.bankbookFileName = d.fileName ?? null; }
          return next;
        });
        onToast(`${label}이 업로드되었습니다.`);
        await fetchDocMeta();
      } else {
        onToast(`오류: ${d.error ?? "업로드 실패"}`);
      }
    } catch {
      onToast(`오류: ${label} 업로드 실패`);
    } finally {
      setUploading(false);
    }
  };

  // ── 삭제 ───────────────────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (mode === "create") {
      onFileChange?.(null);
      return;
    }
    if (!translatorId) return;
    if (!window.confirm(`${label}을 삭제하시겠습니까?`)) return;
    setDeleting(true);
    try {
      const r = await fetch(
        api(`/api/admin/translators/${translatorId}/document?type=${docType}`),
        { method: "DELETE", headers: authH },
      );
      const d = await r.json();
      if (r.ok) {
        setDocMeta(prev => {
          if (!prev) return prev;
          const next = { ...prev };
          if (docType === "id_card") { next.idCardExists = false; next.idCardFileName = null; }
          else { next.bankbookExists = false; next.bankbookFileName = null; }
          return next;
        });
        onToast(`${label}이 삭제되었습니다.`);
        await fetchDocMeta();
      } else {
        onToast(`오류: ${d.error ?? "삭제 실패"}`);
      }
    } catch {
      onToast(`오류: ${label} 삭제 실패`);
    } finally {
      setDeleting(false);
    }
  };

  // ── 미리보기 ───────────────────────────────────────────────────────────────
  const handlePreview = async () => {
    if (mode === "create" && externalFile) {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      const url = URL.createObjectURL(externalFile);
      blobUrlRef.current = url;
      setPreview({ url, fileName: externalFile.name });
      return;
    }
    if (mode === "detail" && translatorId) {
      const ext = getDocExt(fileName);
      if (ext === ".pdf") {
        // PDF: 프록시 URL로 동일 출처 요청 → pdf.js CORS 문제 없음
        const proxyUrl =
          api(`/api/admin/translators/${translatorId}/document-download?type=${docType}&inline=true`) +
          `&token=${encodeURIComponent(token)}`;
        setPreview({ url: proxyUrl, fileName: fileName ?? label });
        return;
      }
      // 이미지: GCS signed URL 사용 (<img>는 CORS 제한 없음)
      try {
        const r = await fetch(
          api(`/api/admin/translators/${translatorId}/document-url?type=${docType}`),
          { headers: authH },
        );
        const d = await r.json();
        if (!r.ok) { onToast(`오류: ${d.error}`); return; }
        setPreview({ url: d.downloadUrl, fileName: fileName ?? label });
      } catch {
        onToast("오류: 미리보기 URL 생성 실패");
      }
    }
  };

  const isLoading = mode === "detail" && (uploading || deleting);

  return (
    <>
      {preview && (
        <DocumentPreviewModal
          url={preview.url}
          fileName={preview.fileName}
          onClose={() => setPreview(null)}
        />
      )}

      {/* 파일 카드 */}
      {exists && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 12px", marginBottom: 8,
          background: cardBg, borderRadius: 8, border: `1px solid ${cardBorder}`,
        }}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>{icon}</span>
          <span
            title={fileName ?? undefined}
            style={{
              fontSize: 12, color: nameColor, fontWeight: 600,
              flex: 1, overflow: "hidden", textOverflow: "ellipsis",
              whiteSpace: "nowrap", minWidth: 0,
            }}
          >
            {getDocDisplayName(fileName)}
          </span>
          <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
            {canPreviewDoc(getDocExt(fileName)) && (
              <button
                type="button"
                disabled={uploading || deleting}
                aria-label={`${label} 미리보기`}
                onClick={handlePreview}
                style={btnBase}
              >
                미리보기
              </button>
            )}
            {mode === "detail" && (
              <button
                type="button"
                disabled={uploading || deleting}
                aria-label={`${label} 다운로드`}
                onClick={() => {
                  const a = document.createElement("a");
                  a.href =
                    api(`/api/admin/translators/${translatorId}/document-download?type=${docType}`) +
                    `&token=${encodeURIComponent(token)}`;
                  a.click();
                }}
                style={btnBase}
              >
                다운로드
              </button>
            )}
            <button
              type="button"
              disabled={deleting || uploading}
              aria-label={`${label} ${mode === "create" ? "제거" : "삭제"}`}
              onClick={handleDelete}
              style={{ ...btnDanger, cursor: deleting ? "not-allowed" : "pointer" }}
            >
              {deleting ? "삭제 중..." : mode === "create" ? "제거" : "삭제"}
            </button>
          </div>
        </div>
      )}

      {/* 드래그&드롭 업로드 영역 — 신분증/통장사본은 보통 파일 1개만 다루므로 이력서 수준의
          큰 드롭존이 필요 없음. 파일이 이미 있으면(exists) 한 줄짜리 더 압축된 형태로 표시 */}
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => {
          e.preventDefault(); setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) handleUpload(f);
        }}
        style={{
          border: `2px dashed ${dragOver ? "#f59e0b" : "#d1d5db"}`,
          borderRadius: 8, padding: exists ? "6px 12px" : "10px 14px",
          background: dragOver ? "#fffbeb" : "#f9fafb",
          textAlign: exists ? undefined : ("center" as const),
          display: exists ? "flex" : "block",
          alignItems: exists ? "center" : undefined,
          justifyContent: exists ? "space-between" : undefined,
          gap: exists ? 8 : undefined,
          transition: "border-color 0.15s, background 0.15s",
          opacity: isLoading ? 0.6 : 1,
          pointerEvents: isLoading ? "none" : "auto",
        }}
      >
        {!exists && <div style={{ fontSize: 16, marginBottom: 3 }}>{icon}</div>}
        <p style={{
          fontSize: 11, color: "#6b7280", margin: exists ? 0 : "0 0 3px",
          flex: exists ? 1 : undefined, minWidth: 0,
          overflow: exists ? "hidden" : undefined, textOverflow: exists ? "ellipsis" : undefined,
          whiteSpace: exists ? "nowrap" : undefined,
        }}>
          {isLoading
            ? "처리 중..."
            : dragOver
            ? "여기에 파일을 놓으세요"
            : exists
            ? DOC_HINT
            : `파일을 드래그하거나 아래 버튼으로 선택 (${DOC_HINT})`}
        </p>
        <label
          style={{
            fontSize: 11, padding: exists ? "4px 10px" : "4px 12px", borderRadius: 6,
            border: "1px solid #d1d5db", background: "#fff",
            cursor: isLoading ? "not-allowed" : "pointer",
            color: "#374151", display: "inline-block",
            marginTop: exists ? 0 : 4, flexShrink: 0, whiteSpace: "nowrap",
          }}
        >
          {isLoading ? "처리 중..." : exists ? "교체 파일 선택" : "파일 선택"}
          <input
            type="file"
            accept={DOC_ACCEPT}
            style={{ display: "none" }}
            disabled={isLoading}
            onChange={e => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) handleUpload(f);
            }}
          />
        </label>
      </div>

      {/* 보안 안내 */}
      <div style={{ marginTop: 12, padding: "10px 14px", background: "#fffbeb", borderRadius: 8, border: "1px solid #fde68a" }}>
        <p style={{ fontSize: 11, color: "#92400e", margin: "0 0 4px", fontWeight: 700 }}>🔐 민감정보 보안 정책</p>
        <p style={{ fontSize: 11, color: "#78350f", margin: 0, lineHeight: 1.6 }}>
          {docType === "id_card"
            ? "신분증은 민감개인정보입니다. 접근권한 관리 · 감사로그 · 승인 이력이 자동 기록됩니다."
            : "통장사본은 금융정보입니다. 접근권한 관리 · 감사로그 · 승인 이력이 자동 기록됩니다."}
        </p>
      </div>

      {/* AI 분석 */}
      <div style={{ marginTop: 8, padding: "10px 14px", background: "#f0f9ff", borderRadius: 8, border: "1px solid #bae6fd" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div>
            <p style={{ fontSize: 11, color: "#0369a1", margin: "0 0 3px", fontWeight: 700 }}>✨ AI 분석 항목</p>
            <p style={{ fontSize: 11, color: "#0c4a6e", margin: 0, lineHeight: 1.6 }}>
              {docType === "id_card"
                ? "이름 · 주민등록번호 · 주소 → 관리자 검수 → 승인 반영 (JPG/PNG만 분석 가능)"
                : "은행명 · 예금주 · 계좌번호 → 관리자 검수 → 승인 반영 (JPG/PNG만 분석 가능)"}
            </p>
          </div>
          {mode === "detail" && (
            <button
              type="button"
              disabled={!exists}
              aria-label={`${label} AI 분석 실행`}
              data-testid={`btn-document-ocr-analyze-${docType}`}
              onClick={() => setShowAnalyzePanel(true)}
              style={{
                fontSize: 12, padding: "6px 14px", borderRadius: 6, border: "1px solid #0284c7",
                background: exists ? "#0284c7" : "#e5e7eb", color: exists ? "#fff" : "#9ca3af",
                cursor: exists ? "pointer" : "not-allowed", fontWeight: 600, whiteSpace: "nowrap",
              }}
            >
              ✨ AI 분석 실행
            </button>
          )}
        </div>
      </div>

      {showAnalyzePanel && mode === "detail" && translatorId && (
        <DocumentAnalyzePanel
          userId={translatorId}
          docType={docType}
          token={token}
          onToast={onToast}
          onClose={() => setShowAnalyzePanel(false)}
          onApplied={fields => onAnalysisApplied?.(fields)}
        />
      )}

      {/* create 모드: 등록 완료 후 업로드 안내 */}
      {mode === "create" && exists && (
        <div style={{ marginTop: 8, padding: "8px 12px", background: "#fef3c7", borderRadius: 6, border: "1px solid #fcd34d" }}>
          <p style={{ fontSize: 11, color: "#92400e", margin: 0 }}>
            ℹ️ 파일은 번역사 등록 완료 후 자동으로 업로드됩니다.
          </p>
        </div>
      )}
    </>
  );
}
