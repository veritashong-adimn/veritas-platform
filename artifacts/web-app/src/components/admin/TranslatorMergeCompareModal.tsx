import React, { useState, useEffect, useCallback } from "react";
import { api } from "../../lib/constants";
import { PrimaryBtn, GhostBtn } from "../ui";
import { DraggableModal } from "./DraggableModal";

// 통번역사 수동 통합 — 비교 · 미리보기 (Phase 2: 선택·비교·미리보기까지만. 실제 통합 실행은 비활성).
//  · Phase 1 읽기전용 API(POST /admin/translators/merge-preview) 연결. DB 변경 없음.
//  · 수행이력은 '확정 귀속'(주민번호 기반) / '확인 필요'(이름만 일치)로 구분 — 이름만 일치는 자동 귀속하지 않음.

type HistInfo = { count: number; basis: "rrn" | "name" | "none"; ambiguous: boolean };
interface MasterInfo {
  id: number; name: string; isNew: boolean; source: string;
  operationalStatus: string | null; createdAt: string | null;
  hasResidentNumber: boolean; residentNumberMasked: string | null;
  phones: string[]; emails: string[];
  languagePairs: string | null; education: string | null; specializations: string | null; workTypes: string[];
  crmLegacyIds: string[];
  history: HistInfo; sales: { count: number; basis: string };
  payout: { settlementCount: number; settlementAmount: number; payoutItemCount: number; transferCount: number; totalPaid: number };
  direct: { tasks: number; performance: number };
}
interface MergePreviewResp {
  masters: MasterInfo[];
  signals: { allSameName: boolean; nameMismatch: boolean; distinctValidRrnCount: number; rrnConflict: boolean; sharedRrn: boolean; sharedPhone: boolean; sharedEmail: boolean };
  guard: { blocked: boolean; reasons: string[]; warnings: string[] };
  preview: null | {
    representativeId: number; mergedMasterIds: number[];
    finalHistoryCount: number; finalSalesCount: number;
    settlementCount: number; settlementAmount: number; payoutTransferCount: number; totalPaid: number;
    ambiguousHistory: boolean;
  };
}

const won = (n: number) => `₩${(n ?? 0).toLocaleString()}`;
const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", fontSize: 11, color: "#6b7280", fontWeight: 600, borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap", background: "#f9fafb", position: "sticky", left: 0 };
const td: React.CSSProperties = { padding: "8px 10px", fontSize: 12, color: "#111827", borderBottom: "1px solid #f3f4f6", verticalAlign: "top" };

function Badge({ text, bg, color }: { text: string; bg: string; color: string }) {
  return <span style={{ background: bg, color, borderRadius: 4, padding: "1px 6px", fontSize: 10, fontWeight: 700, whiteSpace: "nowrap" }}>{text}</span>;
}

