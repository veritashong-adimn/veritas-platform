import React, { useState, useCallback, useEffect } from 'react';
import {
  api, Company,
  VENDOR_TYPE_LABELS, VENDOR_TYPE_OPTIONS,
  CUSTOMER_TYPE_LABELS, getCustomerTypeBadgeColors,
} from '../../lib/constants';
import { Card, PrimaryBtn, GhostBtn, ClickSelect } from '../ui';
import { Pagination } from '../ui/Paginator';
import { CompanyDetailModal } from './CompanyDetailModal';
import { BulkImportPage } from './BulkImportPage';
import { CompanyTrashTab } from './CompanyTrashTab';
import { CompanyCreatePage } from './CompanyCreatePage';
import { CompanyEditPage } from './CompanyEditPage';
import { usePathname, navigate, parseCompanyRoute, companyPaths } from '../../lib/adminNav';

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

// ─── Design System: 유형 컬럼 컴팩트 배지 ────────────────────────────────────
// 목록의 '유형' 컬럼은 거래처 상세의 '거래처 유형'과 동일 데이터(customerType/vendorType)를
// 사용한다. 거래처명이 우선 보이도록 보조정보 수준의 컴팩트한 배지로 표시한다.
function getCompanyTypeBadge(
  c: { companyType: string; customerType?: string | null; vendorType?: string | null }
): { label: string; style: React.CSSProperties } {
  const base: React.CSSProperties = {
    display: "inline-block", fontSize: 11, fontWeight: 600, padding: "1px 7px",
    borderRadius: 4, lineHeight: 1.4, whiteSpace: "nowrap",
  };
  if (c.companyType === "vendor") {
    const label = c.vendorType ? (VENDOR_TYPE_LABELS[c.vendorType] ?? c.vendorType) : "외주업체";
    return { label, style: { ...base, background: "#f5f3ff", color: "#7c3aed", border: "1px solid #ddd6fe" } };
  }
  const ct = c.customerType ?? "CORPORATE";
  const { bg, color, border } = getCustomerTypeBadgeColors(ct);
  return { label: CUSTOMER_TYPE_LABELS[ct] ?? "기업", style: { ...base, background: bg, color, border: `1px solid ${border}` } };
}
// ─────────────────────────────────────────────────────────────────────────────

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
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

interface CompanyManagementTabProps {
  token: string;
  onToast: (msg: string) => void;
  onOpenProject: (id: number) => void;
  onOpenTranslator?: (userId: number, email: string) => void;
  hasPerm: (key: string | undefined) => boolean;
  /** 관리자 여부 — 거래처 삭제/휴지통 영구삭제는 관리자만 가능(서버에서도 재검증) */
  isAdmin: boolean;
}

/**
 * CompanyManagementTab — 거래처 화면 라우터.
 *
 * URL(/admin/companies · /new · /:id/edit)에 따라 목록 / 등록 / 수정 화면을 전환한다.
 * 등록·수정 입력은 공통 CompanyForm 을 쓰는 CompanyCreatePage / CompanyEditPage 가 담당하고,
 * 이 컴포넌트 자체는 목록(조회·검색·삭제·휴지통·대량등록) 전용이다.
 */
