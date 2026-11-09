/**
 * CustomerManagementTab — 고객관리(거래처 통합 뷰).
 *
 *  · 데이터 원본 = 거래처(companies, company_type=client). 별도 고객 등록·customers 테이블은 사용하지 않는다.
 *    고객사 등록·정보 수정은 거래처관리에서 한다(중복 입력 제거).
 *  · [선택 삭제](체크박스) = 고객관리 대상에서만 제외(거래처 원본·담당자·판매·청구·수금 이력 보존). [제외 목록]에서 복원.
 *  · 신규 매출 = 판매관리 판매금액 기준, 과거 CRM 매출은 별도 표시(합산 안 함).
 *  · 확인된 미수금 = 수금관리 청구·입금 기준. 청구정보가 없으면 '청구정보 없음'(미수금 0원 아님).
 *  · 과거 미수금 미확인 = 수금관리 과거 CRM 판정 규칙으로 입금이 확인되지 않은 과거 판매 건수(금액 합산 안 함).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/constants';
import { formatPhoneDisplay, formatWon } from '../../lib/utils';
import { Card, PrimaryBtn, GhostBtn, confirmDialog } from '../ui';
import { Pagination } from '../ui/Paginator';
import { CompanyDetailModal } from './CompanyDetailModal';
import { stickyBulkBarStyle } from './bulkListShared';
import { bulkBtnStyle } from './product/productShared';
import { GradeBadge } from './customerGrade';
import { CustomerGradeSection } from './CustomerGradeSection';
import { CustomerRankingView } from './CustomerRankingView';
import './readTableView.css';

const inputStyle: React.CSSProperties = {
  padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13,
  color: '#111827', outline: 'none', boxSizing: 'border-box', background: '#fff',
};
const tableTh: React.CSSProperties = {
  padding: '10px 12px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#6b7280',
  background: '#f9fafb', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap',
};
const tableTd: React.CSSProperties = {
  padding: '9px 12px', fontSize: 13, color: '#374151', borderBottom: '1px solid #edf0f3', verticalAlign: 'middle',
};
const sub: React.CSSProperties = { fontSize: 11, color: '#9ca3af', marginTop: 2 };
const clip: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const amtLabel: React.CSSProperties = { fontSize: 11, color: '#9ca3af', fontWeight: 400, marginRight: 2 };

// 컬럼 정의 — 헤더·colgroup·본문이 같은 너비/정렬/좌우 여백을 쓴다(헤더-데이터 정렬 일치). 좌우 여백 12px 통일.
//  · 너비는 실제 데이터 길이 실측(고객사 3,725곳, 화면 글꼴) 기준 — 고정 비율 아님:
//      content = 셀에 표시되는 내용 폭(대부분의 행이 들어가는 폭), typical = 흔한 행의 내용 폭(간격 계산용).
//      고객사명은 90%가 203px 이내(넘으면 말줄임), 매출(신규 매출·과거 CRM 매출 문구 포함) 최대 155px,
//      미수금(확인된 미수금·청구정보 없음·과거 미수금 미확인 문구 포함) 최대 140px, 최근 거래 88px 등.
//  · 기본 폭 = content + 좌우 여백. 남는 화면 폭은 '컬럼 사이 실제 빈 공간'이 같아지도록 나눈다(layoutColumns).
//    등급은 배지 폭만 사용(등급↔프로젝트 사이는 좁게 유지). 화면이 기본 폭 합보다 좁으면 가로 스크롤.
type ColKey = 'name' | 'contact' | 'grade' | 'projects' | 'sales' | 'receivable' | 'last' | 'excludedAt' | 'action';
const PAD = 12;
const CHECK_W = 40;
const COLS: Record<ColKey, { label: string; align: 'left' | 'center' | 'right'; content: number; typical: number }> = {
  name:       { label: '고객사',          align: 'left',   content: 206, typical: 173 },
  contact:    { label: '담당자 · 연락처', align: 'left',   content: 80,  typical: 70 },
  grade:      { label: '등급',            align: 'center', content: 50,  typical: 36 },
  projects:   { label: '프로젝트 현황',   align: 'left',   content: 80,  typical: 68 },
  sales:      { label: '매출',            align: 'right',  content: 156, typical: 124 },
  receivable: { label: '미수금',          align: 'right',  content: 140, typical: 70 },
  last:       { label: '최근 거래',       align: 'center', content: 88,  typical: 88 },
  excludedAt: { label: '삭제일',          align: 'center', content: 70,  typical: 70 },
  action:     { label: '',                align: 'center', content: 50,  typical: 50 },
};
// 남는 폭을 간격이 가장 좁은 곳부터 채워(water-filling) 컬럼 사이 빈 공간을 균등화한다.
//  간격은 앞 컬럼 내용 끝 ~ 뒤 컬럼 내용 시작. 각 간격을 넓히는 컬럼: 왼쪽 정렬 앞 컬럼 / 오른쪽 정렬 뒤 컬럼 /
//  가운데 정렬 컬럼(양쪽 간격에 절반씩 → 2px 당 1px). 등급(가운데)은 넓히지 않는다.
function layoutColumns(keys: ColKey[], avail: number): Record<string, number> {
  const w: Record<string, number> = {};
  for (const k of keys) w[k] = COLS[k].content + PAD * 2;
  const used = keys.reduce((s, k) => s + w[k], 0);
  let extra = Math.floor(avail - used);
  if (extra <= 0) return w;
  const pos = (k: ColKey) => {
    const c = COLS[k], cw = w[k];
    return c.align === 'left' ? { l: PAD, r: PAD + c.typical } : c.align === 'right' ? { l: cw - PAD - c.typical, r: cw - PAD } : { l: (cw - c.typical) / 2, r: (cw + c.typical) / 2 };
  };
  const grower = (a: ColKey, b: ColKey): { k: ColKey; cost: number } | null => {
    if (COLS[a].align === 'left') return { k: a, cost: 1 };
    if (COLS[b].align === 'right') return { k: b, cost: 1 };
    if (COLS[a].align === 'center' && a !== 'grade') return { k: a, cost: 2 };
    if (COLS[b].align === 'center' && b !== 'grade') return { k: b, cost: 2 };
    return null;
  };
  const pairs = keys.slice(0, -1).map((a, i) => ({ a, b: keys[i + 1], g: grower(a, keys[i + 1]) })).filter((p) => p.g);
  while (extra > 0) {
    const gaps = pairs.map((p) => (w[p.a] - pos(p.a).r) + pos(p.b).l);
    const i = gaps.indexOf(Math.min(...gaps));
    const g = pairs[i].g!;
    const step = Math.min(extra, g.cost);
    w[g.k] += step; extra -= step;
  }
  return w;
}
const cellStyle = (k: ColKey, base: React.CSSProperties): React.CSSProperties =>
  ({ ...base, textAlign: COLS[k].align, paddingLeft: PAD, paddingRight: PAD });

interface CustomerRow {
  id: number; name: string; representativeName: string | null; businessNumber: string | null;
  phone: string | null; email: string | null;
  contact: { name: string; phone: string | null; email: string | null } | null;
  projects: { total: number; inProgress: number; completed: number; cancelled: number };
  sales: { total: number };
  collection: { billingRows: number; billed: number; paid: number; receivable: number } | null;
  lastTransaction: string | null; lastProjectAt: string | null; lastPaidAt: string | null;
  legacyRef: { count: number; total: number; lastDate: string | null; paidConfirmed: number; noDeposit: number; needsReview: number } | null;
  excludedAt: string | null; excludedReason: string | null;
  grade: string; autoGrade: string; gradeOverridden: boolean; gradeReason: string;
}
interface ListResponse { total: number; counts: { active: number; excluded: number }; rows: CustomerRow[] }

export function CustomerManagementTab({ token, isAdmin, onToast, onOpenProject }: {
  token: string; isAdmin: boolean; onToast: (m: string) => void; onOpenProject: (id: number) => void;
}) {
  const [mode, setMode] = useState<'list' | 'ranking'>('list');
  const [view, setView] = useState<'active' | 'excluded'>('active');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // 목록 영역 실제 폭 — 컬럼 폭 배분(layoutColumns) 기준
  const tableBoxRef = useRef<HTMLDivElement | null>(null);
  const [tableBoxW, setTableBoxW] = useState(1200);
  useEffect(() => {
    const el = tableBoxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTableBoxW(el.clientWidth));
    ro.observe(el); setTableBoxW(el.clientWidth);
    return () => ro.disconnect();
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ view, page: String(page), pageSize: String(pageSize) });
      if (applied) p.set('search', applied);
      const res = await fetch(api(`/api/admin/customer-management?${p}`), { headers: { Authorization: `Bearer ${token}` } });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error ?? '고객 목록 조회 실패');
      setData(j);
      setSelectedIds(new Set());
    } catch (e) {
      onToast(`오류: ${e instanceof Error ? e.message : '고객 목록 조회 실패'}`);
    } finally { setLoading(false); }
  }, [token, view, page, pageSize, applied]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void load(); }, [load]);

  // 복원(삭제된 고객 목록 행 버튼) — 기존 기능 유지
  const restore = async (c: CustomerRow) => {
    const ok = await confirmDialog({ title: '고객 복원', message: `"${c.name}"을(를) 고객관리 목록으로 복원하시겠습니까?`, confirmLabel: '복원' });
    if (!ok) return;
    setBusyId(c.id);
    try {
      const res = await fetch(api(`/api/admin/customer-management/${c.id}/restore`), {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? '처리 실패');
      onToast(`"${c.name}" 고객이 복원되었습니다.`);
      await load();
    } catch (e) {
      onToast(`오류: ${e instanceof Error ? e.message : '처리 실패'}`);
    } finally { setBusyId(null); }
  };

  // 선택 삭제 — 기존 고객관리 제외 API 를 선택 건마다 호출(거래처 원본·이력 변경 없음)
  const deleteSelected = async () => {
    const targets = (data?.rows ?? []).filter((r) => selectedIds.has(r.id));
    if (!targets.length) return;
    const names = targets.slice(0, 3).map((t) => `"${t.name}"`).join(', ') + (targets.length > 3 ? ` 외 ${targets.length - 3}곳` : '');
    const ok = await confirmDialog({
      title: '선택 고객 삭제',
      message: `선택한 고객 ${targets.length}건(${names})을 고객관리 목록에서 삭제하시겠습니까?\n거래처 정보와 담당자·판매·청구·수금·과거 CRM 이력은 그대로 유지되며, [삭제된 고객]에서 복원할 수 있습니다.`,
      confirmLabel: `${targets.length}건 삭제`, variant: 'danger',
    });
    if (!ok) return;
    setBulkBusy(true);
    let done = 0; const failed: string[] = [];
    for (const t of targets) {
      try {
        const res = await fetch(api(`/api/admin/customer-management/${t.id}/exclude`), {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
        });
        if (res.ok) done += 1;
        else { const j = await res.json().catch(() => null); failed.push(`${t.name}(${j?.error ?? res.status})`); }
      } catch { failed.push(t.name); }
    }
    setBulkBusy(false);
    onToast(failed.length ? `${done}건 삭제 · ${failed.length}건 실패: ${failed.slice(0, 3).join(', ')}` : `선택한 고객 ${done}건이 삭제되었습니다.`);
    await load();
  };

  const runSearch = () => { setApplied(search.trim()); setPage(1); };
  const switchView = (v: 'active' | 'excluded') => { setView(v); setPage(1); };
  const rows = data?.rows ?? [];
  const excludedView = view === 'excluded';
  const selectable = !excludedView && isAdmin;
  const selectedCount = rows.filter((r) => selectedIds.has(r.id)).length;
  const allSelected = rows.length > 0 && rows.every((r) => selectedIds.has(r.id));
  const toggleOne = (id: number) => setSelectedIds((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSelectedIds(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  const canDelete = selectable && selectedCount > 0 && !bulkBusy;
  const colKeys: ColKey[] = ['name', 'contact', 'grade', 'projects', 'sales', 'receivable', 'last', ...(excludedView ? (['excludedAt', 'action'] as ColKey[]) : [])];
  const colW = layoutColumns(colKeys, tableBoxW - (selectable ? CHECK_W : 0));
  const tableW = colKeys.reduce((s, k) => s + colW[k], 0) + (selectable ? CHECK_W : 0);

  return (
    <>
      {detailId !== null && (
        <CompanyDetailModal companyId={detailId} entityLabel="고객사" token={token}
          onClose={() => setDetailId(null)} onToast={onToast}
          onOpenProject={(id) => { setDetailId(null); onOpenProject(id); }}
          onRefresh={load} onDeleted={() => { setDetailId(null); void load(); }}
          extraSection={<CustomerGradeSection companyId={detailId} token={token} isAdmin={isAdmin} onToast={onToast} onChanged={() => { void load(); }} />} />
      )}

      <div style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>
            고객 관리 ({(data?.counts.active ?? 0).toLocaleString()})
          </h2>
          {mode === 'list' && <div style={{ display: 'flex', gap: 6 }} role="tablist" aria-label="고객 목록 구분">
            {([['active', `활성 고객 ${data ? data.counts.active.toLocaleString() : ''}`], ['excluded', `삭제된 고객 ${data ? data.counts.excluded.toLocaleString() : ''}`]] as const).map(([v, label]) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} aria-label={label} data-testid={`customer-view-${v}`}
                onClick={() => switchView(v)}
                style={{ padding: '6px 12px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
                  border: `1px solid ${view === v ? '#2563eb' : '#d1d5db'}`, background: view === v ? '#eff6ff' : '#fff', color: view === v ? '#1d4ed8' : '#374151' }}>
                {label}
              </button>
            ))}
          </div>}
        </div>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: '#6b7280' }}>
          거래처관리의 고객사(유형: 고객사)를 표시합니다. 외주업체는 제외되며, 고객사 등록·정보 수정은 거래처관리에서 합니다.
          {mode === 'list'
            ? '신규 매출은 판매관리 기준이며, 과거 CRM 매출은 별도로 표시합니다. 미수금은 수금관리에서 확인된 금액만 표시하며, 청구정보가 없는 경우 미수금이 없다는 의미는 아닙니다.'
            : '순위 매출은 부가세 제외 공급가액(신규 판매전환 건 + 과거 CRM 판매, 같은 판매는 1회만)이며 수금·미수금과 별개입니다.'}
        </p>

        {/* 메인 탭: 고객 목록 / 고객 순위 */}
        <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid #e5e7eb', marginBottom: 14 }} role="tablist" aria-label="고객관리 화면">
          {([['list', '고객 목록'], ['ranking', '고객 순위']] as const).map(([m, label]) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} aria-label={label} data-testid={`customer-mode-${m}`} onClick={() => setMode(m)}
              style={{ padding: '8px 16px', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', background: 'transparent', border: 'none',
                borderBottom: `2px solid ${mode === m ? '#2563eb' : 'transparent'}`, color: mode === m ? '#1d4ed8' : '#6b7280', marginBottom: -1 }}>
              {label}
            </button>
          ))}
        </div>

        {mode === 'ranking' && <CustomerRankingView token={token} onToast={onToast} onOpenCustomer={(id) => setDetailId(id)} />}

        {mode === 'list' && <>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()}
            placeholder="고객사명, 대표자, 담당자, 사업자번호, 연락처, 이메일 검색..." aria-label="고객 검색" data-testid="customer-search-input"
            style={{ ...inputStyle, maxWidth: 360, flex: '1 1 220px' }} />
          <PrimaryBtn onClick={runSearch} disabled={loading} style={{ padding: '8px 16px', fontSize: 13 }} data-testid="customer-search-btn" aria-label="고객 검색 실행">
            {loading ? '검색 중...' : '검색'}
          </PrimaryBtn>
          {applied && (
            <GhostBtn onClick={() => { setSearch(''); setApplied(''); setPage(1); }} style={{ padding: '8px 12px', fontSize: 13 }} data-testid="customer-search-reset" aria-label="검색 초기화">초기화</GhostBtn>
          )}
        </div>

        {selectable && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10, padding: '9px 12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, ...stickyBulkBarStyle }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#374151', cursor: 'pointer', fontWeight: 600 }}>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={!rows.length}
                aria-label="현재 페이지 전체 선택" data-testid="customer-select-all"
                style={{ width: 15, height: 15, cursor: 'pointer' }} />
              현재 페이지 전체선택
            </label>
            <span data-testid="customer-selected-count" style={{ fontSize: 13, fontWeight: 700, color: selectedCount > 0 ? '#2563eb' : '#9ca3af' }}>
              선택 {selectedCount}건
            </span>
            <div style={{ flex: 1 }} />
            <button type="button" onClick={deleteSelected} disabled={!canDelete}
              aria-label="선택한 고객 삭제" data-testid="customer-bulk-delete"
              style={bulkBtnStyle(canDelete, '#dc2626', '#fef2f2', '#fecaca', { padding: '6px 14px' })}>
              {bulkBusy ? '삭제 중...' : '선택 삭제'}
            </button>
          </div>
        )}

        {loading && !data ? (
          <div style={{ textAlign: 'center', padding: '32px 0', color: '#9ca3af', fontSize: 14 }}>불러오는 중...</div>
        ) : rows.length === 0 ? (
          <Card style={{ textAlign: 'center', padding: 32, color: '#9ca3af', fontSize: 14 }}>
            {excludedView ? '삭제된 고객이 없습니다.' : applied ? '검색 결과가 없습니다.' : '표시할 고객사가 없습니다.'}
          </Card>
        ) : (
          <Card style={{ padding: 0, overflow: 'hidden', opacity: loading ? 0.6 : 1 }}>
            <div ref={tableBoxRef} style={{ overflowX: 'auto' }}>
              <table className="veritas-read-table" style={{ width: tableW, borderCollapse: 'collapse', tableLayout: 'fixed' }} data-testid="customer-table">
                <colgroup>
                  {selectable && <col style={{ width: CHECK_W }} />}
                  {colKeys.map((k) => <col key={k} style={{ width: colW[k] }} />)}
                </colgroup>
                <thead>
                  <tr>
                    {selectable && (
                      <th style={{ ...tableTh, textAlign: 'center', paddingLeft: 8, paddingRight: 8 }}>
                        <input type="checkbox" checked={allSelected} onChange={toggleAll}
                          aria-label="현재 페이지 전체 선택" data-testid="customer-select-all-header" style={{ width: 15, height: 15, cursor: 'pointer' }} />
                      </th>
                    )}
                    {colKeys.map((k) => (
                      <th key={k} style={cellStyle(k, tableTh)} data-col={k}>{COLS[k].label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => {
                    const phone = c.contact?.phone || c.phone;
                    return (
                      <tr key={c.id} onClick={() => setDetailId(c.id)} style={{ cursor: 'pointer', background: selectedIds.has(c.id) ? '#eff6ff' : undefined }} data-testid={`customer-row-${c.id}`}>
                        {selectable && (
                          /* 선택 체크박스 — 클릭은 선택만(행 상세 진입과 분리) */
                          <td style={{ ...tableTd, textAlign: 'center', paddingLeft: 8, paddingRight: 8 }} onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" checked={selectedIds.has(c.id)} onChange={() => toggleOne(c.id)}
                              aria-label={`고객 선택: ${c.name}`} data-testid={`customer-select-${c.id}`}
                              style={{ width: 15, height: 15, cursor: 'pointer' }} />
                          </td>
                        )}
                        <td style={cellStyle('name', tableTd)} data-col="name">
                          <div title={c.name} style={{ ...clip, fontWeight: 600, color: '#111827' }}>{c.name}</div>
                          <div style={{ ...sub, ...clip }}>#{c.id}{c.representativeName ? ` · 대표 ${c.representativeName}` : ''}{c.businessNumber ? ` · ${c.businessNumber}` : ''}</div>
                        </td>
                        <td style={cellStyle('contact', tableTd)} data-col="contact">
                          <div style={{ ...clip, fontSize: 12.5 }}>{c.contact?.name ?? <span style={{ color: '#9ca3af' }}>담당자 미등록</span>}</div>
                          <div style={{ ...sub, ...clip }}>{phone ? formatPhoneDisplay(phone) : '연락처 미등록'}</div>
                        </td>
                        <td style={{ ...cellStyle('grade', tableTd), whiteSpace: 'nowrap' }} data-col="grade">
                          <GradeBadge grade={c.grade} overridden={c.gradeOverridden} title={c.gradeOverridden ? `${c.gradeReason} (자동 ${c.autoGrade})` : c.gradeReason} />
                        </td>
                        <td style={{ ...cellStyle('projects', tableTd), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} data-col="projects">
                          <div style={{ fontSize: 12.5 }}>전체 {c.projects.total}건</div>
                          {c.projects.inProgress > 0 && <div style={{ fontSize: 11, color: '#7c3aed', fontWeight: 600 }}>진행 중 {c.projects.inProgress}건</div>}
                          {c.legacyRef && <div style={sub} title="과거 CRM 판매(참고용 · 신규 판매로 전환된 건 제외)">과거 CRM {c.legacyRef.count.toLocaleString()}건</div>}
                        </td>
                        <td style={{ ...cellStyle('sales', tableTd), whiteSpace: 'nowrap' }} data-col="sales">
                          <div title="판매관리 기준 판매금액(부가세 포함)">
                            <span style={amtLabel}>신규 매출</span>{' '}
                            <span style={{ fontWeight: 600, color: c.sales.total ? '#111827' : '#9ca3af' }}>{formatWon(c.sales.total)}</span>
                          </div>
                          {c.legacyRef && c.legacyRef.total > 0 && <div style={sub} title="과거 CRM 판매 총액(부가세 포함) — 신규 매출과 합산하지 않음">과거 CRM 매출 {formatWon(c.legacyRef.total)}</div>}
                        </td>
                        <td style={{ ...cellStyle('receivable', tableTd), whiteSpace: 'nowrap' }} data-col="receivable">
                          {c.collection
                            ? <><div title="수금관리 청구·입금 기준으로 확인된 미수금">
                                  <span style={amtLabel}>확인된 미수금</span>{' '}
                                  <span style={{ fontWeight: 600, color: c.collection.receivable > 0 ? '#dc2626' : '#16a34a' }}>{formatWon(c.collection.receivable)}</span>
                                </div>
                                <div style={sub}>청구 {formatWon(c.collection.billed)}</div></>
                            : <div style={{ color: '#9ca3af', fontSize: 12 }} title="수금관리에 청구정보가 없습니다. 미수금이 없다는 의미는 아닙니다.">청구정보 없음</div>}
                          {c.legacyRef && (c.legacyRef.noDeposit + c.legacyRef.needsReview) > 0 && (
                            <div style={sub} data-testid={`customer-legacy-unverified-${c.id}`}
                              title={`과거 CRM 판매 중 입금이 확인되지 않은 건(현재 미수금에 합산하지 않음) — 입금 기록 없음 ${c.legacyRef.noDeposit}건 · 입금 금액 확인 필요 ${c.legacyRef.needsReview}건 · 입금 확인 ${c.legacyRef.paidConfirmed}건`}>
                              과거 미수금 미확인 {(c.legacyRef.noDeposit + c.legacyRef.needsReview).toLocaleString()}건
                            </div>
                          )}
                        </td>
                        <td style={{ ...cellStyle('last', tableTd), whiteSpace: 'nowrap', fontSize: 12 }} data-col="last">
                          {c.lastTransaction ?? (c.legacyRef?.lastDate ? <span style={{ color: '#9ca3af' }} title="과거 CRM 최근 판매일(참고)">과거 {c.legacyRef.lastDate}</span> : <span style={{ color: '#9ca3af' }}>거래 없음</span>)}
                          {c.lastTransaction && c.lastPaidAt === c.lastTransaction && <div style={sub}>입금</div>}
                        </td>
                        {excludedView && <td style={{ ...cellStyle('excludedAt', tableTd), whiteSpace: 'nowrap', fontSize: 12, color: '#6b7280' }} data-col="excludedAt">{c.excludedAt ? String(c.excludedAt).slice(0, 10) : '-'}</td>}
                        {excludedView && (
                          <td style={{ ...cellStyle('action', tableTd), whiteSpace: 'nowrap' }} data-col="action" onClick={(e) => e.stopPropagation()}>
                            {isAdmin && (
                              <GhostBtn onClick={() => restore(c)} disabled={busyId === c.id} style={{ fontSize: 12, padding: '4px 10px' }}
                                data-testid={`customer-restore-${c.id}`} aria-label={`${c.name} 고객 복원`}>복원</GhostBtn>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
        {(data?.total ?? 0) > 0 && (
          <Pagination idPrefix="customer" page={page} pageSize={pageSize} total={data!.total} unit="곳" disabled={loading}
            onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }} />
        )}
        </>}
      </div>
    </>
  );
}