export function TranslatorMergeCompareModal({ token, masterIds, onClose, onMerged }: { token: string; masterIds: number[]; onClose: () => void; onMerged?: () => void }) {
  const [data, setData] = useState<MergePreviewResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [representativeId, setRepresentativeId] = useState<number | null>(null);
  // Phase 3 실행 상태
  const [samePersonConfirmed, setSamePersonConfirmed] = useState(false);
  const [dryRun, setDryRun] = useState<any | null>(null);
  const [execMsg, setExecMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const callExecute = useCallback(async (commit: boolean) => {
    if (!representativeId) return;
    setBusy(true); setExecMsg(null);
    try {
      const body: any = { masterIds, representativeId, samePersonConfirmed, commit };
      if (commit && dryRun?.confirmToken) body.confirmToken = dryRun.confirmToken;
      const res = await fetch(api("/api/admin/translators/merge-execute"), {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await res.json();
      if (res.status === 409 && d?.code === "SCHEMA_NOT_APPLIED") { setExecMsg("⚠ 통합 테이블(translator_merges)이 운영 DB에 아직 생성되지 않아 통합이 실행되지 않았습니다. 대표 승인 후 스키마 적용(sql/translator_merges.sql)이 필요합니다. ※ 데이터는 변경되지 않았습니다."); return; }
      if (!res.ok) { setExecMsg("실행 실패: " + (d?.error ?? `HTTP ${res.status}`) + " ※ 통합이 적용되지 않았습니다."); return; }
      if (d.blocked) { setExecMsg("차단: " + (d.reasons ?? []).join(" / ")); setDryRun(commit ? dryRun : d); return; }
      if (!commit) { setDryRun(d); setExecMsg(null); return; }
      // §10 실제 적용(committed=true)일 때만 성공 처리 — 그 외는 실패로 표시(거짓 성공 방지).
      if (d.committed === true) {
        setExecMsg(`✅ 통합 완료 — 대표 #${d.representativeId}, 통합 ${d.mergedMasterIds?.length ?? 0}건 (불변식 ${d.invariantsOk ? "유지" : "확인필요"})`);
        onMerged?.();   // §7 목록 새로고침 + 선택 해제(캐시 무효화) 트리거
      } else {
        setExecMsg("⚠ 통합이 적용되지 않았습니다(committed=false). " + ((d.reasons ?? []).join(" / ") || "DRY-RUN 후 다시 시도하세요."));
      }
    } catch { setExecMsg("네트워크 오류 — 통합이 적용되지 않았습니다."); }
    finally { setBusy(false); }
  }, [token, masterIds, representativeId, samePersonConfirmed, dryRun, onMerged]);

  const load = useCallback(async (repId: number | null) => {
    setLoading(true); setErr(null);
    try {
      const res = await fetch(api("/api/admin/translators/merge-preview"), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ masterIds, representativeId: repId ?? undefined }),
      });
      const d = await res.json();
      if (!res.ok) { setErr(d?.error ?? "미리보기 조회 실패"); setData(null); }
      else setData(d);
    } catch { setErr("네트워크 오류"); setData(null); }
    finally { setLoading(false); }
  }, [token, masterIds, representativeId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setDryRun(null); setExecMsg(null); load(representativeId); }, [representativeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const masters = data?.masters ?? [];
  const blocked = data?.guard?.blocked ?? false;
  const histLabel = (h: HistInfo) => h.count === 0
    ? <span style={{ color: "#9ca3af" }}>0</span>
    : <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
        <b>{h.count}건</b>
        {h.basis === "rrn"
          ? <Badge text="확정 귀속" bg="#ecfdf5" color="#047857" />
          : <Badge text="확인 필요(이름만)" bg="#fef3c7" color="#92400e" />}
      </span>;

  const fieldRows: { label: string; render: (m: MasterInfo) => React.ReactNode }[] = [
    { label: "Master ID", render: (m) => <b>#{m.id}</b> },
    { label: "등록 출처", render: (m) => <Badge text={m.source} bg={m.isNew ? "#ecfdf5" : "#f3f4f6"} color={m.isNew ? "#047857" : "#4b5563"} /> },
    { label: "운영상태", render: (m) => m.operationalStatus ?? "-" },
    { label: "주민번호", render: (m) => m.hasResidentNumber ? <span style={{ fontFamily: "monospace" }}>{m.residentNumberMasked}</span> : <span style={{ color: "#d1d5db" }}>미보유</span> },
    { label: "휴대전화", render: (m) => m.phones.join(", ") || <span style={{ color: "#d1d5db" }}>-</span> },
    { label: "이메일", render: (m) => m.emails.join(", ") || <span style={{ color: "#d1d5db" }}>-</span> },
    { label: "가능언어", render: (m) => m.languagePairs || <span style={{ color: "#d1d5db" }}>-</span> },
    { label: "전문분야", render: (m) => m.specializations || <span style={{ color: "#d1d5db" }}>-</span> },
    { label: "학력", render: (m) => m.education || <span style={{ color: "#d1d5db" }}>-</span> },
    { label: "업무유형", render: (m) => m.workTypes.join(", ") || <span style={{ color: "#d1d5db" }}>-</span> },
    { label: "CRM 원본연결", render: (m) => m.crmLegacyIds.length ? m.crmLegacyIds.join(", ") : <span style={{ color: "#d1d5db" }}>-</span> },
    { label: "진행관리표 수행이력", render: (m) => histLabel(m.history) },
    { label: "판매목록 연결", render: (m) => `${m.sales.count}건` },
    { label: "정산 이력", render: (m) => `${m.payout.settlementCount}건 / ${won(m.payout.settlementAmount)}` },
    { label: "지급 이력(실지급)", render: (m) => `${m.payout.transferCount}건` },
    { label: "누적 지급", render: (m) => <b>{won(m.payout.totalPaid)}</b> },
    { label: "등록일", render: (m) => (m.createdAt ? String(m.createdAt).slice(0, 10) : "-") },
  ];

  return (
    <DraggableModal title="통번역사 통합 비교 · 미리보기" subtitle="대표 지정 → 동일인 확인 → DRY-RUN → 최종 통합 실행 (명백한 신원 충돌만 차단)" width={Math.min(1100, 360 + masters.length * 230)} onClose={onClose} resizable>
      {loading ? (
        <div style={{ textAlign: "center", padding: "40px 0", color: "#9ca3af" }}>불러오는 중…</div>
      ) : err ? (
        <div style={{ padding: 16, color: "#b91c1c", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8 }}>{err}</div>
      ) : (
        <div>
          {/* 가드(하드 차단: 명백한 신원 충돌만) / 경고 / 참고신호 */}
          {blocked ? (
            <div data-testid="merge-guard-blocked" style={{ marginBottom: 14, padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#b91c1c", fontSize: 13 }}>
              <b>통합 차단 — 명백한 신원 충돌/구조 오류</b>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{(data?.guard.reasons ?? []).map((r, i) => <li key={i}>{r}</li>)}</ul>
            </div>
          ) : (
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
                {data?.signals.sharedRrn && <Badge text="주민번호 일치" bg="#ecfdf5" color="#047857" />}
                {data?.signals.sharedPhone && <Badge text="전화 일치" bg="#eff6ff" color="#1d4ed8" />}
                {data?.signals.sharedEmail && <Badge text="이메일 일치" bg="#eff6ff" color="#1d4ed8" />}
                {!data?.signals.sharedRrn && !data?.signals.sharedPhone && !data?.signals.sharedEmail &&
                  <Badge text="공유 식별자 없음 — 동일인 확인 체크로 진행 가능" bg="#fef3c7" color="#92400e" />}
              </div>
              {(data?.guard.warnings ?? []).length > 0 && (
                <ul data-testid="merge-guard-warnings" style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, color: "#92400e" }}>
                  {(data?.guard.warnings ?? []).map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
            </div>
          )}

          {/* 대표 Master 선택 + 비교표 */}
          <div style={{ overflowX: "auto", border: "1px solid #e5e7eb", borderRadius: 8 }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 360 + masters.length * 200 }}>
              <thead>
                <tr>
                  <th style={{ ...th, minWidth: 130 }}>항목</th>
                  {masters.map((m) => (
                    <th key={m.id} style={{ ...th, left: "auto", position: "static", background: representativeId === m.id ? "#eef2ff" : "#f9fafb", minWidth: 190 }}>
                      <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }} data-testid={`rep-radio-${m.id}`}>
                        <input type="radio" name="rep" checked={representativeId === m.id} onChange={() => setRepresentativeId(m.id)} />
                        <span style={{ fontWeight: 700, color: "#111827" }}>{m.name}</span>
                        {representativeId === m.id && <Badge text="대표" bg="#4f46e5" color="#fff" />}
                      </label>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {fieldRows.map((fr) => (
                  <tr key={fr.label}>
                    <td style={{ ...th, position: "sticky", left: 0, fontWeight: 600, color: "#374151" }}>{fr.label}</td>
                    {masters.map((m) => (
                      <td key={m.id} style={{ ...td, background: representativeId === m.id ? "#f8f9ff" : undefined }}>{fr.render(m)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 통합 후 미리보기 */}
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#111827", marginBottom: 8 }}>통합 후 미리보기</div>
            {!representativeId ? (
              <div style={{ color: "#9ca3af", fontSize: 13, padding: "10px 0" }}>대표 Master를 선택하면 통합 후 결과를 미리봅니다.</div>
            ) : blocked ? (
              <div style={{ color: "#b91c1c", fontSize: 13 }}>통합 제한 상태에서는 미리보기를 제공하지 않습니다.</div>
            ) : data?.preview ? (
              <div data-testid="merge-preview-result" style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "12px 16px", fontSize: 13, lineHeight: 1.9 }}>
                <div>유지할 대표 Master: <b>#{data.preview.representativeId}</b> · 통합(숨김) 대상: {data.preview.mergedMasterIds.map((i) => `#${i}`).join(", ") || "-"}</div>
                <div>통합 후 진행관리표 수행이력(record-id 중복제거): <b>{data.preview.finalHistoryCount}건</b>
                  {data.preview.ambiguousHistory && <span style={{ marginLeft: 8 }}><Badge text="이름기반 포함 — 확인 필요" bg="#fef3c7" color="#92400e" /></span>}</div>
                <div>통합 후 판매목록 연결: <b>{data.preview.finalSalesCount}건</b></div>
                <div>정산 이력: <b>{data.preview.settlementCount}건</b> / {won(data.preview.settlementAmount)} · 실지급: <b>{data.preview.payoutTransferCount}건</b></div>
                <div>누적 지급(실지급 합계): <b>{won(data.preview.totalPaid)}</b></div>
                <div style={{ marginTop: 6, color: "#64748b", fontSize: 12 }}>※ 원본(진행관리표·판매목록·지급)은 변경되지 않으며, 중복 기록은 record-id 기준으로 1회만 집계됩니다.</div>
              </div>
            ) : null}
          </div>

          {/* 실행 패널 (Phase 3) — 대표 지정 + 동일인 확인 + DRY-RUN → 최종 실행 */}
          {representativeId && !blocked && (
            <div style={{ marginTop: 18, borderTop: "1px solid #e5e7eb", paddingTop: 14 }}>
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: "#374151", cursor: "pointer", marginBottom: 10 }} data-testid="merge-sameperson-confirm">
                <input type="checkbox" checked={samePersonConfirmed} onChange={(e) => setSamePersonConfirmed(e.target.checked)} style={{ marginTop: 2 }} />
                <span><b>실제 동일인임을 확인합니다.</b> {data?.signals && !data.signals.sharedRrn && !data.signals.sharedPhone && !data.signals.sharedEmail && <span style={{ color: "#b45309" }}>(주민번호·전화·이메일이 없어도 이 확인으로 통합할 수 있습니다, §1·§2)</span>} 진행관리표의 이름기반 이력은 자동 귀속되지 않습니다(§7·§8).</span>
              </label>

              {dryRun && (
                <div data-testid="merge-dryrun-panel" style={{ background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: 8, padding: "10px 14px", fontSize: 12.5, marginBottom: 10 }}>
                  <b>DRY-RUN 결과 (실행 전 확인)</b>
                  <div style={{ marginTop: 4 }}>대표 #{dryRun.representativeId} ← 통합 {(dryRun.mergedMasterIds ?? []).map((i: number) => `#${i}`).join(", ")}</div>
                  <div>재지정 예정: {(dryRun.plan ?? []).filter((x: any) => x.count > 0).map((x: any) => `${x.table} ${x.count}건`).join(", ") || "FK 직접참조 없음(영구매핑만)"}</div>
                  {dryRun.ambiguousHistory && <div style={{ color: "#92400e" }}>⚠ 이름기반 수행이력 포함 — 자동 귀속 안 함(기록별 확인 대상)</div>}
                  <div style={{ color: "#64748b" }}>원본(진행관리표·판매목록·지급)은 변경되지 않으며, 전후 건수·금액은 불변입니다.</div>
                </div>
              )}

              {execMsg && <div style={{ fontSize: 12.5, color: execMsg.startsWith("✅") ? "#047857" : "#b45309", marginBottom: 10 }}>{execMsg}</div>}

              {(() => {
                // 화면 버튼 활성화 기준 = 실제 실행 가능 여부와 일치(§3·§4):
                //  DRY-RUN 통과(하드 차단 없음) + 현재 '동일인 확인' 체크됨.
                const dryPassed = !!dryRun && !dryRun.blocked;
                const canExecute = dryPassed && samePersonConfirmed;
                const reason = !dryRun ? "먼저 DRY-RUN 을 실행하세요"
                  : dryRun.blocked ? "차단 상태에서는 실행할 수 없습니다"
                  : !samePersonConfirmed ? "'실제 동일인임을 확인합니다' 체크가 필요합니다" : "";
                return (
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, alignItems: "center" }}>
                    {!canExecute && <span style={{ fontSize: 12, color: "#9ca3af", marginRight: "auto" }}>{reason}</span>}
                    <GhostBtn onClick={onClose}>닫기</GhostBtn>
                    <GhostBtn onClick={() => callExecute(false)} disabled={busy} data-testid="merge-dryrun-btn">① 통합 DRY-RUN</GhostBtn>
                    <PrimaryBtn onClick={() => callExecute(true)} disabled={busy || !canExecute}
                      data-testid="merge-execute-btn"
                      title={reason}
                      style={{ opacity: canExecute ? 1 : 0.5, cursor: (busy || !canExecute) ? "not-allowed" : "pointer" }}>
                      ② 최종 통합 실행
                    </PrimaryBtn>
                  </div>
                );
              })()}
            </div>
          )}
          {!representativeId && (
            <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <GhostBtn onClick={onClose}>닫기</GhostBtn>
            </div>
          )}
        </div>
      )}
    </DraggableModal>
  );
}
