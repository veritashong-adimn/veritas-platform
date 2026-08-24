/**
 * UnifiedTrashTab — VERITAS OS 통합 휴지통 (1차)
 *
 * 5개 영역(견적서 · 거래처 · 담당자 · 상품 · 통번역사)의 개별 휴지통 데이터를
 * DB/API 변경 없이 프론트에서 모아 보여준다(집계 방식).
 *  · 견적서/거래처/담당자/상품: 기존 soft-delete(deletedAt) 휴지통 API 재사용
 *  · 통번역사: deletedAt 컬럼이 없으므로 isActive=false 세트를 휴지통으로 재사용
 *  · 복원/완전삭제는 각 영역의 기존 엔드포인트·권한·확인 절차를 그대로 위임한다(서버 재검증).
 *
 * 개별 휴지통(견적/상품 사이드바, 거래처/담당자 토글)은 병행 유지한다. 안정화 후 별도 단계에서 정리.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/constants';
import { formatDocNumber } from '../../lib/quoteTitle';
import {
  useBulkSelection, useClientPagination, BulkSelectBar, bulkActionBtn, Pagination, trashRowStyle,
} from './bulkListShared';

/** 통합 대상 영역 키 */
type TrashDomain = 'quote' | 'company' | 'contact' | 'product' | 'translator';

/** 각 영역 원본 행을 공통 형태로 정규화한 항목 */
interface TrashItem {
  domain: TrashDomain;
  id: number;
  title: string;                 // 이름/제목
  subtitle: string | null;       // 보조 식별정보(견적번호·거래처·이메일 등)
  deletedAt: string | null;      // 삭제일 (통번역사는 없음 → null)
  deletedByName: string | null;  // 삭제자 (통번역사는 없음 → null)
  deletionReason: string | null; // 삭제사유 (상품/통번역사는 없음 → null)
  raw: any;                       // 완전삭제 확인 모달 표시용 원본
}

interface DomainMeta {
  key: TrashDomain;
  /** 유형 배지 라벨 */
  typeLabel: string;
  /** 원래 영역(사이드바 위치) */
  areaLabel: string;
  /** 유형 배지 색상 */
  badge: { bg: string; color: string; border: string };
  /** 휴지통 목록 조회 */
  fetchList: (authH: Record<string, string>) => Promise<any[]>;
  /** 원본 → 공통 항목 */
  normalize: (raw: any) => TrashItem;
  /** 복원 요청 (reason: 선택 입력 → 서버가 logs.metadata.restoreReason 에 기록) */
  restore: (id: number, authH: Record<string, string>, reason?: string) => Promise<Response>;
  /** 완전삭제 요청 (reason: 선택 입력 → 서버가 logs.metadata.purgeReason 에 기록) */
  purge: (id: number, authH: Record<string, string>, reason?: string) => Promise<Response>;
  /** 완전삭제 실패(409) 시 사유 문자열 (연결 데이터 안내) */
  purgeDetail?: (data: any) => string;
}

const DASH = '—';
const s = (v: any): string | null => (v === undefined || v === null || v === '' ? null : String(v));

/** 복원/완전삭제 공통 요청 — 사유(선택)를 JSON body로 전달. 서버가 logs.metadata에 기록한다. */
const trashFetch = (path: string, method: string, authH: Record<string, string>, reason?: string): Promise<Response> =>
  fetch(api(path), {
    method,
    headers: { ...authH, 'Content-Type': 'application/json' },
    body: JSON.stringify(reason && reason.trim() ? { reason: reason.trim() } : {}),
  });