export function CompanyManagementTab({ token, onToast, onOpenProject, onOpenTranslator, hasPerm, isAdmin }: CompanyManagementTabProps) {
  const authHeaders = { Authorization: `Bearer ${token}` };
  const pathname = usePathname();
  const route = parseCompanyRoute(pathname);

  const [companies, setCompanies] = useState<Company[]>([]);
  const [companiesLoading, setCompaniesLoading] = useState(false);
  const [companySearch, setCompanySearch] = useState("");
  const [companyModal, setCompanyModal] = useState<number | null>(null);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [companyTypeFilter, setCompanyTypeFilter] = useState<"all" | "client" | "vendor">("all");
  const [companyVendorTypeFilter, setCompanyVendorTypeFilter] = useState<string>("all");
  const [companyCustomerTypeFilter, setCompanyCustomerTypeFilter] = useState<string>("all");
  // ── 서버 페이지네이션 상태 ──
  const [companyPage, setCompanyPage] = useState(1);
  const [companyPageSize, setCompanyPageSize] = useState(20);
  const [companyTotal, setCompanyTotal] = useState(0);
  const [appliedSearch, setAppliedSearch] = useState("");   // 실제 조회에 반영된 검색어(입력값과 분리)
  const [companyCounts, setCompanyCounts] = useState<{ all: number; client: number; vendor: number; customer: Record<string, number> }>(
    { all: 0, client: 0, vendor: 0, customer: {} },
  );

  // ── 삭제(휴지통 이동) · 휴지통 상태 ──
  const [showTrash, setShowTrash] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Company | null>(null);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleting, setDeleting] = useState(false);
  // 삭제 확인창용 연결 데이터 카운트 (delete-check 재사용)
  const [deleteCheck, setDeleteCheck] = useState<{ loading: boolean; reasons: { label: string; count: number }[] }>({ loading: false, reasons: [] });

  const REASON_PRESETS = ["중복 등록", "잘못 등록", "폐업", "거래 종료", "기타"];

  const fetchCompanies = useCallback(async () => {
    setCompaniesLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("page", String(companyPage));
      params.set("pageSize", String(companyPageSize));
      if (appliedSearch.trim()) params.set("search", appliedSearch.trim());
      if (companyTypeFilter !== "all") params.set("companyType", companyTypeFilter);
      if (companyTypeFilter === "vendor" && companyVendorTypeFilter !== "all") params.set("vendorType", companyVendorTypeFilter);
      if (companyTypeFilter === "client" && companyCustomerTypeFilter !== "all") params.set("customerType", companyCustomerTypeFilter);
      const res = await fetch(api(`/api/admin/companies?${params.toString()}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) {
        // 페이지네이션 응답({rows,total,counts})과 레거시 배열 응답을 모두 허용(빌드 버전 불일치 내성)
        const rows: Company[] = Array.isArray(data?.rows) ? data.rows : Array.isArray(data) ? data : [];
        const total: number = typeof data?.total === "number" ? data.total : rows.length;
        setCompanies(rows);
        setCompanyTotal(total);
        setCompanyCounts(data?.counts ?? { all: 0, client: 0, vendor: 0, customer: {} });
        // 현재 페이지가 비었는데 이전 페이지가 존재하면 자동으로 한 페이지 뒤로(삭제 후 처리)
        if (rows.length === 0 && total > 0 && companyPage > 1) {
          setCompanyPage(p => Math.max(1, p - 1));
        }
      } else {
        // 오류를 빈 목록으로 감추지 않고 명시적으로 표시(§7)
        onToast(`오류: 거래처 조회 실패 (${res.status})`);
      }
    } catch { onToast("오류: 거래처 조회 실패"); }
    finally { setCompaniesLoading(false); }
  }, [token, companyPage, companyPageSize, appliedSearch, companyTypeFilter, companyVendorTypeFilter, companyCustomerTypeFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // 조회 파라미터(페이지·페이지크기·검색·필터) 변경 시 자동 재조회
  useEffect(() => { fetchCompanies(); }, [fetchCompanies]);

  // 검색 실행: 입력값을 조회에 반영하고 1페이지로
  const runCompanySearch = useCallback(() => {
    setAppliedSearch(companySearch.trim());
    setCompanyPage(1);
  }, [companySearch]);

  // 삭제 모달 열기 — 연결 데이터 카운트를 미리 조회해 사용자에게 표시한다.
  const openDeleteModal = useCallback(async (c: Company) => {
    setDeleteTarget(c);
    setDeleteReason("");
    setDeleteCheck({ loading: true, reasons: [] });
    try {
      const res = await fetch(api(`/api/admin/companies/${c.id}/delete-check`), { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => ({}));
      setDeleteCheck({ loading: false, reasons: Array.isArray(data?.reasons) ? data.reasons : [] });
    } catch {
      setDeleteCheck({ loading: false, reasons: [] });
    }
  }, [token]);

  const handleDeleteCompany = useCallback(async () => {
    if (!deleteTarget || deleting) return;
    const reason = deleteReason.trim();
    if (reason.length < 2) { onToast("삭제 사유를 2자 이상 입력해 주세요."); return; }
    setDeleting(true);
    try {
      const res = await fetch(api(`/api/admin/companies/${deleteTarget.id}`), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? "거래처 삭제에 실패했습니다."); return; }
      onToast("거래처를 휴지통으로 이동했습니다.");
      setDeleteTarget(null);
      setDeleteReason("");
      fetchCompanies();
    } catch {
      onToast("거래처 삭제 중 오류가 발생했습니다.");
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, deleting, deleteReason, token, onToast]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 상세 모달 열기 — 목록이 아닌 화면(등록/수정)에서 호출되면 목록으로 이동 후 연다. */
  const openCompanyDetail = useCallback((id: number) => {
    setCompanyModal(id);
    if (parseCompanyRoute(window.location.pathname)?.view !== "list") navigate(companyPaths.list);
  }, []);

  // ── 대량등록 / 휴지통 전체화면 ──
  if (showBulkImport) {
    return (
      <BulkImportPage
        entity="company"
        token={token}
        onToast={onToast}
        onClose={() => setShowBulkImport(false)}
        onDone={() => { void fetchCompanies(); }}
      />
    );
  }

  if (showTrash) {
    return (
      <CompanyTrashTab
        token={token}
        isAdmin={isAdmin}
        onToast={onToast}
        onBack={() => { setShowTrash(false); fetchCompanies(); }}
      />
    );
  }

  // ── 거래처 등록 페이지 (/admin/companies/new) ──
  if (route?.view === "new") {
    return (
      <CompanyCreatePage
        token={token}
        onToast={onToast}
        onCancel={() => navigate(companyPaths.list)}
        onCreated={(id) => { navigate(companyPaths.list); setCompanyModal(id); fetchCompanies(); }}
        onOpenCompany={openCompanyDetail}
        onOpenTranslator={onOpenTranslator}
      />
    );
  }

  // ── 거래처 수정 페이지 (/admin/companies/:id/edit) ──
  if (route?.view === "edit") {
    return (
      <CompanyEditPage
        companyId={route.id}
        token={token}
        onToast={onToast}
        onCancel={() => { navigate(companyPaths.list); setCompanyModal(route.id); }}
        onSaved={(id) => { navigate(companyPaths.list); setCompanyModal(id); fetchCompanies(); }}
      />
    );
  }

  // ── 거래처 관리 (목록) ──
  return (
    <>
      {/* ── 거래처 삭제(휴지통 이동) 확인 모달 (관리자 전용) ── */}
      {deleteTarget && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9100, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => { if (!deleting) { setDeleteTarget(null); setDeleteReason(""); } }}>
          <div onClick={e => e.stopPropagation()} data-testid="modal-company-delete"
            style={{ background: "#fff", borderRadius: 14, padding: "26px 30px", width: 480, maxWidth: "92vw", boxShadow: "0 20px 60px rgba(0,0,0,0.25)", borderTop: "4px solid #dc2626", maxHeight: "88vh", overflowY: "auto" }}>
            <h2 style={{ margin: "0 0 6px", fontSize: 18, fontWeight: 800, color: "#111827" }}>거래처를 삭제하시겠습니까?</h2>
            <p style={{ margin: "0 0 14px", fontSize: 13, color: "#6b7280", lineHeight: 1.6 }}>
              삭제된 거래처는 <strong style={{ color: "#2563eb" }}>휴지통에서 복원할 수 있습니다.</strong> 연결된 데이터(담당자·견적·프로젝트 등)는 그대로 유지됩니다.
            </p>

            {/* 거래처명 + 연결 데이터 요약 */}
            <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "12px 14px", marginBottom: 16, fontSize: 13 }}>
              <div style={{ color: "#111827", fontWeight: 700, marginBottom: 8 }}>{deleteTarget.name}</div>
              {deleteCheck.loading ? (
                <div style={{ color: "#9ca3af", fontSize: 12 }}>연결 데이터 확인 중…</div>
              ) : deleteCheck.reasons.length === 0 ? (
                <div style={{ color: "#6b7280", fontSize: 12 }}>연결된 업무 데이터가 없습니다.</div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {deleteCheck.reasons.map(r => (
                    <span key={r.label} style={{ fontSize: 12, fontWeight: 600, color: "#374151", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 6, padding: "2px 8px" }}>
                      {r.label} <strong style={{ color: "#111827" }}>{r.count.toLocaleString()}</strong>건
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* 삭제 사유 (필수, 2자 이상) */}
            <label style={{ display: "block", fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 6 }}>
              삭제 사유 <span style={{ color: "#dc2626" }}>*</span>
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              {REASON_PRESETS.map(p => (
                <button key={p} type="button" onClick={() => setDeleteReason(p === "기타" ? "" : p)}
                  data-testid={`btn-delete-reason-${p}`}
                  style={{ fontSize: 12, padding: "4px 10px", borderRadius: 14, cursor: "pointer", fontWeight: 600,
                    background: deleteReason === p ? "#eff6ff" : "#fff",
                    color: deleteReason === p ? "#2563eb" : "#6b7280",
                    border: `1px solid ${deleteReason === p ? "#bfdbfe" : "#e5e7eb"}` }}>
                  {p}
                </button>
              ))}
            </div>
            <textarea
              value={deleteReason}
              onChange={e => setDeleteReason(e.target.value)}
              placeholder="예: 중복 등록 / 잘못 등록 / 폐업 / 거래 종료"
              rows={2}
              data-testid="input-company-delete-reason"
              aria-label="삭제 사유 입력"
              style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, boxSizing: "border-box", outline: "none", resize: "vertical", fontFamily: "inherit" }}
            />
            <p style={{ margin: "4px 0 18px", fontSize: 11, color: "#9ca3af" }}>최소 2자 이상 입력해 주세요.</p>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => { setDeleteTarget(null); setDeleteReason(""); }} disabled={deleting} data-testid="btn-company-delete-cancel"
                style={{ padding: "9px 20px", borderRadius: 8, border: "1px solid #d1d5db", background: "#f9fafb", fontSize: 13, fontWeight: 600, cursor: deleting ? "not-allowed" : "pointer", color: "#374151" }}>
                취소
              </button>
              <button onClick={handleDeleteCompany} disabled={deleteReason.trim().length < 2 || deleting} data-testid="btn-company-delete-confirm"
                style={{ padding: "9px 20px", borderRadius: 8, border: "none", color: "#fff", fontSize: 13, fontWeight: 700,
                  background: deleteReason.trim().length >= 2 && !deleting ? "#dc2626" : "#fca5a5",
                  cursor: deleteReason.trim().length >= 2 && !deleting ? "pointer" : "not-allowed" }}>
                {deleting ? "삭제 중…" : "휴지통으로 이동"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 거래처 상세 모달 ── */}
      {companyModal !== null && (
        <CompanyDetailModal
          companyId={companyModal}
          token={token}
          onClose={() => setCompanyModal(null)}
          onToast={onToast}
          onOpenProject={(id) => { setCompanyModal(null); onOpenProject(id); }}
          onEdit={(id) => { setCompanyModal(null); navigate(companyPaths.edit(id)); }}
          onRefresh={fetchCompanies}
          onDeleted={() => { setCompanyModal(null); fetchCompanies(); }}
        />
      )}

      <Section title={`거래처 관리 (${companyTotal.toLocaleString()})`} action={
        (
          <div style={{ display: "flex", gap: 8 }}>
            {hasPerm("company.create") && (
              <>
                <PrimaryBtn onClick={() => navigate(companyPaths.new)} style={{ fontSize: 13, padding: "7px 14px" }}
                  data-testid="company-create-btn">
                  + 거래처 등록
                </PrimaryBtn>
                <GhostBtn onClick={() => setShowBulkImport(true)} style={{ fontSize: 13, padding: "7px 14px" }}
                  data-testid="company-bulk-import-btn" aria-label="거래처 대량등록">
                  대량등록
                </GhostBtn>
              </>
            )}
            <GhostBtn onClick={() => setShowTrash(true)} style={{ fontSize: 13, padding: "7px 14px" }}
              data-testid="company-trash-btn" aria-label="거래처 휴지통">
              🗑 휴지통
            </GhostBtn>
          </div>
        )
      }>

        {/* ── 거래처 유형 필터 탭 ── */}
        {(() => {
          const TYPE_TABS = [
            { value: "all",    label: "전체",    activeBg: "#374151" },
            { value: "client", label: "고객사",  activeBg: "#1d4ed8" },
            { value: "vendor", label: "외주업체", activeBg: "#7c3aed" },
          ];
          const CUSTOMER_SUB_TABS = [
            { value: "all",        label: "전체" },
            { value: "CORPORATE",  label: "기업" },
            { value: "PUBLIC",     label: "공공기관" },
            { value: "INDIVIDUAL", label: "개인" },
          ];
          // 필터·검색·페이지 변경 시 서버에서 조회한 현재 페이지(companies)를 그대로 렌더.
          // 필터 변경 시 1페이지부터 다시 조회한다.
          const typeCount = (v: string) => v === "all" ? companyCounts.all : v === "client" ? companyCounts.client : companyCounts.vendor;
          return (
            <div style={{ marginBottom: 16 }}>
              {/* 1행: 거래처 유형 (1차) */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginRight: 6, whiteSpace: "nowrap", letterSpacing: "-0.01em" }}>거래처 유형</span>
                {TYPE_TABS.map(tab => {
                  const isActive = companyTypeFilter === tab.value;
                  return (
                    <button key={tab.value} onClick={() => { setCompanyTypeFilter(tab.value as "all" | "client" | "vendor"); setCompanyVendorTypeFilter("all"); setCompanyCustomerTypeFilter("all"); setCompanyPage(1); }}
                      style={{
                        padding: "6px 14px", borderRadius: 20, fontSize: 13, fontWeight: isActive ? 700 : 500,
                        cursor: "pointer", transition: "all 0.12s",
                        border: isActive ? `2px solid ${tab.activeBg}` : "2px solid #e5e7eb",
                        background: isActive ? tab.activeBg : "#fff",
                        color: isActive ? "#fff" : "#374151",
                        lineHeight: "1.4",
                      }}>
                      {tab.label}
                      <span style={{ marginLeft: 5, fontSize: 11, opacity: 0.75 }}>
                        ({typeCount(tab.value).toLocaleString()})
                      </span>
                    </button>
                  );
                })}
              </div>
              {/* 2행: 고객 분류 (고객사 선택 시) */}
              {companyTypeFilter === "client" && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, paddingLeft: 18, paddingTop: 6, paddingBottom: 6, borderLeft: "3px solid #93c5fd" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#1d4ed8", marginRight: 6, whiteSpace: "nowrap", letterSpacing: "-0.01em" }}>고객 분류</span>
                  {CUSTOMER_SUB_TABS.map(tab => {
                    const isActive = companyCustomerTypeFilter === tab.value;
                    const { bg, color, border } = tab.value !== "all" ? getCustomerTypeBadgeColors(tab.value) : { bg: "", color: "", border: "" };
                    return (
                      <button key={tab.value} onClick={() => { setCompanyCustomerTypeFilter(tab.value); setCompanyPage(1); }}
                        style={{
                          padding: "5px 13px", borderRadius: 20, fontSize: 12, fontWeight: isActive ? 700 : 500,
                          cursor: "pointer", transition: "all 0.12s", lineHeight: "1.4",
                          border: isActive ? (tab.value === "all" ? "2px solid #1d4ed8" : `2px solid ${border}`) : "2px solid #e5e7eb",
                          background: isActive ? (tab.value === "all" ? "#1d4ed8" : bg) : "#fff",
                          color: isActive ? (tab.value === "all" ? "#fff" : color) : "#6b7280",
                        }}>
                        {tab.label}
                        {tab.value !== "all" && (
                          <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.8 }}>
                            ({(companyCounts.customer[tab.value] ?? 0).toLocaleString()})
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              {/* 2행: 외주 분류 (외주업체 선택 시) */}
              {companyTypeFilter === "vendor" && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, paddingLeft: 18, paddingTop: 6, paddingBottom: 6, borderLeft: "3px solid #c4b5fd" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#6d28d9", whiteSpace: "nowrap", marginRight: 6, letterSpacing: "-0.01em" }}>외주 분류</span>
                  <ClickSelect
                    value={companyVendorTypeFilter}
                    onChange={v => { setCompanyVendorTypeFilter(v); setCompanyPage(1); }}
                    triggerStyle={{ fontSize: 12, padding: "5px 11px", borderRadius: 20, lineHeight: "1.4" }}
                    options={[
                      { value: "all", label: "전체 외주 분류" },
                      ...VENDOR_TYPE_OPTIONS.map(o => ({ value: o.value, label: o.label })),
                    ]}
                  />
                </div>
              )}

              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
                <input value={companySearch} onChange={e => setCompanySearch(e.target.value)}
                  placeholder="회사명, 브랜드명, 사업자번호, 전화, 이메일, 담당자..."
                  style={{ ...inputStyle, maxWidth: 340, flex: "1 1 200px", padding: "8px 12px", fontSize: 13 }}
                  data-testid="company-search-input" aria-label="거래처 검색"
                  onKeyDown={e => e.key === "Enter" && runCompanySearch()} />
                <PrimaryBtn onClick={runCompanySearch} disabled={companiesLoading} style={{ padding: "8px 16px", fontSize: 13 }}>
                  {companiesLoading ? "검색 중..." : "검색"}
                </PrimaryBtn>
              </div>
              {/* ── 목록 ── */}
              <div style={{ marginTop: 14 }}>
                {companiesLoading ? (
                  <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
                ) : companies.length === 0 ? (
                  <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>해당하는 거래처가 없습니다.</Card>
                ) : (
                  <Card style={{ padding: 0, overflow: "hidden" }}>
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                          <tr>{["ID", "거래처명", "유형", "업종", "담당자", "프로젝트", "총 결제", "등록일", "관리"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                        </thead>
                        <tbody>
                          {companies.map(c => (
                            <tr key={c.id} onClick={() => setCompanyModal(c.id)} style={{ cursor: "pointer" }}
                              onMouseEnter={e => (e.currentTarget.style.background = "#eff6ff")}
                              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                              <td style={{ ...tableTd, color: "#9ca3af" }}>#{c.id}</td>
                              {/* 거래처명 — 회사명만 표시(유형 배지는 별도 컬럼으로 분리). 가장 강한 존재감. */}
                              <td style={{ ...tableTd, minWidth: 200 }}>
                                <div style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>
                                  {c.name}
                                  {c.matchedDivisionName && (
                                    <span style={{ fontWeight: 600, color: "#7c3aed", marginLeft: 4 }}>({c.matchedDivisionName})</span>
                                  )}
                                </div>
                                {!c.matchedDivisionName && (c.divisionNames?.length ?? 0) > 0 && (
                                  <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
                                    {c.divisionNames!.slice(0, 3).join(" · ")}{c.divisionNames!.length > 3 ? ` 외 ${c.divisionNames!.length - 3}개` : ""}
                                  </div>
                                )}
                              </td>
                              {/* 유형 — 거래처 상세의 '거래처 유형'과 동일 데이터. 최소 폭 · 보조정보 배지. */}
                              <td style={{ ...tableTd, width: 1, whiteSpace: "nowrap" }}>
                                {(() => { const b = getCompanyTypeBadge(c); return <span style={b.style}>{b.label}</span>; })()}
                              </td>
                              <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>{c.industry ?? "-"}</td>
                              <td style={{ ...tableTd, textAlign: "center" }}>
                                <span style={{ padding: "2px 8px", borderRadius: 10, background: "#f3f4f6", color: "#374151", fontSize: 12 }}>{c.contactCount}명</span>
                              </td>
                              <td style={{ ...tableTd, textAlign: "center" }}>
                                <span style={{ padding: "2px 8px", borderRadius: 10, background: "#eff6ff", color: "#2563eb", fontSize: 12, fontWeight: 600 }}>{c.projectCount}건</span>
                              </td>
                              <td style={{ ...tableTd, fontWeight: 600, color: "#059669", whiteSpace: "nowrap" }}>{Number(c.totalPayment).toLocaleString()}원</td>
                              {/* 등록일 = 홈택스 원본 등록일(registeredAt). 플랫폼 생성일(createdAt)이 아님. */}
                              <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>{c.registeredAt ? new Date(c.registeredAt).toLocaleDateString("ko-KR") : "-"}</td>
                              {/* 관리: 삭제(휴지통 이동). 관리자만 활성, 그 외 비활성 + 안내 툴팁. 서버에서도 재검증. */}
                              <td style={{ ...tableTd, textAlign: "center" }} onClick={e => e.stopPropagation()}>
                                <button
                                  type="button"
                                  onClick={() => { if (isAdmin) openDeleteModal(c); else onToast("거래처 삭제는 관리자만 가능합니다."); }}
                                  disabled={!isAdmin}
                                  title={isAdmin ? "거래처 삭제(휴지통 이동)" : "거래처 삭제는 관리자만 가능합니다."}
                                  aria-disabled={!isAdmin}
                                  data-testid={`btn-delete-company-${c.id}`}
                                  aria-label={`${c.name} 삭제`}
                                  style={{
                                    fontSize: 11, height: 24, padding: "0 10px", borderRadius: 6, fontWeight: 600,
                                    cursor: isAdmin ? "pointer" : "not-allowed",
                                    background: isAdmin ? "#fef2f2" : "#f3f4f6",
                                    color: isAdmin ? "#dc2626" : "#9ca3af",
                                    border: `1px solid ${isAdmin ? "#fca5a5" : "#e5e7eb"}`,
                                  }}
                                >
                                  삭제
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                )}
                {companyTotal > 0 && (
                  <Pagination
                    idPrefix="company"
                    page={companyPage}
                    pageSize={companyPageSize}
                    total={companyTotal}
                    unit="건"
                    disabled={companiesLoading}
                    onPageChange={setCompanyPage}
                    onPageSizeChange={s => { setCompanyPageSize(s); setCompanyPage(1); }}
                  />
                )}
              </div>
            </div>
          );
        })()}
      </Section>
    </>
  );
}
