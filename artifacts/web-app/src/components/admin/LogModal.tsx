import React, { useState, useEffect } from "react";
import { api, LogEntry, getActionLabel } from "../../lib/constants";
import { Card } from "../ui";

export function LogModal({ projectId, token, onClose }: { projectId: number; token: string; onClose: () => void }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(api(`/api/admin/logs/${projectId}`), {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (!res.ok) { setErr(data.error ?? "로그 조회 실패"); return; }
        setLogs(Array.isArray(data) ? data : []);
      } catch { setErr("서버 연결 실패"); }
      finally { setLoading(false); }
    })();
  }, [projectId, token]);

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300,
    }}>
      <Card style={{ width: "100%", maxWidth: 520, margin: "0 16px", maxHeight: "80vh", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>
            프로젝트 #{projectId} 이벤트 로그
          </h2>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#9ca3af", lineHeight: 1 }}>×</button>
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {loading ? (
            <p style={{ textAlign: "center", color: "#9ca3af", padding: "24px 0" }}>로딩 중...</p>
          ) : err ? (
            <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>
          ) : logs.length === 0 ? (
            <p style={{ textAlign: "center", color: "#9ca3af", padding: "24px 0", fontSize: 14 }}>로그가 없습니다.</p>
          ) : (
            <div style={{ padding: "4px 0" }}>
              {[...logs].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()).map((log, idx, arr) => {
                const info = getActionLabel(log.action);
                const isLast = idx === arr.length - 1;
                return (
                  <div key={log.id} style={{ display: "flex", gap: 0 }}>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 34, flexShrink: 0 }}>
                      <div style={{
                        width: 26, height: 26, borderRadius: "50%",
                        background: info.color + "18", border: `2px solid ${info.color}`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 12, flexShrink: 0,
                      }}>{info.dot}</div>
                      {!isLast && <div style={{ width: 2, flex: 1, minHeight: 14, background: "#e5e7eb" }} />}
                    </div>
                    <div style={{ flex: 1, paddingLeft: 10, paddingBottom: isLast ? 0 : 12, paddingTop: 2 }}>
                      <p style={{ margin: "0 0 2px", fontSize: 13, fontWeight: 600, color: info.color }}>{info.ko}</p>
                      <p style={{ margin: 0, fontSize: 11, color: "#9ca3af" }}>{new Date(log.createdAt).toLocaleString("ko-KR")}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
