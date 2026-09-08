import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { formatDisplayDate } from '../../lib/dateFormat';
import { api, AdminUser, User } from '../../lib/constants';
import { Card, PrimaryBtn, GhostBtn, RoleBadge, ClickSelect } from '../ui';
import { useBulkSelection, useClientPagination, BulkSelectBar, bulkActionBtn, Pagination as ListPagination, trashRowStyle } from './bulkListShared';
import './readTableView.css';

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: '1px solid #d1d5db', fontSize: 14, color: '#111827',
  outline: 'none', boxSizing: 'border-box', background: '#fff',
};
const tableTh: React.CSSProperties = {
  padding: "10px 12px", textAlign: "left", fontSize: 12,
  fontWeight: 600, color: "#6b7280", background: "#f9fafb",
  borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap",
};
const tableTd: React.CSSProperties = {
  padding: "9px 12px", fontSize: 13, color: "#374151",
  borderBottom: "1px solid #edf0f3", verticalAlign: "middle",
};

type ActivityStats = {
  summary: { today: number; week: number; month: number; year: number; currentlyOnline: number };
  loginCount: number; uniqueUsers: number;
  byRole: { roleType: string; count: number }[];
};
type UserStat = {
  userId: number; loginCount: number; totalActiveMinutes: number; lastLoginAt: string | null;
  user: { name: string | null; email: string; role: string } | null;
};
type RbacRole = { id: number; name: string; description: string | null; isSystem: boolean; createdAt: string; permissionCount: number; permissions: string[] };

interface Props {
  token: string;
  currentUser: User;
  users: AdminUser[];
  setUsers: React.Dispatch<React.SetStateAction<AdminUser[]>>;
  rbacRoles: RbacRole[];
  onToast: (msg: string) => void;
  onResetPassword: (userId: number) => void;
  onTranslatorProfile: (userId: number, email: string) => void;
}

const ROLE_COLORS: Record<string, string> = {
  admin: "#7c3aed", staff: "#0891b2", client: "#059669",
  linguist: "#d97706", customer: "#059669", translator: "#d97706",
};
const ROLE_NAMES: Record<string, string> = {
  admin: "관리자", staff: "직원", client: "고객",
  linguist: "통번역사", customer: "고객", translator: "통번역사",
};
const PERIOD_LABELS: Record<string, string> = { today: "오늘", week: "이번 주", month: "이번 달", year: "올해" };

