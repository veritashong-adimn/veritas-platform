import React, { useEffect } from "react";
import { PdfThumbnail } from "./PdfThumbnail";

interface Props {
  url: string;
  fileName: string;
  onClose: () => void;
}

export function DocumentPreviewModal({ url, fileName, onClose }: Props) {
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  const isPdf = ext === ".pdf";

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 2000,
        background: "rgba(0,0,0,0.75)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#fff", borderRadius: 12,
          width: "min(92vw, 860px)",
          maxHeight: "90vh",
          display: "flex", flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 24px 64px rgba(0,0,0,0.45)",
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 16px", borderBottom: "1px solid #e5e7eb",
          background: "#f9fafb",
        }}>
          <span style={{
            fontSize: 13, fontWeight: 600, color: "#111827",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "80%",
          }}>
            {fileName}
          </span>
          <button
            onClick={onClose}
            aria-label="미리보기 닫기"
            style={{
              background: "none", border: "none", fontSize: 20,
              cursor: "pointer", color: "#6b7280", padding: "2px 6px", lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div style={{
          flex: 1, overflow: "auto",
          display: "flex", justifyContent: "center", alignItems: "center",
          background: "#f3f4f6",
          minHeight: "300px",
        }}>
          {isPdf ? (
            <div style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              padding: "20px 16px", gap: 16, width: "100%", boxSizing: "border-box",
            }}>
              <PdfThumbnail url={url} />
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                data-testid="pdf-open-new-tab"
                style={{
                  display: "inline-flex", alignItems: "center", gap: 5,
                  padding: "5px 14px", borderRadius: 6,
                  border: "1px solid #d1d5db", background: "#fff",
                  color: "#6b7280", fontSize: 12, fontWeight: 500,
                  textDecoration: "none", flexShrink: 0,
                }}
              >
                새 탭에서 열기 ↗
              </a>
            </div>
          ) : (
            <img
              src={url}
              alt={fileName}
              style={{
                maxWidth: "100%", maxHeight: "68vh",
                objectFit: "contain", display: "block",
                margin: "auto",
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
