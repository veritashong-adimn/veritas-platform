import React, { useState, useRef, useCallback, useEffect } from "react";

interface DraggableModalProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  height?: string;
  zIndex?: number;
  headerExtra?: React.ReactNode;
  bodyPadding?: string;
  resizable?: boolean;
}

export function DraggableModal({
  title,
  subtitle,
  onClose,
  children,
  width = 720,
  height,
  zIndex = 300,
  headerExtra,
  bodyPadding = "20px 24px",
  resizable = false,
}: DraggableModalProps) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startMx: number; startMy: number; startPx: number; startPy: number } | null>(null);
  const isDragging = useRef(false);
  const resizeStartRef = useRef<{ mx: number; my: number; w: number; h: number } | null>(null);
  const isResizing = useRef(false);

  /* ─── mobile detection: SSR-safe ─── */
  const isMobile = () =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches;

  const canResize = resizable && !maximized;

  /* ─── Drag (header) ─── */
  const onHeaderMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0 || maximized) return;
      const target = e.target as HTMLElement;
      if (target.closest("button")) return;
      e.preventDefault();
      const dialog = dialogRef.current;
      if (!dialog) return;
      const rect = dialog.getBoundingClientRect();
      dragRef.current = {
        startMx: e.clientX,
        startMy: e.clientY,
        startPx: rect.left,
        startPy: rect.top,
      };
      isDragging.current = true;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";
    },
    [maximized]
  );

  /* ─── Resize (handle) ─── */
  const onResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (maximized || isMobile()) return;
      e.preventDefault();
      e.stopPropagation();
      const dialog = dialogRef.current;
      if (!dialog) return;
      const rect = dialog.getBoundingClientRect();
      resizeStartRef.current = { mx: e.clientX, my: e.clientY, w: rect.width, h: rect.height };
      isResizing.current = true;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "nwse-resize";
    },
    [maximized]
  );

  /* ─── Global mouse events ─── */
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      /* drag */
      if (isDragging.current && dragRef.current) {
        const { startMx, startMy, startPx, startPy } = dragRef.current;
        const dialog = dialogRef.current;
        if (!dialog) return;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const w = dialog.offsetWidth;
        const newX = Math.max(-w + 120, Math.min(vw - 120, startPx + e.clientX - startMx));
        const newY = Math.max(0, Math.min(vh - 52, startPy + e.clientY - startMy));
        setPos({ x: newX, y: newY });
      }

      /* resize — update DOM directly to avoid React re-renders during drag */
      if (isResizing.current && resizeStartRef.current && dialogRef.current) {
        const { mx, my, w, h } = resizeStartRef.current;
        const minW = width;
        const minH = 500;
        const maxW = window.innerWidth * 0.95;
        const maxH = window.innerHeight * 0.95;
        const newW = Math.max(minW, Math.min(maxW, w + e.clientX - mx));
        const newH = Math.max(minH, Math.min(maxH, h + e.clientY - my));
        dialogRef.current.style.width     = `${newW}px`;
        dialogRef.current.style.maxWidth  = `${newW}px`;
        dialogRef.current.style.height    = `${newH}px`;
        dialogRef.current.style.maxHeight = `${newH}px`;
      }
    };

    const onUp = () => {
      isDragging.current = false;
      dragRef.current = null;
      if (isResizing.current && dialogRef.current) {
        const w = parseFloat(dialogRef.current.style.width)  || dialogRef.current.offsetWidth;
        const h = parseFloat(dialogRef.current.style.height) || dialogRef.current.offsetHeight;
        setSize({ w, h });
        isResizing.current    = false;
        resizeStartRef.current = null;
      }
      document.body.style.userSelect = "";
      document.body.style.cursor     = "";
    };

    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
    window.addEventListener("keydown",     onKey);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
      window.removeEventListener("keydown",     onKey);
    };
  }, [onClose, width]);

  /* ─── Styles ─── */
  const sizeStyle: React.CSSProperties = size
    ? { width: size.w, maxWidth: size.w, height: size.h, maxHeight: size.h }
    : {};

  const dialogStyle: React.CSSProperties = maximized
    ? { position: "fixed", inset: 0, borderRadius: 0, maxWidth: "none", maxHeight: "none", width: "100%", height: "100%" }
    : pos
    ? { position: "fixed", left: pos.x, top: pos.y, width: "100%", maxWidth: width, height: height, maxHeight: height ?? "90vh", ...sizeStyle }
    : { position: "fixed", left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: "100%", maxWidth: width, height: height, maxHeight: height ?? "90vh", ...sizeStyle };

  return (
    <>
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: zIndex - 1 }} />
      <div
        ref={dialogRef}
        style={{
          ...dialogStyle,
          zIndex,
          background: "#fff",
          borderRadius: maximized ? 0 : 14,
          border: "1px solid #e5e7eb",
          boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* ── Draggable header ── */}
        <div
          onMouseDown={onHeaderMouseDown}
          style={{
            padding: "15px 20px 13px",
            borderBottom: "1px solid #f3f4f6",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            cursor: maximized ? "default" : "grab",
            userSelect: "none",
            flexShrink: 0,
            background: "#fff",
            borderRadius: maximized ? 0 : "14px 14px 0 0",
          }}
        >
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, color: "#111827", lineHeight: 1.2 }}>{title}</div>
            {subtitle && <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 3 }}>{subtitle}</div>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: 12 }}>
            {headerExtra}
            <button
              onClick={() => setMaximized((m) => !m)}
              title={maximized ? "기본 크기로 복원" : "최대화"}
              style={{
                background: "none", border: "1px solid #e5e7eb", fontSize: 13,
                cursor: "pointer", color: "#6b7280", padding: "3px 7px",
                borderRadius: 6, lineHeight: 1.2, fontFamily: "monospace",
              }}
            >
              {maximized ? "⊡" : "⊞"}
            </button>
            <button
              onClick={onClose}
              style={{
                background: "none", border: "none", fontSize: 20,
                cursor: "pointer", color: "#9ca3af", padding: "2px 6px", lineHeight: 1, borderRadius: 6,
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* ── Scrollable body ── */}
        <div style={{ overflowY: "auto", flex: 1, padding: bodyPadding }}>
          {children}
        </div>

        {/* ── Resize footer bar — only for resizable large modals (not mobile, not maximized) ── */}
        {canResize && (
          <div
            onMouseDown={onResizeMouseDown}
            aria-label="모달 크기 조절"
            role="button"
            tabIndex={-1}
            title="드래그하여 크기 조절"
            style={{
              flexShrink: 0,
              height: 14,
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              paddingRight: 6,
              cursor: "nwse-resize",
              background: "transparent",
              userSelect: "none",
            }}
            onMouseEnter={e => { (e.currentTarget.querySelector("svg") as SVGElement | null)?.setAttribute("opacity", "0.85"); }}
            onMouseLeave={e => { (e.currentTarget.querySelector("svg") as SVGElement | null)?.setAttribute("opacity", "0.35"); }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" opacity="0.35" style={{ pointerEvents: "none" }}>
              <path d="M13 1L1 13" stroke="#374151" strokeWidth="1.5" strokeLinecap="round"/>
              <path d="M13 7L7 13" stroke="#374151" strokeWidth="1.5" strokeLinecap="round"/>
              <path d="M13 11L11 13" stroke="#374151" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
        )}
      </div>
    </>
  );
}
