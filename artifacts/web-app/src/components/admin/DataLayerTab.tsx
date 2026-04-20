import React, { useState, useCallback, useEffect } from 'react';
import { api } from '../../lib/constants';
import { Card, PrimaryBtn, GhostBtn, ClickSelect } from '../ui';

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 0" }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#111827" }}>{title}</h2>
        {sub && <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6b7280" }}>{sub}</p>}
      </div>
      {children}
    </div>
  );
}

type TuUnit = {
  id: number; projectId: number; segmentIndex: number; taskId: number | null;
  sourceText: string; targetText: string; sourceLang: string; targetLang: string;
  domain: string | null; qualityLevel: string | null; securityLevel: string;
  isAnonymized: boolean; anonymizedSourceText: string | null; anonymizedTargetText: string | null;
  sourceCharCount: number; targetCharCount: number; sourceWordCount: number; targetWordCount: number;
  translatorId: number | null; status: string; createdAt: string; updatedAt: string;
  logs?: { id: number; action: string; actorUserId: number | null; oldValue: string | null; newValue: string | null; createdAt: string }[];
};
type TuStats = {
  total: number;
  byStatus: { status: string; count: number }[];
  byDomain: { domain: string | null; count: number }[];
  byLang: { sourceLang: string; targetLang: string; count: number }[];
};

const EMPTY_FILTER = { projectId: "", sourceLang: "", targetLang: "", domain: "", qualityLevel: "", securityLevel: "", status: "active", q: "" };

