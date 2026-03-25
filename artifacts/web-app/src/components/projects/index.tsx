import React from "react";
import { Project, Task, PaymentPanel, PROJECT_STEPS, PROJECT_STEP_KEYS } from "../../lib/constants";
import { Card, StatusBadge, PrimaryBtn, GhostBtn } from "../ui";

export function ProjectStatusStepper({ status }: { status: string }) {
  if (status === "cancelled") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 12, color: "#dc2626", fontWeight: 600 }}>✗ 취소됨</span>
      </div>
    );
  }
  const currentIdx = PROJECT_STEP_KEYS.indexOf(status as typeof PROJECT_STEP_KEYS[number]);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0, overflowX: "auto", paddingBottom: 2 }}>
      {PROJECT_STEPS.map((step, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        return (
          <div key={step.key} style={{ display: "flex", alignItems: "center" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
              <div style={{
                width: 22, height: 22, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 10, fontWeight: 700,
                background: done ? "#2563eb" : active ? "#2563eb" : "#e5e7eb",
                color: (done || active) ? "#fff" : "#9ca3af",
                border: active ? "2px solid #1d4ed8" : "2px solid transparent",
                boxShadow: active ? "0 0 0 3px #bfdbfe" : "none",
              }}>
                {done ? "✓" : i + 1}
              </div>
              <span style={{
                fontSize: 9, fontWeight: active ? 700 : 500,
                color: (done || active) ? "#2563eb" : "#9ca3af",
                whiteSpace: "nowrap",
              }}>{step.label}</span>
            </div>
            {i < PROJECT_STEPS.length - 1 && (
              <div style={{
                width: 20, height: 2, marginBottom: 12,
                background: done ? "#2563eb" : "#e5e7eb", flexShrink: 0,
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ProjectCard({
  project, token, onPaymentRequest,
}: {
  project: Project; token: string; onPaymentRequest: (projectId: number) => void;
}) {
  const isApproved = project.status === "approved";
  const isCancelled = project.status === "cancelled";

  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <p style={{ margin: 0, fontSize: 11, color: "#9ca3af", marginBottom: 4 }}>
            #{project.id} · {new Date(project.createdAt).toLocaleDateString("ko-KR")}
          </p>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>{project.title}</h3>
        </div>
        <StatusBadge status={project.status} />
      </div>

      {!isCancelled && (
        <div style={{ paddingTop: 4 }}>
          <ProjectStatusStepper status={project.status} />
        </div>
      )}

      {isCancelled && (
        <div style={{ padding: "8px 12px", background: "#fef2f2", borderRadius: 8, fontSize: 12, color: "#dc2626" }}>
          이 프로젝트는 취소되었습니다.
        </div>
      )}

      {isApproved && (
        <div style={{ padding: "8px 12px", background: "#eff6ff", borderRadius: 8, fontSize: 12, color: "#2563eb", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>견적이 승인되었습니다. 결제를 진행해 주세요.</span>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {project.fileUrl && (
          <a href={project.fileUrl} target="_blank" rel="noreferrer" style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            padding: "6px 12px", borderRadius: 8,
            border: "1px solid #d1d5db", background: "#f9fafb",
            color: "#374151", fontSize: 13, textDecoration: "none", fontWeight: 500,
          }}>
            <span>📎</span> 첨부파일 다운로드
          </a>
        )}
        {isApproved && (
          <button onClick={() => onPaymentRequest(project.id)} style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            padding: "7px 14px", borderRadius: 8,
            border: "none", background: "#0891b2",
            color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}>
            💳 결제하기
          </button>
        )}
      </div>
    </Card>
  );
}

export function PaymentModal({
  panel, onConfirm, onClose, acting,
}: {
  panel: NonNullable<PaymentPanel>; onConfirm: (success: boolean) => void; onClose: () => void; acting: boolean;
}) {
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200,
    }}>
      <Card style={{ width: "100%", maxWidth: 420, margin: "0 16px" }}>
        <h2 style={{ margin: "0 0 6px", fontSize: 18, fontWeight: 700, color: "#111827" }}>결제</h2>
        <p style={{ margin: "0 0 20px", fontSize: 13, color: "#6b7280" }}>프로젝트 #{panel.projectId}</p>
        <div style={{ background: "#f9fafb", borderRadius: 10, padding: "20px", textAlign: "center", marginBottom: 20 }}>
          <p style={{ margin: "0 0 4px", fontSize: 13, color: "#6b7280" }}>결제 금액</p>
          <p style={{ margin: 0, fontSize: 28, fontWeight: 800, color: "#0891b2" }}>
            {panel.amount.toLocaleString()}<span style={{ fontSize: 16, marginLeft: 4 }}>원</span>
          </p>
        </div>
        <div style={{ background: "#fffbeb", borderRadius: 8, padding: "10px 14px", marginBottom: 20 }}>
          <p style={{ margin: 0, fontSize: 12, color: "#92400e" }}>테스트 환경 — 아래 버튼으로 결제 성공/실패를 시뮬레이션합니다.</p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => onConfirm(true)} disabled={acting} style={{
            flex: 1, padding: "11px", borderRadius: 8, border: "none",
            background: acting ? "#86efac" : "#16a34a", color: "#fff",
            fontSize: 14, fontWeight: 700, cursor: acting ? "not-allowed" : "pointer",
          }}>
            {acting ? "처리중..." : "결제 완료"}
          </button>
          <GhostBtn onClick={() => onConfirm(false)} disabled={acting} color="#dc2626">결제 실패</GhostBtn>
          <GhostBtn onClick={onClose} disabled={acting}>취소</GhostBtn>
        </div>
      </Card>
    </div>
  );
}

export function TaskCard({
  task, token, onAction,
}: {
  task: Task; token: string; onAction: (taskId: number, action: "start" | "complete") => void;
}) {
  const canStart = task.status === "waiting" || task.status === "assigned";
  const canComplete = task.status === "working";
  const isDone = task.status === "done";

  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <p style={{ margin: 0, fontSize: 11, color: "#9ca3af", marginBottom: 4 }}>
            작업 #{task.id} · 프로젝트 #{task.projectId}
          </p>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>
            {task.projectTitle ?? `프로젝트 #${task.projectId}`}
          </h3>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <StatusBadge status={task.status} />
          {task.projectStatus && task.projectStatus !== task.status && (
            <StatusBadge status={task.projectStatus} />
          )}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {canStart && (
          <PrimaryBtn onClick={() => onAction(task.id, "start")} style={{ background: "#d97706" }}>작업 시작</PrimaryBtn>
        )}
        {canComplete && (
          <PrimaryBtn onClick={() => onAction(task.id, "complete")} style={{ background: "#059669" }}>작업 완료</PrimaryBtn>
        )}
        {isDone && (
          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#059669", fontWeight: 600, fontSize: 14 }}>
            <span style={{ fontSize: 18 }}>✓</span> 완료됨
          </div>
        )}
      </div>
    </Card>
  );
}
