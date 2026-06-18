import React, { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).href;

interface Props {
  url: string;
  maxWidth?: number;
}

export function PdfThumbnail({ url, maxWidth = 760 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");

    async function render() {
      try {
        const loadingTask = pdfjsLib.getDocument({ url, withCredentials: false });
        const pdf = await loadingTask.promise;
        if (cancelled) return;
        const page = await pdf.getPage(1);
        if (cancelled) return;
        const baseViewport = page.getViewport({ scale: 1.0 });
        const scale = Math.min(1.5, maxWidth / baseViewport.width);
        const viewport = page.getViewport({ scale });

        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvas, viewport }).promise;
        if (!cancelled) setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    }

    render();
    return () => { cancelled = true; };
  }, [url, maxWidth]);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 220, width: "100%", position: "relative" }}>
      {status === "loading" && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 30, height: 30,
            border: "3px solid #e5e7eb", borderTopColor: "#2563eb",
            borderRadius: "50%", animation: "pdf-spin 0.7s linear infinite",
          }} />
          <span style={{ fontSize: 12, color: "#6b7280" }}>PDF 렌더링 중...</span>
          <style>{`@keyframes pdf-spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}
      {status === "error" && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "24px 16px", textAlign: "center" }}>
          <span style={{ fontSize: 36 }}>⚠️</span>
          <span style={{ fontSize: 13, color: "#dc2626", fontWeight: 600 }}>PDF 미리보기를 불러올 수 없습니다.</span>
          <span style={{ fontSize: 11, color: "#6b7280" }}>새 탭에서 열어 확인해 주세요.</span>
        </div>
      )}
      <canvas
        ref={canvasRef}
        style={{
          maxWidth: "100%",
          display: status === "ready" ? "block" : "none",
          boxShadow: "0 2px 12px rgba(0,0,0,0.15)",
          borderRadius: 4,
          border: "1px solid #e5e7eb",
        }}
      />
    </div>
  );
}