/** 영역별 어댑터 — 기존 개별 휴지통과 동일한 엔드포인트/응답 필드를 사용한다. */
const DOMAINS: Record<TrashDomain, DomainMeta> = {
  quote: {
    key: 'quote',
    typeLabel: '견적서',
    areaLabel: '영업관리 · 견적',
    badge: { bg: '#eff6ff', color: '#2563eb', border: '#bfdbfe' },
    fetchList: async (authH) => {
      const res = await fetch(api('/api/admin/quotes-trash'), { headers: authH });
      const data = await res.json().catch(() => []);
      if (!res.ok) throw new Error(data?.error ?? String(res.status));
      return Array.isArray(data) ? data : [];
    },
    normalize: (r) => {
      const doc = formatDocNumber('Q', r.quoteNumber, r.issueDate) || `#${r.id}`;
      return {
        domain: 'quote', id: r.id,
        title: s(r.title) ?? '(제목 미입력)',
        subtitle: [doc, s(r.companyName)].filter(Boolean).join(' · '),
        deletedAt: s(r.deletedAt), deletedByName: s(r.deletedByName), deletionReason: s(r.deletionReason),
        raw: r,
      };
    },
    restore: (id, authH, reason) => trashFetch(`/api/admin/quotes/${id}/restore`, 'POST', authH, reason),
    purge: (id, authH, reason) => trashFetch(`/api/admin/quotes/${id}/permanent`, 'DELETE', authH, reason),
  },
  company: {
    key: 'company',
    typeLabel: '거래처',
    areaLabel: '고객·거래처 · 거래처',
    badge: { bg: '#f5f3ff', color: '#7c3aed', border: '#ddd6fe' },
    fetchList: async (authH) => {
      const res = await fetch(api('/api/admin/companies-trash'), { headers: authH });
      const data = await res.json().catch(() => []);
      if (!res.ok) throw new Error(data?.error ?? String(res.status));
      return Array.isArray(data) ? data : [];
    },
    normalize: (r) => ({
      domain: 'company', id: r.id,
      title: s(r.name) ?? DASH,
      subtitle: r.companyType === 'vendor' ? '외주업체' : '고객사',
      deletedAt: s(r.deletedAt), deletedByName: s(r.deletedByName), deletionReason: s(r.deletionReason),
      raw: r,
    }),
    restore: (id, authH, reason) => trashFetch(`/api/admin/companies/${id}/restore`, 'POST', authH, reason),
    purge: (id, authH, reason) => trashFetch(`/api/admin/companies/${id}/permanent`, 'DELETE', authH, reason),
    purgeDetail: (data) => (Array.isArray(data?.reasons) && data.reasons.length
      ? ` (${data.reasons.map((x: { label: string; count: number }) => `${x.label} ${x.count}`).join(', ')})`
      : ''),
  },
  contact: {
    key: 'contact',
    typeLabel: '담당자',
    areaLabel: '고객·거래처 · 담당자',
    badge: { bg: '#ecfeff', color: '#0891b2', border: '#a5f3fc' },
    fetchList: async (authH) => {
      const res = await fetch(api('/api/admin/contacts-trash'), { headers: authH });
      const data = await res.json().catch(() => []);
      if (!res.ok) throw new Error(data?.error ?? String(res.status));
      return Array.isArray(data) ? data : [];
    },
    normalize: (r) => ({
      domain: 'contact', id: r.id,
      title: s(r.name) ?? DASH,
      subtitle: [s(r.companyName), [s(r.department), s(r.position)].filter(Boolean).join('/')].filter(Boolean).join(' · ') || null,
      deletedAt: s(r.deletedAt), deletedByName: s(r.deletedByName), deletionReason: s(r.deletionReason),
      raw: r,
    }),
    restore: (id, authH, reason) => trashFetch(`/api/admin/contacts/${id}/restore`, 'POST', authH, reason),
    purge: (id, authH, reason) => trashFetch(`/api/admin/contacts/${id}/permanent`, 'DELETE', authH, reason),
    purgeDetail: (data) => (typeof data?.count === 'number' && data.count > 0 ? ` (프로젝트 ${data.count})` : ''),
  },
  product: {
    key: 'product',
    typeLabel: '상품',
    areaLabel: '리소스 · 상품',
    badge: { bg: '#fffbeb', color: '#b45309', border: '#fde68a' },
    fetchList: async (authH) => {
      const res = await fetch(api('/api/admin/products/trash'), { headers: authH });
      const data = await res.json().catch(() => []);
      if (!res.ok) throw new Error(data?.error ?? String(res.status));
      return Array.isArray(data) ? data : [];
    },
    // 상품 휴지통은 deletionReason 컬럼이 없다 → 삭제사유는 '-'로 표시된다.
    normalize: (r) => ({
      domain: 'product', id: r.id,
      title: s(r.name) ?? DASH,
      subtitle: s(r.code),
      deletedAt: s(r.deletedAt),
      deletedByName: s(r.deletedByName) ?? s(r.deletedByEmail),
      deletionReason: null,
      raw: r,
    }),
    restore: (id, authH, reason) => trashFetch(`/api/admin/products/${id}/restore`, 'POST', authH, reason),
    // 상품은 완전삭제 엔드포인트가 /permanent 가 아니라 /purge → 프론트에서 흡수.
    purge: (id, authH, reason) => trashFetch(`/api/admin/products/${id}/purge`, 'DELETE', authH, reason),
    purgeDetail: (data) => (s(data?.reason) ? ` (${data.reason})` : ''),
  },
  translator: {
    key: 'translator',
    typeLabel: '통번역사',
    areaLabel: '리소스 · 통번역사',
    badge: { bg: '#ecfdf5', color: '#059669', border: '#a7f3d0' },
    // 통번역사는 deletedAt 소프트삭제가 없다 → isActive=false(비활성) 세트를 휴지통으로 재사용.
    fetchList: async (authH) => {
      const res = await fetch(api('/api/admin/translators?includeInactive=true'), { headers: authH });
      const data = await res.json().catch(() => []);
      if (!res.ok) throw new Error(data?.error ?? String(res.status));
      const list = Array.isArray(data) ? data : (data?.rows ?? []);
      return list.filter((r: any) => r.isActive === false);
    },
    // 삭제일/삭제자/삭제사유 컬럼이 없다 → 모두 '-'로 표시된다.
    normalize: (r) => ({
      domain: 'translator', id: r.id,
      title: s(r.name) ?? s(r.email) ?? DASH,
      subtitle: [s(r.email), s(r.languagePairs)].filter(Boolean).join(' · ') || null,
      deletedAt: null, deletedByName: null, deletionReason: null,
      raw: r,
    }),
    // 통번역사 복원은 기존 activate 기능 사용(PATCH). 사유는 activate 감사로그의 metadata.restoreReason 에 기록.
    restore: (id, authH, reason) => trashFetch(`/api/admin/translators/${id}/activate`, 'PATCH', authH, reason),
    purge: (id, authH, reason) => trashFetch(`/api/admin/translators/${id}/permanent`, 'DELETE', authH, reason),
    purgeDetail: (data) => (typeof data?.count === 'number' && data.count > 0 ? ` (연결 이력 ${data.count})` : ''),
  },
};