export function DataLayerTab({ token, setToast }: { token: string; setToast: (msg: string) => void }) {
  const authHeaders = { Authorization: `Bearer ${token}` };

  const [tuUnits, setTuUnits] = useState<TuUnit[]>([]);
  const [tuTotal, setTuTotal] = useState(0);
  const [tuPage, setTuPage] = useState(1);
  const tuLimit = 50;
  const [tuLoading, setTuLoading] = useState(false);
  const [tuStats, setTuStats] = useState<TuStats | null>(null);
  const [tuSelectedId, setTuSelectedId] = useState<number | null>(null);
  const [tuDetailData, setTuDetailData] = useState<TuUnit | null>(null);
  const [tuFilter, setTuFilter] = useState(EMPTY_FILTER);
  const [tuAddOpen, setTuAddOpen] = useState(false);
  const [tuAddForm, setTuAddForm] = useState({ projectId: "", sourceText: "", targetText: "", sourceLang: "ko", targetLang: "en", domain: "general" });
  const [tuAddLoading, setTuAddLoading] = useState(false);
  const [tuActionLoading, setTuActionLoading] = useState(false);

  const fetchTuStats = useCallback(async () => {
    try {
      const res = await fetch(api("/api/admin/translation-units/stats"), { headers: authHeaders });
      if (res.ok) setTuStats(await res.json());
    } catch {}
  }, [token]);

  const fetchTuUnits = useCallback(async (page = 1, filter = tuFilter) => {
    setTuLoading(true);
    try {
      const params = new URLSearchParams();
      if (filter.projectId) params.set("projectId", filter.projectId);
      if (filter.sourceLang) params.set("sourceLang", filter.sourceLang);
      if (filter.targetLang) params.set("targetLang", filter.targetLang);
      if (filter.domain) params.set("domain", filter.domain);
      if (filter.qualityLevel) params.set("qualityLevel", filter.qualityLevel);
      if (filter.securityLevel) params.set("securityLevel", filter.securityLevel);
      if (filter.status) params.set("status", filter.status);
      if (filter.q) params.set("q", filter.q);
      params.set("page", String(page));
      params.set("limit", String(tuLimit));
      const res = await fetch(api(`/api/admin/translation-units?${params.toString()}`), { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        setTuUnits(data.data ?? []);
        setTuTotal(data.total ?? 0);
        setTuPage(page);
      }
    } catch { setToast("오류: 번역 데이터 조회 실패"); }
    finally { setTuLoading(false); }
  }, [token, tuFilter, tuLimit]);

  const fetchTuDetail = useCallback(async (id: number) => {
    const res = await fetch(api(`/api/admin/translation-units/${id}`), { headers: authHeaders });
    if (res.ok) setTuDetailData(await res.json());
  }, [token]);

  useEffect(() => {
    fetchTuStats();
    fetchTuUnits(1, EMPTY_FILTER);
  }, []);

  return (
    <Section title="번역 데이터 관리" sub="번역 세그먼트 자산을 관리합니다. 보안 등급 기본값: restricted.">
      {tuStats && (
        <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
          <Card style={{ padding: "14px 20px", minWidth: 120 }}>
            <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>총 유닛</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: "#0ea5e9" }}>{tuStats.total.toLocaleString()}</div>
          </Card>
          {tuStats.byStatus.map(s => (
            <Card key={s.status} style={{ padding: "14px 20px", minWidth: 100 }}>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>{s.status}</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: s.status === "active" ? "#059669" : s.status === "excluded" ? "#dc2626" : "#f59e0b" }}>{s.count.toLocaleString()}</div>
            </Card>
          ))}
          <Card style={{ padding: "14px 20px", minWidth: 160 }}>
            <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>언어쌍 분포</div>
            {tuStats.byLang.slice(0, 4).map(l => (
              <div key={`${l.sourceLang}-${l.targetLang}`} style={{ fontSize: 12, color: "#374151" }}>
                {l.sourceLang}→{l.targetLang}: <b>{l.count}</b>
              </div>
            ))}
          </Card>
          <Card style={{ padding: "14px 20px", minWidth: 160 }}>
            <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>도메인 분포</div>
            {tuStats.byDomain.slice(0, 5).map(d => (
              <div key={d.domain ?? "null"} style={{ fontSize: 12, color: "#374151" }}>
                {d.domain ?? "general"}: <b>{d.count}</b>
              </div>
            ))}
          </Card>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input placeholder="키워드 검색 (원문/번역문)" value={tuFilter.q}
          onChange={e => setTuFilter(p => ({ ...p, q: e.target.value }))}
          style={{ padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, width: 200 }} />
        <input placeholder="프로젝트 ID" value={tuFilter.projectId}
          onChange={e => setTuFilter(p => ({ ...p, projectId: e.target.value }))}
          style={{ padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, width: 110 }} />
        <ClickSelect value={tuFilter.sourceLang} onChange={v => setTuFilter(p => ({ ...p, sourceLang: v }))}
          options={[{ value: "", label: "원문 언어" }, { value: "ko", label: "한국어" }, { value: "en", label: "영어" }, { value: "ja", label: "일본어" }, { value: "zh", label: "중국어" }]}
          triggerStyle={{ fontSize: 12, padding: "6px 8px" }} />
        <ClickSelect value={tuFilter.targetLang} onChange={v => setTuFilter(p => ({ ...p, targetLang: v }))}
          options={[{ value: "", label: "번역 언어" }, { value: "ko", label: "한국어" }, { value: "en", label: "영어" }, { value: "ja", label: "일본어" }, { value: "zh", label: "중국어" }]}
          triggerStyle={{ fontSize: 12, padding: "6px 8px" }} />
        <ClickSelect value={tuFilter.domain} onChange={v => setTuFilter(p => ({ ...p, domain: v }))}
          options={[{ value: "", label: "도메인" }, ...["general","legal","finance","medical","it","marketing","technical","other"].map(d => ({ value: d, label: d }))]}
          triggerStyle={{ fontSize: 12, padding: "6px 8px" }} />
        <ClickSelect value={tuFilter.securityLevel} onChange={v => setTuFilter(p => ({ ...p, securityLevel: v }))}
          options={[{ value: "", label: "보안등급" }, ...["public","internal","restricted","confidential"].map(s => ({ value: s, label: s }))]}
          triggerStyle={{ fontSize: 12, padding: "6px 8px" }} />
        <ClickSelect value={tuFilter.status} onChange={v => setTuFilter(p => ({ ...p, status: v }))}
          options={[{ value: "", label: "전체 상태" }, { value: "active", label: "active" }, { value: "excluded", label: "excluded" }, { value: "flagged", label: "flagged" }]}
          triggerStyle={{ fontSize: 12, padding: "6px 8px" }} />
        <GhostBtn onClick={() => fetchTuUnits(1, tuFilter)} disabled={tuLoading}>검색</GhostBtn>
        <GhostBtn onClick={() => { setTuFilter(EMPTY_FILTER); fetchTuUnits(1, EMPTY_FILTER); }}>초기화</GhostBtn>
        <div style={{ flex: 1 }} />
        <PrimaryBtn onClick={() => setTuAddOpen(true)}>+ 번역 쌍 추가</PrimaryBtn>
      </div>

      {tuAddOpen && (
        <Card style={{ padding: 16, marginBottom: 16, background: "#f0f9ff", border: "1px solid #bae6fd" }}>
          <p style={{ margin: "0 0 12px", fontWeight: 700, color: "#0369a1" }}>번역 쌍 직접 추가</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <input placeholder="프로젝트 ID *" value={tuAddForm.projectId}
              onChange={e => setTuAddForm(p => ({ ...p, projectId: e.target.value }))}
              style={{ padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, width: 120 }} />
            <select value={tuAddForm.sourceLang} onChange={e => setTuAddForm(p => ({ ...p, sourceLang: e.target.value }))}
              style={{ padding: "6px 8px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 12 }}>
              <option value="ko">한국어</option><option value="en">영어</option>
              <option value="ja">일본어</option><option value="zh">중국어</option>
            </select>
            <select value={tuAddForm.targetLang} onChange={e => setTuAddForm(p => ({ ...p, targetLang: e.target.value }))}
              style={{ padding: "6px 8px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 12 }}>
              <option value="ko">한국어</option><option value="en">영어</option>
              <option value="ja">일본어</option><option value="zh">중국어</option>
            </select>
            <select value={tuAddForm.domain} onChange={e => setTuAddForm(p => ({ ...p, domain: e.target.value }))}
              style={{ padding: "6px 8px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 12 }}>
              {["general","legal","finance","medical","it","marketing","technical","other"].map(d =>
                <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <textarea placeholder="원문 (sourceText) *" value={tuAddForm.sourceText}
              onChange={e => setTuAddForm(p => ({ ...p, sourceText: e.target.value }))}
              rows={4} style={{ flex: 1, padding: "8px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, resize: "vertical" }} />
            <textarea placeholder="번역문 (targetText) *" value={tuAddForm.targetText}
              onChange={e => setTuAddForm(p => ({ ...p, targetText: e.target.value }))}
              rows={4} style={{ flex: 1, padding: "8px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, resize: "vertical" }} />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <PrimaryBtn disabled={tuAddLoading} onClick={async () => {
              if (!tuAddForm.projectId || !tuAddForm.sourceText || !tuAddForm.targetText) {
                setToast("프로젝트 ID, 원문, 번역문은 필수입니다."); return;
              }
              setTuAddLoading(true);
              try {
                const res = await fetch(api(`/api/admin/projects/${tuAddForm.projectId}/translation-units`), {
                  method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
                  body: JSON.stringify({ sourceText: tuAddForm.sourceText, targetText: tuAddForm.targetText, sourceLang: tuAddForm.sourceLang, targetLang: tuAddForm.targetLang, domain: tuAddForm.domain }),
                });
                const d = await res.json();
                if (res.ok) {
                  setToast(`${d.count}개 세그먼트 저장 완료`);
                  setTuAddOpen(false);
                  setTuAddForm({ projectId: "", sourceText: "", targetText: "", sourceLang: "ko", targetLang: "en", domain: "general" });
                  fetchTuStats(); fetchTuUnits(1, tuFilter);
                } else { setToast("오류: " + (d.error ?? "저장 실패")); }
              } catch { setToast("오류: 저장 실패"); }
              finally { setTuAddLoading(false); }
            }}>{tuAddLoading ? "저장 중..." : "저장"}</PrimaryBtn>
            <GhostBtn onClick={() => setTuAddOpen(false)}>취소</GhostBtn>
          </div>
        </Card>
      )}

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <Card style={{ flex: 1, overflowX: "auto", padding: 0 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "#f3f4f6" }}>
                {["ID","프로젝트","순번","원문","번역문","언어쌍","도메인","품질","보안등급","익명화","상태","생성일"].map(h => (
                  <th key={h} style={{ padding: "8px 10px", fontWeight: 600, fontSize: 11, color: "#374151", textAlign: "left", whiteSpace: "nowrap", borderBottom: "1px solid #e5e7eb" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tuLoading ? (
                <tr><td colSpan={12} style={{ padding: 24, textAlign: "center", color: "#9ca3af" }}>로딩 중...</td></tr>
              ) : tuUnits.length === 0 ? (
                <tr><td colSpan={12} style={{ padding: 32, textAlign: "center", color: "#9ca3af" }}>
                  <div style={{ fontSize: 28 }}>🗃️</div>
                  <div style={{ marginTop: 8 }}>번역 데이터가 없습니다.<br /><span style={{ fontSize: 12 }}>프로젝트를 완료하거나 + 번역 쌍 추가 버튼으로 직접 입력하세요.</span></div>
                </td></tr>
              ) : tuUnits.map(u => {
                const isSelected = tuSelectedId === u.id;
                return (
                  <tr key={u.id}
                    onClick={() => { setTuSelectedId(u.id); setTuDetailData(u); fetchTuDetail(u.id); }}
                    style={{ cursor: "pointer", background: isSelected ? "#eff6ff" : "transparent", borderBottom: "1px solid #f3f4f6" }}
                    onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLTableRowElement).style.background = "#f9fafb"; }}
                    onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLTableRowElement).style.background = "transparent"; }}
                  >
                    <td style={{ padding: "7px 10px", color: "#6b7280" }}>{u.id}</td>
                    <td style={{ padding: "7px 10px" }}>{u.projectId}</td>
                    <td style={{ padding: "7px 10px", color: "#6b7280" }}>{u.segmentIndex}</td>
                    <td style={{ padding: "7px 10px", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={u.sourceText}>{u.sourceText}</td>
                    <td style={{ padding: "7px 10px", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={u.targetText}>{u.targetText}</td>
                    <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>{u.sourceLang}→{u.targetLang}</td>
                    <td style={{ padding: "7px 10px" }}>{u.domain ?? "-"}</td>
                    <td style={{ padding: "7px 10px" }}>
                      <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 11, fontWeight: 600,
                        background: u.qualityLevel === "A" ? "#dcfce7" : u.qualityLevel === "B" ? "#fef9c3" : u.qualityLevel === "C" ? "#fee2e2" : "#f3f4f6",
                        color: u.qualityLevel === "A" ? "#166534" : u.qualityLevel === "B" ? "#713f12" : u.qualityLevel === "C" ? "#991b1b" : "#6b7280" }}>
                        {u.qualityLevel ?? "unknown"}
                      </span>
                    </td>
                    <td style={{ padding: "7px 10px" }}>
                      <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 11, fontWeight: 600,
                        background: u.securityLevel === "public" ? "#dcfce7" : u.securityLevel === "internal" ? "#dbeafe" : u.securityLevel === "restricted" ? "#fef9c3" : "#fee2e2",
                        color: u.securityLevel === "public" ? "#166534" : u.securityLevel === "internal" ? "#1e40af" : u.securityLevel === "restricted" ? "#713f12" : "#991b1b" }}>
                        {u.securityLevel}
                      </span>
                    </td>
                    <td style={{ padding: "7px 10px" }}>
                      {u.isAnonymized ? <span style={{ color: "#7c3aed", fontSize: 11, fontWeight: 600 }}>✓ 익명화</span> : <span style={{ color: "#9ca3af", fontSize: 11 }}>-</span>}
                    </td>
                    <td style={{ padding: "7px 10px" }}>
                      <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 11, fontWeight: 600,
                        background: u.status === "active" ? "#dcfce7" : u.status === "excluded" ? "#fee2e2" : "#fef9c3",
                        color: u.status === "active" ? "#166534" : u.status === "excluded" ? "#991b1b" : "#713f12" }}>
                        {u.status}
                      </span>
                    </td>
                    <td style={{ padding: "7px 10px", color: "#9ca3af", whiteSpace: "nowrap" }}>
                      {new Date(u.createdAt).toLocaleDateString("ko-KR")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {tuTotal > tuLimit && (
            <div style={{ display: "flex", gap: 6, justifyContent: "center", padding: "12px 0", borderTop: "1px solid #f3f4f6" }}>
              <GhostBtn disabled={tuPage <= 1} onClick={() => fetchTuUnits(tuPage - 1, tuFilter)}>이전</GhostBtn>
              <span style={{ fontSize: 12, color: "#6b7280", padding: "6px 12px" }}>
                {tuPage} / {Math.ceil(tuTotal / tuLimit)} (총 {tuTotal}건)
              </span>
              <GhostBtn disabled={tuPage >= Math.ceil(tuTotal / tuLimit)} onClick={() => fetchTuUnits(tuPage + 1, tuFilter)}>다음</GhostBtn>
            </div>
          )}
        </Card>

        {tuSelectedId !== null && (
          <Card style={{ width: 360, flexShrink: 0, padding: 16, fontSize: 13 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <p style={{ margin: 0, fontWeight: 700, color: "#111827" }}>
                유닛 #{tuSelectedId} 상세
                {tuDetailData === null && <span style={{ marginLeft: 8, fontSize: 11, color: "#9ca3af" }}>로딩 중...</span>}
              </p>
              <button onClick={() => { setTuSelectedId(null); setTuDetailData(null); }}
                style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 18 }}>×</button>
            </div>
            {tuDetailData && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: "6px 8px", marginBottom: 12, fontSize: 12 }}>
                  <span style={{ color: "#6b7280" }}>프로젝트</span><span>{tuDetailData.projectId}</span>
                  <span style={{ color: "#6b7280" }}>순번</span><span>{tuDetailData.segmentIndex}</span>
                  <span style={{ color: "#6b7280" }}>언어쌍</span><span>{tuDetailData.sourceLang}→{tuDetailData.targetLang}</span>
                  <span style={{ color: "#6b7280" }}>도메인</span><span>{tuDetailData.domain ?? "-"}</span>
                  <span style={{ color: "#6b7280" }}>품질</span><span>{tuDetailData.qualityLevel ?? "unknown"}</span>
                  <span style={{ color: "#6b7280" }}>보안등급</span><span>{tuDetailData.securityLevel}</span>
                  <span style={{ color: "#6b7280" }}>익명화</span><span>{tuDetailData.isAnonymized ? "✓" : "-"}</span>
                  <span style={{ color: "#6b7280" }}>원문 글자</span><span>{tuDetailData.sourceCharCount}</span>
                  <span style={{ color: "#6b7280" }}>번역 글자</span><span>{tuDetailData.targetCharCount}</span>
                  <span style={{ color: "#6b7280" }}>생성일</span><span>{new Date(tuDetailData.createdAt).toLocaleString("ko-KR")}</span>
                  <span style={{ color: "#6b7280" }}>수정일</span><span>{new Date(tuDetailData.updatedAt).toLocaleString("ko-KR")}</span>
                </div>
                <div style={{ marginBottom: 10 }}>
                  <p style={{ margin: "0 0 4px", fontSize: 11, fontWeight: 600, color: "#6b7280" }}>원문</p>
                  <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6, padding: "8px 10px", fontSize: 12, lineHeight: 1.6, maxHeight: 120, overflowY: "auto" }}>{tuDetailData.sourceText}</div>
                </div>
                <div style={{ marginBottom: 10 }}>
                  <p style={{ margin: "0 0 4px", fontSize: 11, fontWeight: 600, color: "#6b7280" }}>번역문</p>
                  <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6, padding: "8px 10px", fontSize: 12, lineHeight: 1.6, maxHeight: 120, overflowY: "auto" }}>{tuDetailData.targetText}</div>
                </div>
                {tuDetailData.isAnonymized && (
                  <>
                    <div style={{ marginBottom: 10 }}>
                      <p style={{ margin: "0 0 4px", fontSize: 11, fontWeight: 600, color: "#7c3aed" }}>익명화 원문</p>
                      <div style={{ background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 6, padding: "8px 10px", fontSize: 12, lineHeight: 1.6, maxHeight: 100, overflowY: "auto" }}>{tuDetailData.anonymizedSourceText ?? "-"}</div>
                    </div>
                    <div style={{ marginBottom: 10 }}>
                      <p style={{ margin: "0 0 4px", fontSize: 11, fontWeight: 600, color: "#7c3aed" }}>익명화 번역문</p>
                      <div style={{ background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 6, padding: "8px 10px", fontSize: 12, lineHeight: 1.6, maxHeight: 100, overflowY: "auto" }}>{tuDetailData.anonymizedTargetText ?? "-"}</div>
                    </div>
                  </>
                )}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                  {!tuDetailData.isAnonymized && (
                    <button disabled={tuActionLoading}
                      onClick={async () => {
                        setTuActionLoading(true);
                        try {
                          const res = await fetch(api(`/api/admin/translation-units/${tuSelectedId}/anonymize`), { method: "POST", headers: authHeaders });
                          if (res.ok) { setToast("익명화 완료"); fetchTuDetail(tuSelectedId!); fetchTuUnits(tuPage, tuFilter); }
                          else { const d = await res.json(); setToast("오류: " + (d.error ?? "실패")); }
                        } catch { setToast("오류: 익명화 실패"); }
                        finally { setTuActionLoading(false); }
                      }}
                      style={{ padding: "5px 12px", background: "#7c3aed", color: "#fff", border: "none", borderRadius: 6, fontSize: 12, cursor: "pointer", opacity: tuActionLoading ? 0.6 : 1 }}>
                      익명화
                    </button>
                  )}
                  {tuDetailData.status !== "excluded" && (
                    <button disabled={tuActionLoading}
                      onClick={async () => {
                        if (!confirm("이 유닛을 제외 처리하시겠습니까?")) return;
                        setTuActionLoading(true);
                        try {
                          const res = await fetch(api(`/api/admin/translation-units/${tuSelectedId}/exclude`), { method: "PATCH", headers: authHeaders });
                          if (res.ok) { setToast("제외 처리 완료"); fetchTuDetail(tuSelectedId!); fetchTuStats(); fetchTuUnits(tuPage, tuFilter); }
                          else { const d = await res.json(); setToast("오류: " + (d.error ?? "실패")); }
                        } catch { setToast("오류: 제외 처리 실패"); }
                        finally { setTuActionLoading(false); }
                      }}
                      style={{ padding: "5px 12px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 6, fontSize: 12, cursor: "pointer", opacity: tuActionLoading ? 0.6 : 1 }}>
                      제외
                    </button>
                  )}
                </div>
                {tuDetailData.logs && tuDetailData.logs.length > 0 && (
                  <div>
                    <p style={{ margin: "0 0 6px", fontSize: 11, fontWeight: 600, color: "#6b7280" }}>변경 이력</p>
                    <div style={{ maxHeight: 150, overflowY: "auto", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6, padding: "6px 8px" }}>
                      {tuDetailData.logs.map(l => (
                        <div key={l.id} style={{ fontSize: 11, color: "#374151", marginBottom: 4, paddingBottom: 4, borderBottom: "1px solid #f3f4f6" }}>
                          <span style={{ fontWeight: 600, color: "#0ea5e9" }}>{l.action}</span>
                          <span style={{ color: "#9ca3af", marginLeft: 8 }}>{new Date(l.createdAt).toLocaleString("ko-KR")}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </Card>
        )}
      </div>
    </Section>
  );
}
