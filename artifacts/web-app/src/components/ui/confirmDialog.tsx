// VERITAS 공통 확인/입력/경고 모달 — 브라우저 기본 window.confirm/alert/prompt 대체(전역 표준).
//   · 명령형 전역 API: confirmDialog()/promptDialog()/alertDialog() 가 Promise 를 반환한다.
//   · <ConfirmHost/> 를 앱 루트(App.tsx)에 1회만 마운트하면, 어느 모듈에서든 위 함수로 모달을 띄운다.
//   · 확인/취소/ESC/닫기/오버레이 어느 경로로 닫혀도 Promise 는 "정확히 한 번만" resolve 된다(_settled 가드).
//   · 확인 버튼 중복 클릭으로 호출부 action 이 2회 실행되지 않도록 처리(_settled + 처리중 disabled).
//   업무 로직은 호출부에 그대로 있고, 이 모듈은 "확인 UI" 만 담당한다.
import React from "react";
import { createPortal } from "react-dom";
import { C } from "../../lib/ds";

export type DialogVariant = "default" | "warning" | "danger";

type BaseReq = {
  id: number;
  title?: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: DialogVariant;
  _settled?: boolean;
};
type ConfirmReq = BaseReq & { kind: "confirm"; resolve: (v: boolean) => void };
type AlertReq = BaseReq & { kind: "alert"; resolve: () => void };
type PromptReq = BaseReq & {
  kind: "prompt";
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  multiline?: boolean;
  validate?: (v: string) => string | null; // 오류 메시지 반환 시 확인 차단, null 이면 통과
  resolve: (v: string | null) => void;
};
type Req = ConfirmReq | AlertReq | PromptReq;