const TAB_ORDER: (TrashDomain | 'all')[] = ['all', 'quote', 'company', 'contact', 'product', 'translator'];
const TAB_LABEL: Record<TrashDomain | 'all', string> = {
  all: '전체', quote: '견적서', company: '거래처', contact: '담당자', product: '상품', translator: '통번역사',
};

const th: React.CSSProperties = { padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 12, color: '#374151', whiteSpace: 'nowrap', verticalAlign: 'top' };

/** 삭제일 최신순 정렬(삭제일 없는 통번역사는 뒤로). */
function byDeletedAtDesc(a: TrashItem, b: TrashItem): number {
  const ta = a.deletedAt ? new Date(a.deletedAt).getTime() : -Infinity;
  const tb = b.deletedAt ? new Date(b.deletedAt).getTime() : -Infinity;
  return tb - ta;
}

/** 선택/복원/삭제용 전역 유니크 키(전체 탭에서 유형이 달라도 id 충돌 방지). */
const keyOf = (it: TrashItem) => `${it.domain}:${it.id}`;

export function UnifiedTrashTab({ token, isAdmin, onToast }: {
  token: string; isAdmin: boolean; onToast: (m: string) => void;
}) {
  const authH = { Authorization: `Bearer ${token}` };
  const [tab, setTab] = useState<TrashDomain | 'all'>('all');
  const [search, setSearch] = useState('');
  const [data, setData] = useState<Record<TrashDomain, TrashItem[]>>({ quote: [], company: [], contact: [], product: [], translator: [] });
  const [errored, setErrored] = useState<TrashDomain[]>([]);
  const [loading, setLoading] = useState(false);
  const [bulkBusy, setBulkBusy] = useState<'restore' | 'purge' | null>(null);
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const [restoreReason, setRestoreReason] = useState('');
  const [purgeConfirmOpen, setPurgeConfirmOpen] = useState(false);
  const [purgeReason, setPurgeReason] = useState('');
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const sel = useBulkSelection<string>();

  /** 5개 영역 병렬 로드. */
  const loadAll = useCallback(async () => {
    setLoading(true);
    setErrored([]);
    const keys = Object.keys(DOMAINS) as TrashDomain[];
    const results = await Promise.allSettled(keys.map(k => DOMAINS[k].fetchList(authH)));
    const next: Record<TrashDomain, TrashItem[]> = { quote: [], company: [], contact: [], product: [], translator: [] };
    const failed: TrashDomain[] = [];
    results.forEach((res, i) => {
      const k = keys[i];
      if (res.status === 'fulfilled') next[k] = res.value.map(DOMAINS[k].normalize);
      else failed.push(k);
    });
    setData(next);
    setErrored(failed);
    // 목록에서 사라진 항목(복원/완전삭제 후 등)을 선택에서 제거.
    sel.pruneTo(Object.values(next).flat().map(keyOf));
    setLoading(false);
    if (failed.length) onToast(`일부 영역 조회 실패: ${failed.map(f => TAB_LABEL[f]).join(', ')}`);
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadAll(); }, [loadAll]);

  const counts = Object.fromEntries((Object.keys(DOMAINS) as TrashDomain[]).map(k => [k, data[k].length])) as Record<TrashDomain, number>;
  const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);

  // 현재 탭 대상 항목(전체 = 5개 병합 + 삭제일 최신순).
  const base: TrashItem[] = tab === 'all'
    ? ([] as TrashItem[]).concat(...(Object.keys(DOMAINS) as TrashDomain[]).map(k => data[k])).sort(byDeletedAtDesc)
    : data[tab];

  const filtered = base.filter(it => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return [it.title, it.subtitle, it.deletedByName, it.deletionReason, DOMAINS[it.domain].typeLabel]
      .some(v => (v ?? '').toLowerCase().includes(q));
  });

  // 클라이언트 페이지네이션(현재 탭의 필터 결과 기준). 서버 API 변경 불필요.
  const { paged, page, setPage, pageSize, setPageSize, total, totalPages, rangeStart, rangeEnd } =
    useClientPagination(filtered, 20);
  const pageKeys = paged.map(keyOf);
  const allSelected = sel.allSelected(pageKeys);

  // 검색·탭 변경 시 1페이지로 초기화.
  useEffect(() => { setPage(1); }, [tab, search]); // eslint-disable-line react-hooks/exhaustive-deps

  // 선택 키 → 항목 조회(전체 탭 혼합 선택 포함, 다른 페이지·탭의 선택도 해석).
  const itemByKey = new Map<string, TrashItem>(
    (Object.keys(DOMAINS) as TrashDomain[]).flatMap(k => data[k]).map(it => [keyOf(it), it]),
  );
  const selectedItems = (): TrashItem[] =>
    Array.from(sel.selectedIds).map(k => itemByKey.get(k)).filter(Boolean) as TrashItem[];
  const selectedCount = sel.selectedCount;

  // ── 선택 복원 — 유형별 기존 restore/activate API를 병렬 호출. 사유(선택)를 함께 전달 ──
  const handleBulkRestore = async () => {
    const items = selectedItems();
    if (items.length === 0) return;
    const reason = restoreReason;
    setBulkBusy('restore');
    try {
      const results = await Promise.allSettled(
        items.map(it => DOMAINS[it.domain].restore(it.id, authH, reason).then(r => r.ok).catch(() => false)));
      const ok = results.filter(r => r.status === 'fulfilled' && r.value).length;
      onToast(`${ok}건을 복원했습니다.${ok < items.length ? ` (${items.length - ok}건 실패)` : ''}`);
      setRestoreConfirmOpen(false);
      setRestoreReason('');
      sel.clear();
      await loadAll();
    } finally { setBulkBusy(null); }
  };

  // ── 선택 완전삭제 — 유형별 기존 permanent/purge API를 병렬 호출(권한·FK 안전장치는 서버가 재검증). 사유(선택)를 함께 전달 ──
  const handleBulkPurge = async () => {
    const items = selectedItems();
    if (items.length === 0) return;
    const reason = purgeReason;
    setBulkBusy('purge');
    try {
      const results = await Promise.allSettled(
        items.map(it => DOMAINS[it.domain].purge(it.id, authH, reason).then(r => r.ok).catch(() => false)));
      const ok = results.filter(r => r.status === 'fulfilled' && r.value).length;
      onToast(`${ok}건을 완전삭제했습니다.${ok < items.length ? ` (${items.length - ok}건 실패 — 연결 데이터/권한)` : ''}`);
      setPurgeConfirmOpen(false);
      setPurgeReason('');
      sel.clear();
      await loadAll();
    } finally { setBulkBusy(null); }
  };

  return (
    <div data-testid="unified-trash-tab">
      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 800, color: '#111827', margin: 0 }}>통합 휴지통</h1>
          <p style={{ fontSize: 12, color: '#9ca3af', margin: '4px 0 0' }}>
            {loading ? '불러오는 중…' : `전체 ${totalCount}건 · 견적서 ${counts.quote} · 거래처 ${counts.company} · 담당자 ${counts.contact} · 상품 ${counts.product} · 통번역사 ${counts.translator}`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="이름 · 삭제자 · 삭제사유 · 유형 검색"
            data-testid="input-unified-trash-search"
            style={{ width: 280, maxWidth: '100%', padding: '8px 12px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 8, outline: 'none' }} />
          <button type="button" onClick={loadAll} disabled={loading} data-testid="btn-unified-trash-refresh"
            aria-label="새로고침"
            style={{ padding: '8px 14px', fontSize: 13, fontWeight: 600, borderRadius: 8, border: '1px solid #d1d5db', background: '#f9fafb', color: '#374151', cursor: loading ? 'default' : 'pointer' }}>
            {loading ? '…' : '새로고침'}
          </button>
        </div>
      </div>

      {/* 탭 [전체][견적서][거래처][담당자][상품][통번역사] */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 14, flexWrap: 'wrap', borderBottom: '1px solid #e5e7eb' }} role="tablist">
        {TAB_ORDER.map(t => {
          const active = tab === t;
          const cnt = t === 'all' ? totalCount : counts[t];
          return (
            <button key={t} type="button" role="tab" aria-selected={active} onClick={() => setTab(t)}
              data-testid={`unified-trash-tab-${t}`}
              style={{
                padding: '8px 16px', fontSize: 13, fontWeight: 700, border: 'none', background: 'transparent', cursor: 'pointer',
                color: active ? '#111827' : '#9ca3af', borderBottom: active ? '2px solid #111827' : '2px solid transparent', marginBottom: -1,
              }}>
              {TAB_LABEL[t]} <span style={{ fontSize: 11, color: active ? '#6b7280' : '#cbd5e1' }}>{cnt}</span>
            </button>
          );
        })}
      </div>

      {errored.length > 0 && (
        <div style={{ marginBottom: 12, padding: '8px 12px', fontSize: 12, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8 }}>
          일부 영역을 불러오지 못했습니다: {errored.map(e => TAB_LABEL[e]).join(', ')}. [새로고침]으로 다시 시도하세요.
        </div>
      )}

      {/* 선택 상태 바 — 현재 페이지 전체선택 + 선택 n건 / 우측: 선택 복원 · 선택 완전삭제 */}
      <BulkSelectBar
        allSelected={allSelected}
        onToggleAll={() => sel.togglePage(pageKeys)}
        selectedCount={selectedCount}>
        <button
          onClick={() => { setRestoreReason(''); setRestoreConfirmOpen(true); }}
          disabled={selectedCount < 1 || bulkBusy !== null}
          data-testid="bulk-restore"
          style={bulkActionBtn(selectedCount >= 1 && bulkBusy === null, '#059669', '#ecfdf5', '#a7f3d0')}>
          {bulkBusy === 'restore' ? '복원 중…' : '선택 복원'}
        </button>
        {isAdmin && (
          <button
            onClick={() => { setPurgeReason(''); setPurgeConfirmOpen(true); }}
            disabled={selectedCount < 1 || bulkBusy !== null}
            data-testid="bulk-purge"
            style={bulkActionBtn(selectedCount >= 1 && bulkBusy === null, '#dc2626', '#fef2f2', '#fecaca')}>
            선택 완전삭제
          </button>
        )}
      </BulkSelectBar>

      {/* 목록 */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th style={{ ...th, width: 44 }}>
                <input type="checkbox" checked={allSelected} onChange={() => sel.togglePage(pageKeys)}
                  aria-label="현재 페이지 전체 선택" data-testid="select-all-head"
                  style={{ width: 16, height: 16, cursor: 'pointer' }} />
              </th>
              {['유형', '이름/제목', '삭제일', '삭제자', '삭제사유', '원래 영역'].map(h => <th key={h} style={th}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {paged.length === 0 ? (
              <tr><td colSpan={7} style={{ ...td, textAlign: 'center', color: '#9ca3af', padding: '32px 8px' }}>
                {loading ? '불러오는 중…' : (search ? '검색 결과가 없습니다.' : '휴지통이 비어 있습니다.')}
              </td></tr>
            ) : paged.map(it => {
              const meta = DOMAINS[it.domain];
              const bk = keyOf(it);
              const selected = sel.isSelected(bk);
              return (
                <tr key={bk}
                  onClick={() => sel.toggle(bk)}
                  onMouseEnter={() => setHoveredKey(bk)}
                  onMouseLeave={() => setHoveredKey(prev => (prev === bk ? null : prev))}
                  style={{ borderBottom: '1px solid #f1f5f9', cursor: 'pointer', ...trashRowStyle(selected, hoveredKey === bk) }}
                  data-testid={`unified-trash-row-${it.domain}-${it.id}`}>
                  <td style={td} onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={selected} onChange={() => sel.toggle(bk)}
                      aria-label={`${it.title} 선택`} data-testid={`select-${it.domain}-${it.id}`}
                      style={{ width: 16, height: 16, cursor: 'pointer' }} />
                  </td>
                  <td style={td}>
                    <span style={{ display: 'inline-block', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 5, background: meta.badge.bg, color: meta.badge.color, border: `1px solid ${meta.badge.border}` }}>
                      {meta.typeLabel}
                    </span>
                  </td>
                  <td style={{ ...td, maxWidth: 300 }}>
                    <div style={{ color: '#111827', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.title}</div>
                    {it.subtitle && <div style={{ color: '#9ca3af', fontSize: 11, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.subtitle}</div>}
                  </td>
                  <td style={td}>{it.deletedAt ? new Date(it.deletedAt).toLocaleDateString('ko-KR') : DASH}</td>
                  <td style={td}>{it.deletedByName ?? DASH}</td>
                  <td style={{ ...td, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', color: '#6b7280' }} title={it.deletionReason ?? ''}>{it.deletionReason ?? DASH}</td>
                  <td style={{ ...td, color: '#6b7280' }}>{meta.areaLabel}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Pagination total={total} totalPages={totalPages} page={page} pageSize={pageSize}
        rangeStart={rangeStart} rangeEnd={rangeEnd} setPage={setPage} setPageSize={setPageSize} />

      <p style={{ marginTop: 12, fontSize: 11, color: '#9ca3af' }}>
        ※ 통합 휴지통은 각 영역의 기존 휴지통 데이터를 모아 보여줍니다. 데이터가 없는 항목은 '-'로 표시됩니다.
        체크박스로 선택 후 상단의 [선택 복원]/[선택 완전삭제]로 처리하며, 각 영역의 기존 규칙·권한을 그대로 따릅니다.
        완전삭제는 관리자만 실행할 수 있고 연결 데이터가 있으면 서버가 차단합니다.
        통번역사 휴지통은 비활성(isActive=false) 세트이며 삭제일·삭제자·삭제사유가 없습니다.
      </p>

      {/* 선택 복원 사유 입력 팝업 (사유 선택 입력) */}
      {restoreConfirmOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => { if (bulkBusy !== 'restore') setRestoreConfirmOpen(false); }}>
          <div onClick={e => e.stopPropagation()} data-testid="modal-unified-restore"
            style={{ background: '#fff', borderRadius: 14, padding: '24px 28px', width: 440, maxWidth: '92vw', boxShadow: '0 20px 60px rgba(0,0,0,0.25)', borderTop: '4px solid #2563eb' }}>
            <h2 style={{ margin: '0 0 8px', fontSize: 17, fontWeight: 800, color: '#111827' }}>선택한 {selectedCount}건을 복원하시겠습니까?</h2>
            <p style={{ margin: '0 0 12px', fontSize: 13, color: '#6b7280', lineHeight: 1.6 }}>
              각 항목이 원래 영역의 목록으로 되돌아갑니다. 연결 데이터는 유지됩니다.
            </p>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>복원 사유 <span style={{ color: '#9ca3af', fontWeight: 400 }}>(선택)</span></label>
            <textarea value={restoreReason} onChange={e => setRestoreReason(e.target.value)}
              placeholder="복원 사유를 입력하면 감사로그에 함께 기록됩니다. (선택)"
              data-testid="input-restore-reason" rows={3} disabled={bulkBusy === 'restore'}
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 8, outline: 'none', resize: 'vertical', marginBottom: 16 }} />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setRestoreConfirmOpen(false)} disabled={bulkBusy === 'restore'} data-testid="btn-unified-restore-cancel"
                style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #d1d5db', background: '#f9fafb', fontSize: 13, fontWeight: 600, cursor: bulkBusy === 'restore' ? 'not-allowed' : 'pointer', color: '#374151' }}>
                취소
              </button>
              <button onClick={handleBulkRestore} disabled={bulkBusy === 'restore'} data-testid="btn-unified-restore-confirm"
                style={{ padding: '9px 20px', borderRadius: 8, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, background: bulkBusy === 'restore' ? '#93c5fd' : '#2563eb', cursor: bulkBusy === 'restore' ? 'not-allowed' : 'pointer' }}>
                {bulkBusy === 'restore' ? '복원 중…' : '복원'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 선택 완전삭제 재확인 모달 (관리자 전용) */}
      {purgeConfirmOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => { if (bulkBusy !== 'purge') setPurgeConfirmOpen(false); }}>
          <div onClick={e => e.stopPropagation()} data-testid="modal-unified-purge"
            style={{ background: '#fff', borderRadius: 14, padding: '26px 30px', width: 460, maxWidth: '92vw', boxShadow: '0 20px 60px rgba(0,0,0,0.25)', borderTop: '4px solid #dc2626' }}>
            <h2 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 800, color: '#dc2626' }}>선택한 {selectedCount}건을 완전삭제하시겠습니까?</h2>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: '#374151', lineHeight: 1.6 }}>
              완전삭제된 데이터는 <strong style={{ color: '#dc2626' }}>복구할 수 없습니다.</strong><br />
              각 유형의 기존 규칙에 따라 처리되며, 연결된 업무 데이터가 존재하면 해당 항목은 서버가 차단합니다.
            </p>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>완전삭제 사유 <span style={{ color: '#9ca3af', fontWeight: 400 }}>(선택)</span></label>
            <textarea value={purgeReason} onChange={e => setPurgeReason(e.target.value)}
              placeholder="완전삭제 사유를 입력하면 감사로그에 함께 기록됩니다. (선택)"
              data-testid="input-purge-reason" rows={3} disabled={bulkBusy === 'purge'}
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 8, outline: 'none', resize: 'vertical', marginBottom: 16 }} />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setPurgeConfirmOpen(false)} disabled={bulkBusy === 'purge'} data-testid="btn-unified-purge-cancel"
                style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #d1d5db', background: '#f9fafb', fontSize: 13, fontWeight: 600, cursor: bulkBusy === 'purge' ? 'not-allowed' : 'pointer', color: '#374151' }}>
                취소
              </button>
              <button onClick={handleBulkPurge} disabled={bulkBusy === 'purge'} data-testid="btn-unified-purge-confirm"
                style={{ padding: '9px 20px', borderRadius: 8, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, background: bulkBusy === 'purge' ? '#fca5a5' : '#dc2626', cursor: bulkBusy === 'purge' ? 'not-allowed' : 'pointer' }}>
                {bulkBusy === 'purge' ? '삭제 중…' : '완전삭제'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default UnifiedTrashTab;
