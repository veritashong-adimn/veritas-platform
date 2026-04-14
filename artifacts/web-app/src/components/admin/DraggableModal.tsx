import React, { useState, useRef, useCallback, useEffect } from "react";

interface DraggableModalProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  zIndex?: number;
  headerExtra?: React.ReactNode;
  bodyPadding?: string;
}

export function DraggableModal({
  title,
  subtitle,
  onClose,
  children,
  width = 720,
  zIndex = 300,
  headerExtra,
  bodyPadding = "20px 24px",
}: DraggableModalProps) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [maximized, setMaximized] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startMx: number; startMy: number; startPx: number; startPy: number } | null>(null);
  const isDragging = useRef(false);

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

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDragging.current || !dragRef.current) return;
      const { startMx, startMy, startPx, startPy } = dragRef.current;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = dialog.offsetWidth;
      const newX = Math.max(-w + 120, Math.min(vw - 120, startPx + e.clientX - startMx));
      const newY = Math.max(0, Math.min(vh - 52, startPy + e.clientY - startMy));
      setPos({ x: newX, y: newY });
    };
    const onUp = () => {
      isDragging.current = false;
      dragRef.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const dialogStyle: React.CSSProperties = maximized
    ? { position: "fixed", inset: 0, borderRadius: 0, maxWidth: "none", maxHeight: "none" }
    : pos
    ? { position: "fixed", left: pos.x, top: pos.y, width: "100%", maxWidth: width }
    : { position: "fixed", left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: "100%", maxWidth: width };

  return (
    <>
      <div
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: zIndex - 1 }}
      />
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
          maxHeight: maximized ? "100vh" : "90vh",
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
            {subtitle && (
              <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 3 }}>{subtitle}</div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: 12 }}>
            {headerExtra}
            <button
              onClick={() => setMaximized((m) => !m)}
              title={maximized ? "기본 크기로 복원" : "최대화"}
              style={{
                background: "none",
                border: "1px solid #e5e7eb",
                fontSize: 13,
                cursor: "pointer",
                color: "#6b7280",
                padding: "3px 7px",
                borderRadius: 6,
                lineHeight: 1.2,
                fontFamily: "monospace",
              }}
            >
              {maximized ? "⊡" : "⊞"}
            </button>
            <button
              onClick={onClose}
              style={{
                background: "none",
                border: "none",
                fontSize: 20,
                cursor: "pointer",
                color: "#9ca3af",
                padding: "2px 6px",
                lineHeight: 1,
                borderRadius: 6,
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
      </div>
    </>
  );
}