// ── 모듈 스토어 (단일 활성 모달 + 대기 큐) ──────────────────────────────────────
let current: Req | null = null;
const queue: Req[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function enqueue(req: Req) {
  if (current) queue.push(req);
  else { current = req; emit(); }
}
function advance() {
  current = queue.shift() ?? null;
  emit();
}

export function confirmDialog(opts: Omit<ConfirmReq, "kind" | "id" | "resolve" | "_settled">): Promise<boolean> {
  return new Promise((resolve) => enqueue({ ...opts, kind: "confirm", id: ++seq, resolve }));
}
export function alertDialog(opts: Omit<AlertReq, "kind" | "id" | "resolve" | "_settled">): Promise<void> {
  return new Promise((resolve) => enqueue({ ...opts, kind: "alert", id: ++seq, resolve }));
}
export function promptDialog(opts: Omit<PromptReq, "kind" | "id" | "resolve" | "_settled">): Promise<string | null> {
  return new Promise((resolve) => enqueue({ ...opts, kind: "prompt", id: ++seq, resolve }));
}

const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
const getSnapshot = () => current;

// ── 색상 (variant) ──────────────────────────────────────────────────────────
function confirmBtnStyle(variant: DialogVariant): React.CSSProperties {
  const map = {
    danger: { bg: C.danger, hover: C.dangerHover },
    warning: { bg: C.warning, hover: C.warningTextDeep },
    default: { bg: C.primary, hover: C.primaryHover },
  } as const;
  const c = map[variant] ?? map.default;
  return {
    background: c.bg, color: "#fff", border: "none",
    padding: "9px 18px", borderRadius: 8, fontSize: 14, fontWeight: 700,
    cursor: "pointer", minWidth: 84,
  };
}
const cancelBtnStyle: React.CSSProperties = {
  background: "#fff", color: C.textSecondary, border: `1px solid ${C.g300}`,
  padding: "9px 18px", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer", minWidth: 84,
};

export function ConfirmHost() {
  const req = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [inputVal, setInputVal] = React.useState("");
  const [inputErr, setInputErr] = React.useState<string | null>(null);
  const confirmBtnRef = React.useRef<HTMLButtonElement>(null);
  const inputRef = React.useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  // 새 요청이 뜰 때 입력 초기화 + focus (prompt: 입력창, 그 외: 확인 버튼)
  React.useEffect(() => {
    if (!req) return;
    if (req.kind === "prompt") { setInputVal(req.defaultValue ?? ""); setInputErr(null); }
    const t = setTimeout(() => {
      if (req.kind === "prompt") inputRef.current?.focus();
      else confirmBtnRef.current?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [req?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const settle = React.useCallback((r: Req, run: () => void) => {
    if (r._settled) return;            // exactly-once + 중복 클릭 방지
    r._settled = true;
    run();
    advance();
  }, []);

  const onCancel = React.useCallback(() => {
    if (!req) return;
    settle(req, () => {
      if (req.kind === "confirm") req.resolve(false);
      else if (req.kind === "prompt") req.resolve(null);
      else req.resolve();
    });
  }, [req, settle]);

  const onConfirm = React.useCallback(() => {
    if (!req) return;
    if (req.kind === "prompt") {
      const v = inputVal;
      const err = req.validate ? req.validate(v) : null;
      if (err) { setInputErr(err); inputRef.current?.focus(); return; }  // 검증 실패 시 resolve 안 함
      settle(req, () => req.resolve(v));
    } else if (req.kind === "confirm") {
      settle(req, () => req.resolve(true));
    } else {
      settle(req, () => req.resolve());
    }
  }, [req, inputVal, settle]);

  // ESC = 취소/닫기, Enter = 확인(단, 여러 줄 입력 textarea 제외)
  React.useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      else if (e.key === "Enter" && !(req.kind === "prompt" && req.multiline)) { e.preventDefault(); onConfirm(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req, onCancel, onConfirm]);

  if (!req) return null;
  const variant = req.variant ?? "default";
  const showCancel = req.kind !== "alert";
  const confirmLabel = req.confirmLabel ?? (req.kind === "alert" ? "확인" : "확인");
  const cancelLabel = req.cancelLabel ?? "취소";

  return createPortal(
    <div
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 10000, padding: "20px 16px",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={req.title ?? "확인"}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff", borderRadius: 14, border: `1px solid ${C.g200}`,
          width: "100%", maxWidth: 440, padding: "22px 24px",
          boxShadow: "0 20px 60px rgba(0,0,0,0.20)",
        }}
      >
        {req.title && (
          <div style={{ fontSize: 16, fontWeight: 800, color: variant === "danger" ? C.dangerText : C.textPrimary, marginBottom: 10 }}>
            {req.title}
          </div>
        )}
        {req.message && (
          <div style={{ fontSize: 13.5, color: C.textSecondary, lineHeight: 1.6, whiteSpace: "pre-line" }}>
            {req.message}
          </div>
        )}
        {req.kind === "prompt" && (
          <div style={{ marginTop: 14 }}>
            {req.label && <div style={{ fontSize: 12, fontWeight: 600, color: C.g700, marginBottom: 6 }}>{req.label}</div>}
            {req.multiline ? (
              <textarea
                ref={inputRef as React.RefObject<HTMLTextAreaElement>}
                value={inputVal} placeholder={req.placeholder}
                onChange={(e) => { setInputVal(e.target.value); if (inputErr) setInputErr(null); }}
                data-testid="prompt-input" aria-label={req.label ?? "입력"}
                style={{ width: "100%", minHeight: 72, padding: "9px 12px", borderRadius: 8, border: `1px solid ${inputErr ? C.danger : C.g300}`, fontSize: 14, resize: "vertical", boxSizing: "border-box" }}
              />
            ) : (
              <input
                ref={inputRef as React.RefObject<HTMLInputElement>}
                value={inputVal} placeholder={req.placeholder}
                onChange={(e) => { setInputVal(e.target.value); if (inputErr) setInputErr(null); }}
                data-testid="prompt-input" aria-label={req.label ?? "입력"}
                style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: `1px solid ${inputErr ? C.danger : C.g300}`, fontSize: 14, boxSizing: "border-box" }}
              />
            )}
            {inputErr && <div style={{ fontSize: 12, color: C.danger, marginTop: 6 }}>{inputErr}</div>}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          {showCancel && (
            <button type="button" onClick={onCancel} style={cancelBtnStyle} data-testid="dialog-cancel" aria-label={cancelLabel}>
              {cancelLabel}
            </button>
          )}
          <button ref={confirmBtnRef} type="button" onClick={onConfirm} style={confirmBtnStyle(variant)} data-testid="dialog-confirm" aria-label={confirmLabel}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
