// 계정별 미사용 자동 로그아웃(관리자 60분 · 직원 30분) — 내부 사용자(admin·staff) 화면에만 표시
//  · 실제 사용자 활동(마우스 이동·클릭·키보드·스크롤·터치)만 활동으로 기록 — 백그라운드 API·자동 갱신은 활동이 아니다.
//  · 마지막 활동 시각은 같은 로그인 세션의 모든 탭이 공유(localStorage) → 한 탭에서 활동·연장하면 모든 탭에 반영.
//  · 만료 판단은 실제 경과시간 기준(절전·백그라운드 탭 복귀 즉시 판정). 서버도 같은 기준으로 세션을 만료시킨다(requireAuth).
//  · 만료 2분 전 안내창 + 카운트다운. 안내 중에는 [로그인 연장]으로만 연장(서버 확인 — 이미 만료된 세션은 복구 불가).
//  · 미저장 입력이 있으면 경고만 표시한다(자료를 저장·확정하지 않는다).
import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, TOKEN_KEY } from "../../lib/constants";
import { idlePhase, shouldReportActivity, formatCountdown, sessionKeyOf, ACTIVITY_WRITE_THROTTLE_MS, type IdlePhase } from "../../lib/idleTimer";
import { idleStore, hasUnsavedInput } from "../../lib/sessionGuard";

const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "wheel", "touchstart", "pointerdown"] as const;

