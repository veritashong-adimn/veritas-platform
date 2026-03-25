import React from "react";
import { STATUS_LABEL, STATUS_STYLE, ROLE_LABEL, ROLE_STYLE, Role } from "../../lib/constants";

export const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", border: "1px solid #e5e7eb", borderRadius: 8,
  fontSize: 14, outline: "none", boxSizing: "border-box", background: "#fff",
};
export const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 5,
};
export const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 700, color: "#6b7280",
  textTransform: "uppercase", letterSpacing: "0.06em",
  margin: "20px 0 10px", paddingBottom: 6, borderBottom: "1px solid #f3f4f6",
};

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLE[status] ?? { background: "#f3f4f6", color: "#6b7280" };
  return (
    <span style={{
      ...style, display: "inline-block", padding: "3px 10px",
      borderRadius: 20, fontSize: 12, fontWeight: 700, whiteSpace: "nowrap",
    }}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function RoleBadge({ role }: { role: Role }) {
  return (
    <span style={{
      ...ROLE_STYLE[role], padding: "2px 9px", borderRadius: 12,
      fontSize: 11, fontWeight: 700,
    }}>
      {ROLE_LABEL[role]}
    </span>
  );
}

export function Toast({ msg, onClose }: { msg: string; onClose: () => void }) {
  if (!msg) return null;
  const isError = msg.startsWith("오류");
  return (
    <div style={{
      position: "fixed", bottom: 24, right: 24, zIndex: 9999,
      background: isError ? "#fef2f2" : "#f0fdf4",
      border: `1px solid ${isError ? "#fecaca" : "#bbf7d0"}`,
      color: isError ? "#dc2626" : "#059669",
      padding: "12px 20px", borderRadius: 12, boxShadow: "0 4px 20px rgba(0,0,0,0.12)",
      fontSize: 14, fontWeight: 600, display: "flex", gap: 10, alignItems: "center",
    }}>
      <span>{isError ? "⚠️" : "✅"} {msg}</span>
      <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "inherit", lineHeight: 1, padding: 0 }}>×</button>
    </div>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14,
      padding: "20px 22px", boxShadow: "0 1px 3px rgba(0,0,0,0.07)", ...style,
    }}>
      {children}
    </div>
  );
}

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  color?: string;
  children: React.ReactNode;
};

export function PrimaryBtn({ children, style, color, disabled, ...rest }: BtnProps) {
  const bg = color ?? "#2563eb";
  return (
    <button
      disabled={disabled}
      style={{
        background: disabled ? "#d1d5db" : bg,
        color: "#fff", border: "none", borderRadius: 8,
        padding: "8px 18px", fontSize: 14, fontWeight: 700,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 0.15s",
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

export function GhostBtn({ children, style, color, disabled, ...rest }: BtnProps) {
  const c = color ?? "#374151";
  return (
    <button
      disabled={disabled}
      style={{
        background: "transparent", color: disabled ? "#9ca3af" : c,
        border: `1px solid ${disabled ? "#e5e7eb" : c + "60"}`,
        borderRadius: 8, padding: "8px 18px", fontSize: 14, fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer", transition: "all 0.15s",
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ margin: "0 0 14px", fontSize: 16, fontWeight: 800, color: "#111827" }}>{title}</h2>
      {children}
    </div>
  );
}

export function FilterPill({
  label, active, onClick,
}: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "5px 14px", borderRadius: 20, fontSize: 13, fontWeight: active ? 700 : 500,
        cursor: "pointer", border: "1px solid", transition: "all 0.12s",
        borderColor: active ? "#2563eb" : "#e5e7eb",
        background: active ? "#2563eb" : "#fff",
        color: active ? "#fff" : "#6b7280",
      }}
    >
      {label}
    </button>
  );
}

export function ModalOverlay({ children, onClose, maxWidth = 780 }: {
  children: React.ReactNode; onClose?: () => void; maxWidth?: number;
}) {
  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        zIndex: 300, overflowY: "auto", padding: "20px 16px",
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div style={{
        background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb",
        width: "100%", maxWidth, padding: "24px 28px",
        boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
      }}>
        {children}
      </div>
    </div>
  );
}