export function StaffManagementTab({ token, currentUser, users, setUsers, rbacRoles, onToast, onResetPassword, onTranslatorProfile }: Props) {
  const authHeaders = { Authorization: `Bearer ${token}` };

  const [usersLoading, setUsersLoading] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const [userRoleFilter, setUserRoleFilter] = useState<string>("all");
  const [showCreateStaff, setShowCreateStaff] = useState(false);
  const [newStaff, setNewStaff] = useState({ name: "", email: "", password: "", department: "", jobTitle: "", role: "staff" as "admin" | "staff", isActive: true });
  const [creatingStaff, setCreatingStaff] = useState(false);
  const [activityStats, setActivityStats] = useState<ActivityStats | null>(null);
  const [activityPeriod, setActivityPeriod] = useState<"today"|"week"|"month"|"year">("today");
  const [showActivityStats, setShowActivityStats] = useState(false);
  const [userStats, setUserStats] = useState<UserStat[]>([]);
  const [roleChanging, setRoleChanging] = useState<number | null>(null);
  const [toggling, setToggling] = useState<number | null>(null);
  // 추가 필터(계정상태 / 시스템 권한) — 실제 데이터(isActive / roleId) 기준. 새로운 권한 개념을 만들지 않는다(§4·§23).
  const [accountStatusFilter, setAccountStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [systemRoleFilter, setSystemRoleFilter] = useState<string>("all"); // "all" | roleId
  // 삭제(휴지통) 상태 — 삭제 실행은 상단 "선택 삭제"로 통일(행별 삭제 버튼 없음).
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const bulk = useBulkSelection<number>();

  // 삭제 사용자는 서버에서 이미 제외되므로 전체(비필터) 조회 후 화면에서 필터·페이지네이션한다(§3 안전한 방식·§21).
  const fetchUsers = useCallback(async () => {
    setUsersLoading(true);
    try {
      const res = await fetch(api(`/api/admin/users`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setUsers(Array.isArray(data) ? data : []);
    } catch { onToast("오류: 사용자 조회 실패"); }
    finally { setUsersLoading(false); }
  }, [token]);

  const fetchActivityStats = useCallback(async (period: string = "today") => {
    try {
      const [statsRes, userStatsRes] = await Promise.all([
        fetch(api(`/api/admin/activity/stats?period=${period}`), { headers: authHeaders }),
        fetch(api("/api/admin/activity/user-stats?limit=20"), { headers: authHeaders }),
      ]);
      if (statsRes.ok) setActivityStats(await statsRes.json());
      if (userStatsRes.ok) setUserStats(await userStatsRes.json());
    } catch {}
  }, [token]);

  useEffect(() => {
    fetchUsers();
    fetchActivityStats(activityPeriod);
  }, []);

  const handleRoleChange = async (userId: number, newRole: string) => {
    setRoleChanging(userId);
    try {
      const res = await fetch(api(`/api/admin/users/${userId}/role`), {
        method: "PATCH", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ role: newRole }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, role: data.role } : u));
      onToast("역할이 변경되었습니다.");
    } catch { onToast("오류: 역할 변경 실패"); }
    finally { setRoleChanging(null); }
  };

  const handleCreateStaff = async () => {
    if (!newStaff.name.trim()) { onToast("오류: 이름은 필수입니다."); return; }
    if (!newStaff.email.trim()) { onToast("오류: 이메일은 필수입니다."); return; }
    if (newStaff.password.length < 6) { onToast("오류: 비밀번호는 최소 6자 이상입니다."); return; }
    setCreatingStaff(true);
    try {
      const res = await fetch(api("/api/admin/users/internal"), {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newStaff.name.trim(),
          email: newStaff.email.trim().toLowerCase(),
          password: newStaff.password,
          role: newStaff.role,
          department: newStaff.department.trim() || undefined,
          jobTitle: newStaff.jobTitle.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setShowCreateStaff(false);
      setNewStaff({ name: "", email: "", password: "", department: "", jobTitle: "", role: "staff", isActive: true });
      onToast("내부 직원이 등록되었습니다.");
      fetchUsers();
    } catch { onToast("오류: 직원 등록 실패"); }
    finally { setCreatingStaff(false); }
  };

  const handleToggleActive = async (userId: number) => {
    setToggling(userId);
    try {
      const res = await fetch(api(`/api/admin/users/${userId}/deactivate`), {
        method: "PATCH", headers: { ...authHeaders, "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, isActive: data.isActive } : u));
      onToast(data.isActive ? "계정이 활성화되었습니다." : "계정이 비활성화되었습니다.");
    } catch { onToast("오류: 계정 상태 변경 실패"); }
    finally { setToggling(null); }
  };

  // ── 화면 필터(검색·유형·계정상태·시스템권한) → 클라이언트 페이지네이션 ──
  const filtered = useMemo(() => {
    const s = userSearch.trim().toLowerCase();
    return users.filter(u => {
      if (s && !(
        u.email.toLowerCase().includes(s) ||
        (u.name ?? "").toLowerCase().includes(s) ||
        (u.department ?? "").toLowerCase().includes(s) ||
        (u.jobTitle ?? "").toLowerCase().includes(s)
      )) return false;
      if (userRoleFilter === "client") { if (!(u.role === "client" || u.role === "customer")) return false; }
      else if (userRoleFilter === "linguist") { if (!(u.role === "linguist" || u.role === "translator")) return false; }
      else if (userRoleFilter !== "all" && u.role !== userRoleFilter) return false;
      if (accountStatusFilter === "active" && !u.isActive) return false;
      if (accountStatusFilter === "inactive" && u.isActive) return false;
      if (systemRoleFilter !== "all" && String(u.roleId ?? "") !== systemRoleFilter) return false;
      return true;
    });
  }, [users, userSearch, userRoleFilter, accountStatusFilter, systemRoleFilter]);

  const { paged, page, setPage, pageSize, setPageSize, total, totalPages, rangeStart, rangeEnd } = useClientPagination(filtered, 20);
  const pageIds = paged.map(u => u.id);

  // 검색/필터 변경 시 1페이지로 초기화(§2). 목록에서 사라진 항목은 선택에서 제거.
  useEffect(() => { setPage(1); }, [userSearch, userRoleFilter, accountStatusFilter, systemRoleFilter, setPage]);
  useEffect(() => { bulk.pruneTo(users.map(u => u.id)); }, [users]); // eslint-disable-line react-hooks/exhaustive-deps

  // 선택 활성화/비활성화 — deactivate 는 토글이므로 변경이 필요한 항목만 호출. 본인 제외(§16).
  const handleBulkSetActive = async (target: boolean) => {
    const ids = [...bulk.selectedIds].filter(id => id !== currentUser.id);
    const toChange = users.filter(u => ids.includes(u.id) && u.isActive !== target);
    if (toChange.length === 0) { onToast(target ? "활성화할 대상이 없습니다." : "비활성화할 대상이 없습니다."); return; }
    setBulkBusy(true);
    try {
      let ok = 0, fail = 0; const msgs: string[] = [];
      for (const u of toChange) {
        try {
          const res = await fetch(api(`/api/admin/users/${u.id}/deactivate`), { method: "PATCH", headers: { ...authHeaders, "Content-Type": "application/json" } });
          const d = await res.json().catch(() => null);
          if (res.ok) ok++; else { fail++; if (d?.error) msgs.push(d.error); }
        } catch { fail++; }
      }
      onToast(`${ok}건 ${target ? "활성화" : "비활성화"} 완료${fail ? ` (${fail}건 실패${msgs[0] ? `: ${msgs[0]}` : ""})` : ""}`);
      bulk.clear();
      await fetchUsers();
    } finally { setBulkBusy(false); }
  };

  // 삭제(휴지통 이동) — 본인 계정은 제외, 마지막 관리자는 서버가 차단(§8·§9).
  const doDelete = async (ids: number[], reason: string) => {
    let ok = 0, fail = 0; const msgs: string[] = [];
    for (const id of ids) {
      if (id === currentUser.id) { fail++; msgs.push("현재 로그인 중인 계정은 삭제할 수 없습니다."); continue; }
      try {
        const res = await fetch(api(`/api/admin/users/${id}`), {
          method: "DELETE", headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(reason ? { reason } : {}),
        });
        const d = await res.json().catch(() => null);
        if (res.ok) ok++; else { fail++; if (d?.error) msgs.push(d.error); }
      } catch { fail++; }
    }
    return { ok, fail, msgs };
  };

  const handleBulkDeleteConfirm = async () => {
    const ids = [...bulk.selectedIds];
    setDeleting(true);
    try {
      const { ok, fail, msgs } = await doDelete(ids, deleteReason.trim());
      onToast(`${ok}건을 휴지통으로 이동했습니다.${fail ? ` (${fail}건 실패${msgs[0] ? `: ${msgs[0]}` : ""})` : ""}`);
      setBulkDeleteOpen(false); setDeleteReason(""); bulk.clear();
      await fetchUsers();
    } finally { setDeleting(false); }
  };

  const selectableCount = [...bulk.selectedIds].filter(id => id !== currentUser.id).length;

  const ROLE_TABS = [
    { value: "all",      label: "전체",    activeBg: "#1d4ed8" },
    { value: "admin",    label: "관리자",  activeBg: "#7c3aed" },
    { value: "staff",    label: "직원",    activeBg: "#0891b2" },
    { value: "client",   label: "고객",    activeBg: "#059669" },
    { value: "linguist", label: "통번역사", activeBg: "#d97706" },
  ];

  // 삭제(휴지통) 사용자는 서버에서 제외되므로 users 는 활성 목록 기준. 필터 적용 시 필터 결과 수를 표시(§20).
  const anyFilter = userSearch.trim() !== "" || userRoleFilter !== "all" || accountStatusFilter !== "all" || systemRoleFilter !== "all";
  const sectionTitle = `사용자 관리 (${anyFilter ? `${total} / ${users.length}` : users.length}명${userRoleFilter !== "all" ? ` · ${ROLE_NAMES[userRoleFilter] ?? userRoleFilter}` : ""})`;

  return (
    <Section title={sectionTitle} action={
      <PrimaryBtn
        onClick={() => setShowCreateStaff(v => !v)}
        style={{ fontSize: 13, padding: "7px 14px", background: showCreateStaff ? "#6b7280" : "#1d4ed8" }}>
        {showCreateStaff ? "✕ 닫기" : "+ 직원 등록"}
      </PrimaryBtn>
    }>

      {/* 직원 등록 폼 */}
      {showCreateStaff && (
        <Card style={{ marginBottom: 18, padding: "20px 24px", border: "2px solid #dbeafe", background: "#f8faff" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <span style={{ fontSize: 16, fontWeight: 800, color: "#1d4ed8" }}>내부 직원 등록</span>
            <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: "#dbeafe", color: "#1d4ed8" }}>
              내부 전용 — 고객/통번역사 등록과 별개입니다
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 20px" }}>
            <div>
              <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>이름 *</label>
              <input value={newStaff.name} onChange={e => setNewStaff(f => ({ ...f, name: e.target.value }))}
                placeholder="홍길동" style={{ ...inputStyle, fontSize: 13, padding: "8px 10px" }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>이메일 *</label>
              <input value={newStaff.email} onChange={e => setNewStaff(f => ({ ...f, email: e.target.value }))}
                placeholder="hong@company.com" type="email" style={{ ...inputStyle, fontSize: 13, padding: "8px 10px" }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>초기 비밀번호 * (6자 이상)</label>
              <input value={newStaff.password} onChange={e => setNewStaff(f => ({ ...f, password: e.target.value }))}
                placeholder="••••••••" type="password" style={{ ...inputStyle, fontSize: 13, padding: "8px 10px" }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>역할 *</label>
              <ClickSelect
                value={newStaff.role}
                onChange={v => setNewStaff(f => ({ ...f, role: v as "admin" | "staff" }))}
                style={{ width: "100%" }}
                triggerStyle={{ width: "100%", fontSize: 13, padding: "8px 10px", borderRadius: 8 }}
                options={[
                  { value: "staff", label: "직원 (staff)" },
                  { value: "admin", label: "관리자 (admin)" },
                ]}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>부서</label>
              <input value={newStaff.department} onChange={e => setNewStaff(f => ({ ...f, department: e.target.value }))}
                placeholder="예: 운영팀, PM팀, 영업팀" style={{ ...inputStyle, fontSize: 13, padding: "8px 10px" }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>직책</label>
              <input value={newStaff.jobTitle} onChange={e => setNewStaff(f => ({ ...f, jobTitle: e.target.value }))}
                placeholder="예: PM, 운영담당, 정산담당" style={{ ...inputStyle, fontSize: 13, padding: "8px 10px" }} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center" }}>
            <PrimaryBtn onClick={handleCreateStaff} disabled={creatingStaff} style={{ fontSize: 13, padding: "9px 20px" }}>
              {creatingStaff ? "등록 중..." : "직원 등록"}
            </PrimaryBtn>
            <GhostBtn onClick={() => { setShowCreateStaff(false); setNewStaff({ name: "", email: "", password: "", department: "", jobTitle: "", role: "staff", isActive: true }); }}
              style={{ fontSize: 13, padding: "9px 14px" }}>
              취소
            </GhostBtn>
            <span style={{ fontSize: 12, color: "#9ca3af", marginLeft: 8 }}>* 등록 후 사용자 목록에 즉시 반영됩니다</span>
          </div>
        </Card>
      )}

      {/* 접속 통계 패널 */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 10, padding: "8px 14px" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e", display: "inline-block", boxShadow: "0 0 4px #22c55e" }} />
            <span style={{ fontSize: 12, fontWeight: 700, color: "#166534" }}>현재 온라인</span>
            <span style={{ fontSize: 16, fontWeight: 800, color: "#16a34a" }}>
              {activityStats?.summary.currentlyOnline ?? users.filter(u => u.isOnline).length}명
            </span>
          </div>
          {(["today","week","month","year"] as const).map(p => (
            <div key={p} style={{
              background: activityPeriod === p ? "#eff6ff" : "#f9fafb",
              border: `1px solid ${activityPeriod === p ? "#93c5fd" : "#e5e7eb"}`,
              borderRadius: 10, padding: "8px 14px", cursor: "pointer", transition: "all 0.12s",
            }} onClick={() => { setActivityPeriod(p); fetchActivityStats(p); }}>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>{PERIOD_LABELS[p]} 접속자</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: activityPeriod === p ? "#1d4ed8" : "#374151" }}>
                {activityStats?.summary[p] ?? "—"}명
              </div>
            </div>
          ))}
          <button onClick={() => setShowActivityStats(v => !v)}
            style={{ marginLeft: "auto", padding: "8px 14px", borderRadius: 8, border: "1px solid #d1d5db", background: showActivityStats ? "#f3f4f6" : "#fff", fontSize: 12, color: "#374151", cursor: "pointer", fontWeight: 600 }}>
            {showActivityStats ? "▲ 통계 접기" : "▼ 상세 통계"}
          </button>
        </div>

        {showActivityStats && (
          <Card style={{ marginBottom: 14, padding: "16px 20px", background: "#fafafa", border: "1px solid #e5e7eb" }}>
            <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 200px" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 10 }}>역할별 접속 분포 ({PERIOD_LABELS[activityPeriod]})</div>
                {(activityStats?.byRole ?? []).length === 0
                  ? <div style={{ fontSize: 12, color: "#9ca3af" }}>데이터 없음</div>
                  : (activityStats?.byRole ?? []).map(r => (
                    <div key={r.roleType} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 8, background: (ROLE_COLORS[r.roleType] ?? "#374151") + "22", color: ROLE_COLORS[r.roleType] ?? "#374151" }}>
                        {ROLE_NAMES[r.roleType] ?? r.roleType}
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{r.count}명</span>
                    </div>
                  ))
                }
              </div>
              <div style={{ flex: "2 1 320px" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 10 }}>사용자별 누적 이용 현황 (TOP 20)</div>
                {userStats.length === 0
                  ? <div style={{ fontSize: 12, color: "#9ca3af" }}>데이터 없음 (로그인 후 집계됩니다)</div>
                  : (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: "#f3f4f6" }}>
                            {["사용자","역할","로그인 횟수","총 이용시간","마지막 로그인"].map(h => (
                              <th key={h} style={{ padding: "6px 10px", textAlign: "left", fontWeight: 700, color: "#374151", whiteSpace: "nowrap" }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {userStats.map(s => (
                            <tr key={s.userId} style={{ borderTop: "1px solid #f3f4f6" }}>
                              <td style={{ padding: "5px 10px", whiteSpace: "nowrap" }}>
                                <div style={{ fontWeight: 600, color: "#111827" }}>{s.user?.name ?? "—"}</div>
                                <div style={{ fontSize: 11, color: "#9ca3af" }}>{s.user?.email}</div>
                              </td>
                              <td style={{ padding: "5px 10px" }}>
                                <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 8, background: (ROLE_COLORS[s.user?.role ?? ""] ?? "#374151") + "22", color: ROLE_COLORS[s.user?.role ?? ""] ?? "#374151" }}>
                                  {ROLE_NAMES[s.user?.role ?? ""] ?? s.user?.role}
                                </span>
                              </td>
                              <td style={{ padding: "5px 10px", fontWeight: 700, color: "#1d4ed8" }}>{s.loginCount}회</td>
                              <td style={{ padding: "5px 10px", color: "#374151" }}>
                                {s.totalActiveMinutes >= 60
                                  ? `${Math.floor(s.totalActiveMinutes/60)}시간 ${s.totalActiveMinutes%60}분`
                                  : `${s.totalActiveMinutes}분`
                                }
                              </td>
                              <td style={{ padding: "5px 10px", color: "#6b7280", whiteSpace: "nowrap" }}>
                                {s.lastLoginAt ? new Date(s.lastLoginAt).toLocaleString("ko-KR", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" }) : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                }
              </div>
            </div>
          </Card>
        )}
      </div>

      {/* 사용자 유형 필터 */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#6b7280", marginRight: 4, whiteSpace: "nowrap" }}>사용자 유형</span>
          {ROLE_TABS.map(tab => {
            const isActive = userRoleFilter === tab.value;
            return (
              <button key={tab.value} onClick={() => setUserRoleFilter(tab.value)}
                style={{
                  padding: "6px 14px", borderRadius: 20, fontSize: 13, fontWeight: isActive ? 700 : 500,
                  border: isActive ? `2px solid ${tab.activeBg}` : "2px solid #e5e7eb",
                  background: isActive ? tab.activeBg : "#fff", color: isActive ? "#fff" : "#374151",
                  cursor: "pointer", transition: "all 0.12s", whiteSpace: "nowrap",
                }}>
                {tab.label}
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={userSearch} onChange={e => setUserSearch(e.target.value)}
            placeholder="이름·이메일·부서·직책 검색..."
            data-testid="user-search"
            style={{ flex: "1 1 200px", maxWidth: 300, padding: "8px 12px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, color: "#111827", outline: "none", boxSizing: "border-box", background: "#fff" }}
          />
          {/* 계정상태 필터 — 실제 isActive 기준(§4) */}
          <div style={{ width: 130 }}>
            <ClickSelect value={accountStatusFilter} onChange={v => setAccountStatusFilter((v || "all") as any)} style={{ width: "100%" }}
              triggerStyle={{ width: "100%", fontSize: 13, padding: "8px 10px", borderRadius: 8 }}
              data-testid="user-status-filter" aria-label="계정 상태 필터"
              options={[{ value: "all", label: "상태: 전체" }, { value: "active", label: "활성" }, { value: "inactive", label: "비활성" }]} />
          </div>
          {/* 시스템 권한(RBAC roleId) 필터 — 실제 RBAC 역할 기준(§4·§23). 새 권한 개념 없음. */}
          {rbacRoles.length > 0 && (
            <div style={{ width: 160 }}>
              <ClickSelect value={systemRoleFilter} onChange={v => setSystemRoleFilter(v || "all")} style={{ width: "100%" }}
                triggerStyle={{ width: "100%", fontSize: 13, padding: "8px 10px", borderRadius: 8 }}
                data-testid="user-rbac-filter" aria-label="시스템 권한 필터"
                options={[{ value: "all", label: "권한: 전체" }, ...rbacRoles.map(r => ({ value: String(r.id), label: r.name }))]} />
            </div>
          )}
          <GhostBtn onClick={fetchUsers} disabled={usersLoading} style={{ padding: "8px 14px", fontSize: 13 }}>
            {usersLoading ? "불러오는 중..." : "새로고침"}
          </GhostBtn>
          {(userSearch.trim() || userRoleFilter !== "all" || accountStatusFilter !== "all" || systemRoleFilter !== "all") && (
            <button onClick={() => { setUserSearch(""); setUserRoleFilter("all"); setAccountStatusFilter("all"); setSystemRoleFilter("all"); }}
              data-testid="user-filter-reset"
              style={{ background: "none", border: "1px solid #d1d5db", borderRadius: 8, padding: "7px 12px", fontSize: 12, color: "#6b7280", cursor: "pointer" }}>
              초기화
            </button>
          )}
        </div>
      </div>

      {/* 선택 기반 일괄 관리 바 — 공용 컴포넌트 재사용(§16·§22). 본인/마지막 관리자는 서버·클라이언트 이중 보호. */}
      {!usersLoading && filtered.length > 0 && (
        <BulkSelectBar
          allSelected={pageIds.length > 0 && bulk.allSelected(pageIds)}
          onToggleAll={() => bulk.togglePage(pageIds)}
          selectedCount={bulk.selectedCount}
        >
          <button data-testid="user-bulk-activate" disabled={selectableCount === 0 || bulkBusy}
            onClick={() => handleBulkSetActive(true)} style={bulkActionBtn(selectableCount > 0 && !bulkBusy, "#059669", "#f0fdf4", "#86efac")}>선택 활성화</button>
          <button data-testid="user-bulk-deactivate" disabled={selectableCount === 0 || bulkBusy}
            onClick={() => handleBulkSetActive(false)} style={bulkActionBtn(selectableCount > 0 && !bulkBusy, "#b45309", "#fffbeb", "#fde68a")}>선택 비활성화</button>
          <button data-testid="user-bulk-delete" disabled={selectableCount === 0 || bulkBusy}
            onClick={() => { setDeleteReason(""); setBulkDeleteOpen(true); }} style={bulkActionBtn(selectableCount > 0 && !bulkBusy, "#dc2626", "#fef2f2", "#fca5a5")}>선택 삭제</button>
        </BulkSelectBar>
      )}

      {/* 사용자 목록 */}
      {usersLoading ? (
        <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
      ) : filtered.length === 0 ? (
        <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>{users.length === 0 ? "사용자가 없습니다." : "조건에 맞는 사용자가 없습니다."}</Card>
      ) : (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table className="veritas-read-table" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ ...tableTh, width: 36, textAlign: "center" }} aria-label="선택" />
                  {/* 헤더 정렬 = 본문 정렬(접속만 center, 나머지 left) */}
                  {([
                    "ID","이메일/이름","유형","부서/직책","상태","접속","마지막 로그인","마지막 활동","가입일","시스템 권한(RBAC)","역할 변경","계정 상태","비밀번호","프로필",
                  ]).map(h => (
                    <th key={h} style={{ ...tableTh, textAlign: h === "접속" ? "center" : "left" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paged.map(u => (
                  <tr key={u.id} style={trashRowStyle(bulk.isSelected(u.id), false)}>
                    <td style={{ ...tableTd, textAlign: "center" }} onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={bulk.isSelected(u.id)} onChange={() => bulk.toggle(u.id)}
                        aria-label={`사용자 선택: ${u.name ?? u.email}`} data-testid={`user-select-${u.id}`}
                        style={{ width: 15, height: 15, cursor: "pointer" }} />
                    </td>
                    <td style={{ ...tableTd, color: "#9ca3af" }}>#{u.id}</td>
                    <td style={{ ...tableTd, fontWeight: 600, color: "#111827" }}>
                      {u.name && <div style={{ fontWeight: 700, marginBottom: 2 }}>{u.name}</div>}
                      <div style={{ fontSize: 12, color: u.name ? "#6b7280" : "#111827" }}>{u.email}</div>
                    </td>
                    <td style={tableTd}><RoleBadge role={u.role} /></td>
                    <td style={tableTd}>
                      {(u.role === "admin" || u.role === "staff") ? (
                        <div style={{ fontSize: 12 }}>
                          {u.department && <div style={{ fontWeight: 600, color: "#374151" }}>{u.department}</div>}
                          {u.jobTitle && <div style={{ color: "#6b7280" }}>{u.jobTitle}</div>}
                          {!u.department && !u.jobTitle && <span style={{ color: "#d1d5db" }}>—</span>}
                        </div>
                      ) : <span style={{ fontSize: 11, color: "#d1d5db" }}>—</span>}
                    </td>
                    <td style={tableTd}>
                      <span style={{ padding: "3px 10px", borderRadius: 20, fontSize: 12, fontWeight: 600, background: u.isActive ? "#f0fdf4" : "#fef2f2", color: u.isActive ? "#059669" : "#dc2626" }}>
                        {u.isActive ? "활성" : "비활성"}
                      </span>
                    </td>
                    <td style={{ ...tableTd, textAlign: "center" }}>
                      {u.isOnline ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 9px", borderRadius: 20, background: "#f0fdf4", border: "1px solid #86efac", fontSize: 11, fontWeight: 700, color: "#16a34a" }}>
                          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 3px #22c55e" }} />온라인
                        </span>
                      ) : (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 9px", borderRadius: 20, background: "#f3f4f6", border: "1px solid #e5e7eb", fontSize: 11, fontWeight: 600, color: "#9ca3af" }}>
                          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#d1d5db" }} />오프라인
                        </span>
                      )}
                    </td>
                    <td style={{ ...tableTd, fontSize: 11, color: "#6b7280", whiteSpace: "nowrap" }}>
                      {u.lastLoginAt ? (() => {
                        const d = new Date(u.lastLoginAt);
                        const now = new Date();
                        const diff = now.getTime() - d.getTime();
                        const mins = Math.floor(diff / 60000);
                        const hours = Math.floor(mins / 60);
                        const days = Math.floor(hours / 24);
                        if (mins < 1) return "방금";
                        if (mins < 60) return `${mins}분 전`;
                        if (hours < 24) return `오늘 ${d.toLocaleTimeString("ko-KR", { hour:"2-digit", minute:"2-digit" })}`;
                        if (days < 7) return `${days}일 전`;
                        return d.toLocaleDateString("ko-KR", { month:"2-digit", day:"2-digit" });
                      })() : <span style={{ color: "#d1d5db" }}>—</span>}
                    </td>
                    <td style={{ ...tableTd, fontSize: 11, color: "#6b7280", whiteSpace: "nowrap" }}>
                      {u.lastActivityAt ? (() => {
                        const d = new Date(u.lastActivityAt);
                        const diff = Date.now() - d.getTime();
                        const mins = Math.floor(diff / 60000);
                        const hours = Math.floor(mins / 60);
                        if (mins < 1) return "방금";
                        if (mins < 60) return `${mins}분 전`;
                        if (hours < 24) return `${hours}시간 전`;
                        return d.toLocaleDateString("ko-KR", { month:"2-digit", day:"2-digit" });
                      })() : <span style={{ color: "#d1d5db" }}>—</span>}
                    </td>
                    <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>
                      {formatDisplayDate(u.createdAt)}
                    </td>
                    <td style={tableTd}>
                      {(u.role === "admin" || u.role === "staff") ? (
                        <ClickSelect
                          disabled={roleChanging === u.id}
                          value={String(u.roleId ?? "")}
                          onChange={async (val) => {
                            setRoleChanging(u.id);
                            try {
                              const rid = val ? Number(val) : null;
                              const res = await fetch(api(`/api/admin/users/${u.id}/rbac-role`), {
                                method: "PATCH",
                                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                                body: JSON.stringify({ roleId: rid }),
                              });
                              if (!res.ok) { onToast("권한 지정 실패"); return; }
                              setUsers(prev => prev.map(x => x.id === u.id ? { ...x, roleId: rid } as AdminUser : x));
                              onToast("RBAC 권한이 변경되었습니다.");
                            } finally { setRoleChanging(null); }
                          }}
                          options={[
                            { value: "", label: u.role === "admin" && !u.roleId ? "전체 권한" : "권한 선택" },
                            ...rbacRoles.map(r => ({ value: String(r.id), label: r.name, sub: r.description ?? undefined })),
                          ]}
                          triggerStyle={{ border: "1px solid #e9d5ff", background: "#faf5ff", color: "#7c3aed", fontWeight: 700, fontSize: 12 }}
                        />
                      ) : <span style={{ fontSize: 11, color: "#d1d5db" }}>—</span>}
                    </td>
                    <td style={tableTd}>
                      {u.id !== currentUser.id ? (
                        <ClickSelect
                          disabled={roleChanging === u.id}
                          value={u.role}
                          onChange={val => handleRoleChange(u.id, val)}
                          options={[
                            { value: "admin", label: "관리자" },
                            { value: "staff", label: "직원" },
                            { value: "client", label: "고객" },
                            { value: "linguist", label: "통번역사" },
                          ]}
                          triggerStyle={{ fontSize: 12 }}
                        />
                      ) : <span style={{ fontSize: 12, color: "#9ca3af" }}>본인 계정</span>}
                    </td>
                    <td style={tableTd}>
                      {u.id !== currentUser.id ? (
                        <button onClick={() => handleToggleActive(u.id)} disabled={toggling === u.id}
                          style={{
                            padding: "4px 10px", fontSize: 12, borderRadius: 6, fontWeight: 600,
                            cursor: toggling === u.id ? "not-allowed" : "pointer",
                            background: u.isActive ? "#fef2f2" : "#f0fdf4",
                            color: u.isActive ? "#dc2626" : "#059669",
                            border: `1px solid ${u.isActive ? "#fca5a5" : "#86efac"}`,
                          }}>
                          {toggling === u.id ? "처리 중..." : u.isActive ? "비활성화" : "활성화"}
                        </button>
                      ) : <span style={{ fontSize: 12, color: "#9ca3af" }}>본인</span>}
                    </td>
                    <td style={tableTd}>
                      <button onClick={() => onResetPassword(u.id)}
                        style={{ padding: "4px 10px", fontSize: 11, borderRadius: 6, fontWeight: 600, cursor: "pointer", background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" }}>
                        재설정
                      </button>
                    </td>
                    <td style={tableTd}>
                      {u.role === "translator" ? (
                        <button onClick={() => onTranslatorProfile(u.id, u.email)}
                          style={{ padding: "4px 10px", fontSize: 12, borderRadius: 6, fontWeight: 600, cursor: "pointer", background: "#f5f3ff", color: "#7c3aed", border: "1px solid #ddd6fe" }}>
                          프로필
                        </button>
                      ) : <span style={{ fontSize: 12, color: "#d1d5db" }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* 페이지네이션 — 공용 컴포넌트(상품·거래처 목록과 동일 UX) */}
      {!usersLoading && filtered.length > 0 && (
        <ListPagination
          total={total} totalPages={totalPages} page={page} pageSize={pageSize}
          rangeStart={rangeStart} rangeEnd={rangeEnd} setPage={setPage} setPageSize={setPageSize}
        />
      )}

      {/* 선택 삭제 확인 모달 */}
      {bulkDeleteOpen && (
        <DeleteConfirm
          heading={`선택한 ${selectableCount}명의 사용자를 삭제하시겠습니까?`}
          target={[...bulk.selectedIds].filter(id => id !== currentUser.id).map(id => users.find(u => u.id === id)?.name ?? users.find(u => u.id === id)?.email).filter(Boolean).slice(0, 5).join(", ") + (selectableCount > 5 ? ` 외 ${selectableCount - 5}명` : "")}
          reason={deleteReason} setReason={setDeleteReason} busy={deleting}
          onCancel={() => { setBulkDeleteOpen(false); setDeleteReason(""); }}
          onConfirm={handleBulkDeleteConfirm}
          testidPrefix="user-bulk-delete"
        />
      )}
    </Section>
  );
}

// ─── 사용자 삭제 확인 모달 (거래처 삭제 모달과 동일 스타일: 빨간 상단 보더 · 취소/삭제) ──
function DeleteConfirm({ heading, target, reason, setReason, busy, onCancel, onConfirm, testidPrefix }: {
  heading: string; target: string; reason: string; setReason: (v: string) => void; busy: boolean;
  onCancel: () => void; onConfirm: () => void; testidPrefix: string;
}) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9100, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={() => { if (!busy) onCancel(); }}>
      <div onClick={e => e.stopPropagation()} data-testid={`modal-${testidPrefix}`}
        style={{ background: "#fff", borderRadius: 14, padding: "26px 30px", width: 500, maxWidth: "92vw", boxShadow: "0 20px 60px rgba(0,0,0,0.25)", borderTop: "4px solid #dc2626", maxHeight: "88vh", overflowY: "auto" }}>
        <h2 style={{ margin: "0 0 6px", fontSize: 18, fontWeight: 800, color: "#111827" }}>{heading}</h2>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: "#6b7280", lineHeight: 1.6 }}>
          이 사용자를 삭제하면 사용자관리 목록에서 제외되고 <strong style={{ color: "#2563eb" }}>사용자 휴지통으로 이동</strong>합니다.
          기존 업무 이력(견적·프로젝트·정산·로그 등)은 삭제되지 않습니다.
        </p>
        {target && (
          <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 13, color: "#111827", fontWeight: 700 }}>
            {target}
          </div>
        )}
        <label style={{ display: "block", fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 6 }}>삭제 사유 <span style={{ color: "#9ca3af", fontWeight: 500 }}>(선택)</span></label>
        <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2}
          placeholder="예: 퇴사 / 중복 계정 / 권한 회수"
          data-testid={`input-${testidPrefix}-reason`} aria-label="삭제 사유"
          style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, boxSizing: "border-box", outline: "none", resize: "vertical", fontFamily: "inherit" }} />
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 18 }}>
          <button onClick={onCancel} disabled={busy} data-testid={`btn-${testidPrefix}-cancel`}
            style={{ padding: "9px 20px", borderRadius: 8, border: "1px solid #d1d5db", background: "#f9fafb", fontSize: 13, fontWeight: 600, cursor: busy ? "not-allowed" : "pointer", color: "#374151" }}>
            취소
          </button>
          <button onClick={onConfirm} disabled={busy} data-testid={`btn-${testidPrefix}-confirm`}
            style={{ padding: "9px 20px", borderRadius: 8, border: "none", color: "#fff", fontSize: 13, fontWeight: 700, background: busy ? "#fca5a5" : "#dc2626", cursor: busy ? "not-allowed" : "pointer" }}>
            {busy ? "처리 중…" : "휴지통으로 이동"}
          </button>
        </div>
      </div>
    </div>
  );
}