export function IdleLogoutGuard({ token, timeoutMinutes, onLogout }: {
  token: string; timeoutMinutes: number;
  onLogout: (reason: "idle" | "manual") => void;
}) {
  const sid = sessionKeyOf(token);
  const timeoutMs = timeoutMinutes * 60_000;
  const [phase, setPhase] = useState<IdlePhase>("active");
  const [remainingMs, setRemainingMs] = useState(timeoutMs);
  const [unsaved, setUnsaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const phaseRef = useRef<IdlePhase>("active");
  const lastWrite = useRef(0);
  const loggedOut = useRef(false);

  const report = useCallback(async (idleMs: number) => {
    try {
      return await fetch(api("/api/auth/heartbeat"), {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ activity: true, idleMs }),   // 실제 활동 보고 형식(서버는 이 형식만 활동으로 인정)
      });
    } catch { return null; }
  }, [token]);

  const logout = useCallback((reason: "idle" | "manual") => {
    if (loggedOut.current) return;
    loggedOut.current = true;
    onLogout(reason);
  }, [onLogout]);

  const tick = useCallback(() => {
    if (loggedOut.current) return;
    // 다른 탭에서 로그아웃·계정 변경됨 — 이 탭은 App(storage 이벤트)이 다시 불러온다. 활동 기록을 다시 만들지 않는다.
    if (localStorage.getItem(TOKEN_KEY) !== token) return;
    const now = Date.now();
    const last = idleStore.getLast(sid);
    // 기록이 없으면(다른 탭의 로그아웃으로 방금 지워짐 등) 판정·보고하지 않는다 — 기록은 화면 진입 시에만 만든다(아래 효과)
    if (last == null) return;
    const st = idlePhase(now, last, timeoutMs);
    phaseRef.current = st.phase;
    setPhase(st.phase); setRemainingMs(st.remainingMs);
    if (st.phase === "expired") { logout("idle"); return; }
    if (st.phase === "warning") { setUnsaved(hasUnsavedInput()); return; }
    // 활동 보고 — 마지막 보고 이후 실제 활동이 있을 때만(탭 간 공유 기록으로 중복 보고 방지)
    const lastReport = idleStore.getReport(sid) ?? 0;
    if (shouldReportActivity(now, last, lastReport)) { idleStore.setReport(sid, now); void report(now - last); }
  }, [sid, token, timeoutMs, logout, report]);

  // 실제 사용자 활동 기록 — 안내창이 떠 있는 동안에는 버튼으로만 연장
  useEffect(() => {
    const onActivity = (e: Event) => {
      if (!e.isTrusted || phaseRef.current !== "active") return;
      const now = Date.now();
      if (now - lastWrite.current < ACTIVITY_WRITE_THROTTLE_MS) return;
      lastWrite.current = now;
      if (localStorage.getItem(TOKEN_KEY) !== token) return;   // 다른 탭에서 로그아웃·계정 변경됨 — 기록하지 않음
      idleStore.setLast(sid, now);
    };
    ACTIVITY_EVENTS.forEach(ev => window.addEventListener(ev, onActivity, { capture: true, passive: true }));
    document.addEventListener("scroll", onActivity, { capture: true, passive: true });
    return () => {
      ACTIVITY_EVENTS.forEach(ev => window.removeEventListener(ev, onActivity, { capture: true }));
      document.removeEventListener("scroll", onActivity, { capture: true });
    };
  }, [sid, token]);

  // 1초 주기 판정 + 다른 탭의 활동·연장(storage) · 화면 복귀(visibility) 즉시 판정
  useEffect(() => {
    // 화면 진입(로그인 직후·새 탭) 시 이 세션의 활동 기록이 없으면 지금으로 시작. 기존 기록이 있으면 그대로 판정(절전·재방문 경과 반영).
    if (localStorage.getItem(TOKEN_KEY) === token && idleStore.getLast(sid) == null) idleStore.setLast(sid, Date.now());
    tick();
    const t = window.setInterval(tick, 1000);
    const onStorage = (e: StorageEvent) => { if (e.key === idleStore.lastKey(sid)) tick(); };
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", tick);
    return () => { window.clearInterval(t); window.removeEventListener("storage", onStorage); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", tick); };
  }, [tick, sid, token]);

  const extend = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // 판정 직전 다시 확인 — 이미 만료됐으면 연장하지 않는다
      const last = idleStore.getLast(sid) ?? Date.now();
      if (idlePhase(Date.now(), last, timeoutMs).phase === "expired") { logout("idle"); return; }
      const res = await report(0);
      if (res?.ok) { const now = Date.now(); idleStore.setLast(sid, now); idleStore.setReport(sid, now); tick(); return; }
      if (res && res.status === 401) { logout("idle"); return; }   // 서버에서 이미 만료·종료된 세션 — 복구 불가
      // 네트워크 오류 — 안내창 유지(남은 시간 안에 다시 시도)
    } finally { setBusy(false); }
  };

  if (phase !== "warning") return null;
  const adminTier = timeoutMinutes >= 60;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(15,23,42,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
      data-testid="idle-logout-overlay">
      <div role="alertdialog" aria-modal="true" aria-labelledby="idle-logout-title" aria-describedby="idle-logout-desc" data-testid="idle-logout-dialog"
        style={{ width: 420, maxWidth: "calc(100vw - 32px)", background: "#fff", borderRadius: 12, boxShadow: "0 20px 50px rgba(0,0,0,0.25)", padding: "22px 24px" }}>
        <div id="idle-logout-title" style={{ fontSize: 16, fontWeight: 800, color: "#111827", marginBottom: 10 }}>자동 로그아웃 안내</div>
        <p id="idle-logout-desc" style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: "#374151" }} data-testid="idle-logout-message">
          장시간 사용하지 않아 회사정보 및 개인정보 보호를 위해 자동 로그아웃됩니다.
        </p>
        <div style={{ margin: "14px 0 4px", fontSize: 13, color: "#6b7280" }}>
          자동 로그아웃까지 <b data-testid="idle-logout-countdown" aria-live="polite" style={{ fontSize: 18, color: "#dc2626", fontVariantNumeric: "tabular-nums" }}>{formatCountdown(remainingMs)}</b>
          <span style={{ marginLeft: 6 }}>(미사용 {adminTier ? "60" : "30"}분 기준)</span>
        </div>
        {unsaved && (
          <div role="alert" data-testid="idle-logout-unsaved" style={{ marginTop: 10, padding: "9px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, fontSize: 13, color: "#b91c1c", lineHeight: 1.5 }}>
            저장하지 않은 작성·수정 내용이 있습니다. 자동 로그아웃되면 저장되지 않은 내용은 사라집니다.
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <button type="button" onClick={() => logout("manual")} data-testid="idle-logout-now" aria-label="로그아웃"
            style={{ padding: "9px 16px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>로그아웃</button>
          <button type="button" onClick={extend} disabled={busy} data-testid="idle-logout-extend" aria-label="로그인 연장" autoFocus
            style={{ padding: "9px 16px", borderRadius: 8, border: "none", background: "#2563eb", color: "#fff", fontWeight: 700, fontSize: 13, cursor: busy ? "default" : "pointer", opacity: busy ? 0.7 : 1 }}>
            {busy ? "확인 중…" : "로그인 연장"}
          </button>
        </div>
      </div>
    </div>
  );
}
