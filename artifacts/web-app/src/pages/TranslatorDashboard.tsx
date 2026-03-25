import React, { useState, useCallback, useEffect } from "react";
import { api, User, Task, TranslatorProfile, TranslatorRate, MySettlement } from "../lib/constants";
import { Card, Toast, PrimaryBtn, GhostBtn } from "../components/ui";
import { TaskCard } from "../components/projects";

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 14, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};

const SETTLEMENT_STATUS_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: "대기", color: "#6b7280", bg: "#f3f4f6" },
  ready:   { label: "정산 가능", color: "#d97706", bg: "#fffbeb" },
  paid:    { label: "지급 완료", color: "#059669", bg: "#f0fdf4" },
};
const AVAIL_LABEL: Record<string, string> = { available: "가능", busy: "바쁨", unavailable: "불가" };

export function TranslatorDashboard({ user, token }: { user: User; token: string }) {
  const [tab, setTab] = useState<"tasks"|"settlement"|"profile">("tasks");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [settlements, setSettlements] = useState<MySettlement[]>([]);
  const [profile, setProfile] = useState<TranslatorProfile | null>(null);
  const [rates, setRates] = useState<TranslatorRate[]>([]);
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [acting, setActing] = useState<number | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileForm, setProfileForm] = useState<Partial<TranslatorProfile>>({});
  const [editingProfile, setEditingProfile] = useState(false);
  const [rateForm, setRateForm] = useState({ serviceType: "번역", languagePair: "EN-KO", unit: "word", rate: "" });
  const [addingRate, setAddingRate] = useState(false);
  const [deletingRate, setDeletingRate] = useState<number | null>(null);

  const authHeaders = { Authorization: `Bearer ${token}` };

  const fetchTasksAndSettlements = useCallback(async () => {
    setLoading(true);
    try {
      const [tRes, sRes] = await Promise.all([
        fetch(api(`/api/tasks?translatorId=${user.id}`)),
        fetch(api("/api/settlements/my"), { headers: authHeaders }),
      ]);
      const [tData, sData] = await Promise.all([tRes.json(), sRes.json()]);
      if (tRes.ok) setTasks(Array.isArray(tData) ? tData.sort((a: Task, b: Task) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) : []);
      if (sRes.ok) setSettlements(Array.isArray(sData) ? sData : []);
    } catch { setToast("오류: 데이터를 불러올 수 없습니다."); }
    finally { setLoading(false); }
  }, [user.id, token]);

  const fetchProfile = useCallback(async () => {
    setProfileLoading(true);
    try {
      const [pRes, rRes] = await Promise.all([
        fetch(api(`/api/translator-profiles/${user.id}`), { headers: authHeaders }),
        fetch(api(`/api/translator-rates/${user.id}`), { headers: authHeaders }),
      ]);
      if (pRes.ok) {
        const pd = await pRes.json();
        setProfile(pd);
        setProfileForm(pd ?? {});
      }
      if (rRes.ok) {
        const rd = await rRes.json();
        setRates(Array.isArray(rd) ? rd : []);
      }
    } catch { setToast("오류: 프로필을 불러올 수 없습니다."); }
    finally { setProfileLoading(false); }
  }, [user.id, token]);

  useEffect(() => { fetchTasksAndSettlements(); }, [fetchTasksAndSettlements]);
  useEffect(() => { if (tab === "profile") fetchProfile(); }, [tab, fetchProfile]);

  const doAction = async (taskId: number, action: "start" | "complete") => {
    setActing(taskId);
    try {
      const res = await fetch(api(`/api/tasks/${taskId}/${action}`), {
        method: "PATCH", headers: { "Authorization": `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast(action === "start" ? "작업을 시작했습니다." : "작업을 완료했습니다. 정산이 자동 생성됩니다.");
      await fetchTasksAndSettlements();
    } catch { setToast("오류: 상태 변경 실패"); }
    finally { setActing(null); }
  };

  const saveProfile = async () => {
    setSavingProfile(true);
    try {
      const res = await fetch(api(`/api/translator-profiles/${user.id}`), {
        method: "PUT", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ ...profileForm, userId: user.id }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setProfile(data); setEditingProfile(false);
      setToast("프로필이 저장되었습니다.");
    } catch { setToast("오류: 저장 실패"); }
    finally { setSavingProfile(false); }
  };

  const addRate = async () => {
    if (!rateForm.rate || isNaN(Number(rateForm.rate))) { setToast("단가를 숫자로 입력하세요."); return; }
    setAddingRate(true);
    try {
      const res = await fetch(api(`/api/translator-rates/${user.id}`), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ ...rateForm, rate: Number(rateForm.rate), translatorId: user.id }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setRates(prev => [...prev, data]);
      setRateForm({ serviceType: "번역", languagePair: "EN-KO", unit: "word", rate: "" });
      setToast("단가가 추가되었습니다.");
    } catch { setToast("오류: 단가 추가 실패"); }
    finally { setAddingRate(false); }
  };

  const deleteRate = async (rateId: number) => {
    setDeletingRate(rateId);
    try {
      const res = await fetch(api(`/api/translator-rates/${user.id}/${rateId}`), {
        method: "DELETE", headers: authHeaders,
      });
      if (!res.ok) { setToast("오류: 삭제 실패"); return; }
      setRates(prev => prev.filter(r => r.id !== rateId));
      setToast("단가가 삭제되었습니다.");
    } catch { setToast("오류: 삭제 실패"); }
    finally { setDeletingRate(null); }
  };

  const active = tasks.filter(t => t.status !== "done");
  const completed = tasks.filter(t => t.status === "done");

  const tabBtn = (key: typeof tab, label: string) => (
    <button key={key} onClick={() => setTab(key)} style={{
      padding: "7px 18px", borderRadius: 20, cursor: "pointer", fontSize: 13, fontWeight: tab === key ? 700 : 500,
      border: "1px solid", borderColor: tab === key ? "#2563eb" : "#e5e7eb",
      background: tab === key ? "#eff6ff" : "#fff", color: tab === key ? "#2563eb" : "#6b7280",
    }}>{label}</button>
  );

  return (
    <>
      <Toast msg={toast} onClose={() => setToast("")} />
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {tabBtn("tasks", `작업 (${tasks.length})`)}
        {tabBtn("settlement", `정산 (${settlements.length})`)}
        {tabBtn("profile", "프로필 · 단가표")}
      </div>

      {tab === "tasks" && (
        <>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
            <GhostBtn onClick={fetchTasksAndSettlements} disabled={loading}>
              {loading ? "로딩 중..." : "새로고침"}
            </GhostBtn>
          </div>
          {loading ? (
            <div style={{ textAlign: "center", padding: "40px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : tasks.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "40px 24px", color: "#9ca3af" }}>
              <p style={{ margin: 0, fontSize: 32 }}>📋</p>
              <p style={{ margin: "10px 0 0", fontSize: 14 }}>배정된 작업이 없습니다.</p>
            </Card>
          ) : (
            <>
              {active.length > 0 && (
                <div style={{ marginBottom: 24 }}>
                  <p style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    진행 중 ({active.length})
                  </p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {active.map(t => (
                      <TaskCard key={t.id} task={t} token={token}
                        onAction={(id, act) => !acting && doAction(id, act)} />
                    ))}
                  </div>
                </div>
              )}
              {completed.length > 0 && (
                <div style={{ marginBottom: 24 }}>
                  <p style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    완료 ({completed.length})
                  </p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {completed.map(t => (
                      <TaskCard key={t.id} task={t} token={token}
                        onAction={(id, act) => !acting && doAction(id, act)} />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      {tab === "settlement" && (
        <>
          {settlements.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px 24px", color: "#9ca3af" }}>
              <p style={{ margin: 0, fontSize: 28 }}>💰</p>
              <p style={{ margin: "8px 0 0", fontSize: 14 }}>아직 정산 내역이 없습니다.</p>
            </Card>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {settlements.map(s => {
                const st = SETTLEMENT_STATUS_STYLE[s.status] ?? SETTLEMENT_STATUS_STYLE.pending;
                return (
                  <Card key={s.id} style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 160 }}>
                      <p style={{ margin: "0 0 3px", fontSize: 11, color: "#9ca3af" }}>
                        #{s.id} · {new Date(s.createdAt).toLocaleDateString("ko-KR")}
                      </p>
                      <p style={{ margin: 0, fontWeight: 700, fontSize: 15, color: "#111827" }}>
                        {s.projectTitle ?? `프로젝트 #${s.projectId}`}
                      </p>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <p style={{ margin: "0 0 2px", fontSize: 11, color: "#9ca3af" }}>지급 예정 금액</p>
                      <p style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#059669" }}>
                        {Number(s.translatorAmount).toLocaleString()}<span style={{ fontSize: 13, marginLeft: 3 }}>원</span>
                      </p>
                      <p style={{ margin: "2px 0 0", fontSize: 11, color: "#9ca3af" }}>
                        총 결제 {Number(s.totalAmount).toLocaleString()}원의 70%
                      </p>
                    </div>
                    <div style={{ minWidth: 90, textAlign: "right" }}>
                      <span style={{ background: st.bg, color: st.color, padding: "5px 12px", borderRadius: 20, fontSize: 12, fontWeight: 700 }}>
                        {st.label}
                      </span>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}

      {tab === "profile" && (
        <>
          {profileLoading ? (
            <div style={{ textAlign: "center", padding: "40px 0", color: "#9ca3af" }}>불러오는 중...</div>
          ) : (
            <>
              <Card style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#111827" }}>기본 프로필</p>
                  {!editingProfile ? (
                    <GhostBtn onClick={() => setEditingProfile(true)} style={{ fontSize: 12, padding: "5px 12px" }}>편집</GhostBtn>
                  ) : (
                    <div style={{ display: "flex", gap: 6 }}>
                      <GhostBtn onClick={() => { setEditingProfile(false); setProfileForm(profile ?? {}); }} style={{ fontSize: 12, padding: "5px 12px" }}>취소</GhostBtn>
                      <PrimaryBtn onClick={saveProfile} disabled={savingProfile} style={{ fontSize: 12, padding: "5px 14px" }}>
                        {savingProfile ? "저장 중..." : "저장"}
                      </PrimaryBtn>
                    </div>
                  )}
                </div>

                {!editingProfile ? (
                  profile ? (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 20px" }}>
                      {([
                        ["언어쌍", profile.languagePairs ?? "-"],
                        ["전문분야", profile.specializations ?? "-"],
                        ["학력", `${profile.education ?? "-"}${profile.major ? ` / ${profile.major}` : ""}${profile.graduationYear ? ` (${profile.graduationYear})` : ""}`],
                        ["지역", profile.region ?? "-"],
                        ["가용여부", AVAIL_LABEL[profile.availabilityStatus ?? ""] ?? "-"],
                        ["평점", profile.rating != null ? `⭐ ${Number(profile.rating).toFixed(1)}` : "-"],
                        ["단어당 단가", profile.ratePerWord != null ? `${Number(profile.ratePerWord).toLocaleString()}원` : "-"],
                        ["페이지당 단가", profile.ratePerPage != null ? `${Number(profile.ratePerPage).toLocaleString()}원` : "-"],
                      ] as [string, string][]).map(([k, v]) => (
                        <div key={k} style={{ display: "flex", gap: 6, fontSize: 13 }}>
                          <span style={{ color: "#9ca3af", minWidth: 80, flexShrink: 0 }}>{k}</span>
                          <span style={{ color: "#111827" }}>{v}</span>
                        </div>
                      ))}
                      {profile.bio && (
                        <div style={{ gridColumn: "span 2", display: "flex", gap: 6, fontSize: 13 }}>
                          <span style={{ color: "#9ca3af", minWidth: 80 }}>소개</span>
                          <span style={{ color: "#374151", lineHeight: 1.6 }}>{profile.bio}</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "8px 0" }}>
                      프로필이 없습니다. 편집 버튼을 눌러 프로필을 등록하세요.
                    </p>
                  )
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
                    {([
                      ["languagePairs", "언어쌍", "예: EN-KO, JA-KO"],
                      ["specializations", "전문분야", "예: IT, 법률, 의료"],
                      ["region", "지역", "예: 서울"],
                      ["education", "학교", "예: 서울대학교"],
                      ["major", "전공", "예: 영문학"],
                    ] as [keyof TranslatorProfile, string, string][]).map(([field, label, placeholder]) => (
                      <div key={field}>
                        <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>{label}</label>
                        <input
                          value={(profileForm[field] as string) ?? ""}
                          onChange={e => setProfileForm(p => ({ ...p, [field]: e.target.value }))}
                          placeholder={placeholder}
                          style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }}
                        />
                      </div>
                    ))}
                    <div>
                      <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>졸업연도</label>
                      <input
                        type="number"
                        value={profileForm.graduationYear ?? ""}
                        onChange={e => setProfileForm(p => ({ ...p, graduationYear: e.target.value ? Number(e.target.value) : undefined }))}
                        placeholder="예: 2015"
                        style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>가용 여부</label>
                      <select
                        value={profileForm.availabilityStatus ?? "available"}
                        onChange={e => setProfileForm(p => ({ ...p, availabilityStatus: e.target.value }))}
                        style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }}
                      >
                        <option value="available">가능</option>
                        <option value="busy">바쁨</option>
                        <option value="unavailable">불가</option>
                      </select>
                    </div>
                    <div style={{ gridColumn: "span 2" }}>
                      <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>소개</label>
                      <textarea
                        value={profileForm.bio ?? ""}
                        onChange={e => setProfileForm(p => ({ ...p, bio: e.target.value }))}
                        rows={3}
                        style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", resize: "vertical" }}
                      />
                    </div>
                  </div>
                )}
              </Card>

              <Card>
                <p style={{ margin: "0 0 14px", fontSize: 14, fontWeight: 700, color: "#111827" }}>
                  단가표 ({rates.length})
                </p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 80px 100px auto", gap: "6px 8px", alignItems: "end", marginBottom: 10 }}>
                  <input value={rateForm.serviceType} onChange={e => setRateForm(p => ({ ...p, serviceType: e.target.value }))}
                    placeholder="서비스 유형" style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
                  <input value={rateForm.languagePair} onChange={e => setRateForm(p => ({ ...p, languagePair: e.target.value }))}
                    placeholder="언어조합" style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
                  <select value={rateForm.unit} onChange={e => setRateForm(p => ({ ...p, unit: e.target.value }))}
                    style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }}>
                    <option value="word">어절</option>
                    <option value="page">페이지</option>
                    <option value="hour">시간</option>
                  </select>
                  <input type="number" value={rateForm.rate} onChange={e => setRateForm(p => ({ ...p, rate: e.target.value }))}
                    placeholder="단가(원)" style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
                  <PrimaryBtn onClick={addRate} disabled={addingRate} style={{ fontSize: 12, padding: "6px 12px", whiteSpace: "nowrap" }}>
                    {addingRate ? "추가 중..." : "+ 추가"}
                  </PrimaryBtn>
                </div>
                {rates.length === 0 ? (
                  <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "10px 0" }}>등록된 단가가 없습니다.</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {rates.map(r => (
                      <div key={r.id} style={{ display: "flex", gap: 12, alignItems: "center", padding: "8px 12px", background: "#f9fafb", borderRadius: 8, border: "1px solid #f3f4f6", fontSize: 13 }}>
                        <span style={{ fontWeight: 600, color: "#374151", minWidth: 80 }}>{r.serviceType}</span>
                        <span style={{ color: "#2563eb", minWidth: 80 }}>{r.languagePair}</span>
                        <span style={{ color: "#6b7280", minWidth: 50 }}>{r.unit === "word" ? "어절" : r.unit === "page" ? "페이지" : "시간"}</span>
                        <span style={{ fontWeight: 700, color: "#059669", flex: 1 }}>{r.rate.toLocaleString()}원</span>
                        <button
                          onClick={() => deleteRate(r.id)}
                          disabled={deletingRate === r.id}
                          style={{ background: "none", border: "none", color: "#dc2626", fontSize: 12, cursor: "pointer" }}
                        >
                          {deletingRate === r.id ? "삭제 중..." : "삭제"}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </>
          )}
        </>
      )}
    </>
  );
}
