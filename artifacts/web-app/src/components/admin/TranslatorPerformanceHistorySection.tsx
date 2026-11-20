// 통번역사 상세 → 수행이력 탭 — 과거 CRM(진행관리표) + 신규 플랫폼 수행이력 통합 조회(읽기전용).
//   · 데이터: GET /admin/performances/history-by-translator (Master 연결 기준 · 원본/금액 불변).
//   · 기본 정렬 최근 수행일 순. 날짜·거래처·상품 검색 · 페이지네이션 · Excel 다운로드.
//   · 원본에 없는 정보는 표시하지 않음(빈 값은 '-'). zebra(흰/연회색 교차)는 veritas-read-table 사용.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/constants';
import { Pagination } from '../ui/Paginator';
import { exportDataset, type ExcelColumn } from '../../lib/excelExport';
import { DateField } from './DatePickerShared';
import './readTableView.css';

type HistoryItem = {
  source: 'legacy' | 'current'; sourceKey: string; id: number; viaLinkedMaster?: boolean;
  workDate: string | null; client: string | null; contact: string | null;
  workType: string | null; language: string | null; product: string | null;
  content: string | null; filename: string | null; status: string | null;
};
type Summary = { total: number; legacyCount: number; currentCount: number; firstDate: string | null; lastDate: string | null };

const td: React.CSSProperties = { padding: '8px 12px', fontSize: 13, color: '#374151', whiteSpace: 'nowrap' };
const clamp2 = { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'normal', lineHeight: 1.35 } as React.CSSProperties;

// [연결 수정] — 과거 CRM 수행행을 다른 통번역사로 행 단위 재연결(동명이인 수행이력 분리). 관리자(정산정보 권한)만, 사유 필수.
//   POST /admin/legacy-progress-rows/:id/translator-link — 원본 행·지급·정산·판매 데이터는 변경하지 않고 이력 귀속만 바뀐다.
function RelinkModal({ row, fromTranslatorId, token, onClose, onDone }: { row: HistoryItem; fromTranslatorId: number; token: string; onClose: () => void; onDone: (msg: string) => void }) {
  const [q, setQ] = useState(''); const [results, setResults] = useState<any[]>([]); const [picked, setPicked] = useState<any | null>(null);
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const search = async () => {
    if (!q.trim()) return;
    const r = await fetch(api(`/api/admin/translators?search=${encodeURIComponent(q.trim())}&includeInactive=true&pageSize=20`), { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json().catch(() => []);
    setResults((Array.isArray(d) ? d : (d.items ?? [])).filter((t: any) => t.id !== fromTranslatorId));
  };
  const submit = async () => {
    if (!picked) { setErr('연결할 통번역사를 선택하세요.'); return; }
    if (!reason.trim()) { setErr('수정 사유를 입력하세요.'); return; }
    setBusy(true); setErr(null);
    try {
      const r = await fetch(api(`/api/admin/legacy-progress-rows/${row.id}/translator-link`), {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ translatorId: picked.id, reason: reason.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d.error ?? '연결 수정 실패'); return; }
      onDone(`수행이력(${row.workDate ?? '-'} ${row.client ?? ''})을 ${picked.name} 통번역사로 재연결했습니다.`);
    } finally { setBusy(false); }
  };
  const box: React.CSSProperties = { width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, boxSizing: 'border-box' };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 9500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onMouseDown={onClose}>
      <div role="dialog" aria-label="수행이력 연결 수정" data-testid="tph-relink-modal" onMouseDown={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 12, padding: 20, width: 520, maxWidth: '94vw', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>수행이력 연결 수정</div>
        <div style={{ fontSize: 12.5, color: '#374151', background: '#f9fafb', borderRadius: 8, padding: '8px 10px' }}>
          과거 CRM 원본 #{row.id} · {row.workDate ?? '-'} · {row.client ?? '-'} · {row.language ?? '-'} · {row.product ?? '-'}
          <div style={{ color: '#6b7280', marginTop: 3 }}>이 행만 선택한 통번역사로 옮깁니다. 원본·지급·정산·판매 데이터는 변경되지 않습니다.</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input style={box} placeholder="통번역사 이름·이메일 검색" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') search(); }} data-testid="tph-relink-search" aria-label="통번역사 검색" />
          <button type="button" onClick={search} data-testid="tph-relink-search-btn" style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>검색</button>
        </div>
        {results.length > 0 && (
          <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
            {results.map((t: any) => (
              <button key={t.id} type="button" onClick={() => setPicked(t)} data-testid={`tph-relink-pick-${t.id}`} aria-label={`${t.name} 선택`}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', border: 'none', borderBottom: '1px solid #f3f4f6', cursor: 'pointer', background: picked?.id === t.id ? '#eff6ff' : '#fff', fontSize: 13 }}>
                <b>{t.name}</b> <span style={{ color: '#6b7280' }}>#{t.id} · {t.languagePairs || '언어 미입력'} · {t.email || '-'}{t.isActive === false ? ' · 비활성' : ''}</span>
              </button>
            ))}
          </div>
        )}
        <textarea style={{ ...box, minHeight: 60 }} placeholder="수정 사유(필수) — 예: 2019 독일어 번역, 독일어 김주희 수행건 확인" value={reason} onChange={e => setReason(e.target.value)} data-testid="tph-relink-reason" aria-label="수정 사유" />
        {err && <div role="alert" data-testid="tph-relink-error" style={{ color: '#b91c1c', fontSize: 12.5, fontWeight: 600 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} data-testid="tph-relink-cancel" style={{ padding: '7px 14px', borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>취소</button>
          <button type="button" onClick={submit} disabled={busy} data-testid="tph-relink-confirm" style={{ padding: '7px 14px', borderRadius: 7, border: 'none', background: '#2563eb', color: '#fff', fontWeight: 700, cursor: busy ? 'default' : 'pointer' }}>{busy ? '처리 중…' : '연결 수정'}</button>
        </div>
      </div>
    </div>
  );
}

export function TranslatorPerformanceHistorySection({ translatorId, token, onToast, canRelink = false }: { translatorId: number; token: string; onToast: (m: string) => void; canRelink?: boolean }) {
  const [relinkRow, setRelinkRow] = useState<HistoryItem | null>(null);
  const authH = { Authorization: `Bearer ${token}` };
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [pg, setPg] = useState({ page: 1, pageSize: 50, total: 0, totalPages: 1 });
  const [dateFrom, setDateFrom] = useState(''); const [dateTo, setDateTo] = useState('');
  const [client, setClient] = useState(''); const [product, setProduct] = useState('');
  const [source, setSource] = useState('all'); // all | legacy | current
  const [applied, setApplied] = useState({ from: '', to: '', client: '', product: '', source: 'all' });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null); // 서버 오류와 '데이터 0건'을 구분(§8)
  const [linkInfo, setLinkInfo] = useState<{ count: number; basis: string | null } | null>(null); // 동일인 조회 링크 안내

  const buildParams = useCallback((page: number, pageSize: number, a: typeof applied) => {
    const p = new URLSearchParams();
    p.set('translatorId', String(translatorId)); p.set('page', String(page)); p.set('pageSize', String(pageSize));
    if (/^\d{4}-\d{2}-\d{2}$/.test(a.from)) p.set('dateFrom', a.from);
    if (/^\d{4}-\d{2}-\d{2}$/.test(a.to)) p.set('dateTo', a.to);
    if (a.client.trim()) p.set('client', a.client.trim());
    if (a.product.trim()) p.set('product', a.product.trim());
    if (a.source !== 'all') p.set('source', a.source);
    return p;
  }, [translatorId]);

  const load = useCallback(async (page = 1, a = applied) => {
    setLoading(true); setLoadError(null);
    try {
      const r = await fetch(api(`/api/admin/performances/history-by-translator?${buildParams(page, pg.pageSize, a)}`), { headers: authH });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error || `서버 응답 오류 (HTTP ${r.status})`);
      setItems(d.items); setSummary(d.summary); setPg(d.pagination); setLoadError(null);
      setLinkInfo(d.connection?.viaLinkedCount > 0 ? { count: d.connection.viaLinkedCount, basis: d.connection.samePersonBasis ?? null } : null);
    } catch (e: any) {
      // 서버/네트워크 오류 — 빈 목록을 '데이터 0건'으로 오인하지 않도록 오류 상태 유지(§8).
      setLoadError(e?.message || '수행이력 조회 실패 (서버 응답 없음)');
      onToast(e?.message || '수행이력 조회 실패');
    } finally { setLoading(false); }
  }, [token, pg.pageSize, buildParams, applied]);

  useEffect(() => { load(1, applied); /* 최초 1회 */ }, []); // eslint-disable-line

  const search = () => { const a = { from: dateFrom, to: dateTo, client, product, source }; setApplied(a); setTimeout(() => load(1, a), 0); };
  const reset = () => { setDateFrom(''); setDateTo(''); setClient(''); setProduct(''); setSource('all'); const a = { from: '', to: '', client: '', product: '', source: 'all' }; setApplied(a); setTimeout(() => load(1, a), 0); };

  // Excel — 현재 검색조건의 전체(페이지 순회 수집). 원본값 그대로.
  const exportExcel = async () => {
    try {
      const all: HistoryItem[] = []; let page = 1; const size = 1000;
      for (;;) {
        const r = await fetch(api(`/api/admin/performances/history-by-translator?${buildParams(page, size, applied)}`), { headers: authH });
        const d = await r.json(); if (!r.ok) throw new Error(d?.error || '조회 실패');
        all.push(...d.items);
        if (page >= (d.pagination?.totalPages ?? 1)) break; page++;
      }
      const columns: ExcelColumn<HistoryItem>[] = [
        { header: '수행일', value: r => r.workDate ?? '', type: 'date', width: 12 },
        { header: '출처', value: r => (r.source === 'legacy' ? '과거 CRM' : '신규 플랫폼'), width: 10 },
        { header: '거래처', value: r => r.client ?? '', width: 22 },
        { header: '고객 담당자', value: r => r.contact ?? '', width: 12 },
        { header: '통역·번역', value: r => r.workType ?? '', width: 10 },
        { header: '언어', value: r => r.language ?? '', width: 12 },
        { header: '상품/업무', value: r => r.product ?? '', width: 24 },
        { header: '상세내역', value: r => r.content ?? '', width: 20 },
        { header: '파일명', value: r => r.filename ?? '', width: 30 },
        { header: '수행상태', value: r => r.status ?? '', width: 12 },
      ];
      exportDataset({ filename: `수행이력_${translatorId}_${applied.from || '전체'}_${applied.to || ''}.xlsx`, sheetName: '수행이력', columns, rows: all });
      onToast(`수행이력 ${all.length}건 Excel을 다운로드했습니다.`);
    } catch (e: any) { onToast(e?.message || 'Excel 생성 실패'); }
  };

  const inp: React.CSSProperties = { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13 };
  const btn = (primary?: boolean): React.CSSProperties => ({ padding: '7px 14px', borderRadius: 8, fontWeight: 700, fontSize: 13, border: 'none', cursor: 'pointer', background: primary ? '#0ea5e9' : '#e5e7eb', color: primary ? '#fff' : '#374151' });
  const sumCard = (label: string, value: string, accent?: string): React.ReactNode => (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '8px 14px', background: '#fff', minWidth: 110 }}>
      <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 800, color: accent ?? '#111827', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );

  return (
    <div data-testid="translator-performance-history">
      {/* 상단 요약 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {sumCard('전체 수행건수', summary ? `${summary.total.toLocaleString()}건` : '-')}
        {sumCard('과거 CRM', summary ? `${summary.legacyCount.toLocaleString()}건` : '-', '#6d28d9')}
        {sumCard('신규 플랫폼', summary ? `${summary.currentCount.toLocaleString()}건` : '-', '#047857')}
        {sumCard('최초 수행일', summary?.firstDate ?? '-')}
        {sumCard('최근 수행일', summary?.lastDate ?? '-')}
      </div>

      {/* 검색조건 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <select style={inp} value={source} onChange={e => setSource(e.target.value)} aria-label="출처" data-testid="tph-source">
          <option value="all">전체</option><option value="legacy">과거 CRM</option><option value="current">신규 플랫폼</option>
        </select>
        <DateField style={{ ...inp, width: 148 }} value={dateFrom} max={dateTo || undefined} onChange={setDateFrom} testid="tph-from" ariaLabel="시작일" />
        <span style={{ color: '#9ca3af' }}>~</span>
        <DateField style={{ ...inp, width: 148 }} value={dateTo} min={dateFrom || undefined} onChange={setDateTo} testid="tph-to" ariaLabel="종료일" />
        <input style={{ ...inp, minWidth: 130 }} placeholder="거래처" value={client} onChange={e => setClient(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') search(); }} aria-label="거래처 검색" data-testid="tph-client" />
        <input style={{ ...inp, minWidth: 130 }} placeholder="상품/업무" value={product} onChange={e => setProduct(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') search(); }} aria-label="상품/업무 검색" data-testid="tph-product" />
        <button style={btn(true)} onClick={search} disabled={loading} data-testid="tph-search">{loading ? '조회 중…' : '조회'}</button>
        <button style={btn()} onClick={reset} data-testid="tph-reset">초기화</button>
        <button style={{ ...btn(), background: '#059669', color: '#fff' }} onClick={exportExcel} disabled={loading || (pg.total === 0)} data-testid="tph-excel">Excel 다운로드</button>
      </div>

      {/* 동일인 조회 링크 안내 — 대표 승인/병합기록 근거로 비활성 Master 과거이력을 조회 표시(물리 병합 아님) */}
      {linkInfo && (
        <div data-testid="tph-linkinfo" style={{ marginBottom: 10, padding: '9px 12px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, fontSize: 12.5, color: '#1d4ed8' }}>
          ℹ 동일인 확정 Master의 과거 CRM 수행이력 <b>{linkInfo.count.toLocaleString()}건</b>을 함께 표시합니다(조회 전용 · 물리 병합 아님{linkInfo.basis ? ` · 근거: ${linkInfo.basis}` : ''}).
        </div>
      )}

      {/* 서버/네트워크 오류 안내(§8) — '데이터 0건'과 명확히 구분 */}
      {loadError && (
        <div data-testid="tph-error" style={{ marginBottom: 10, padding: '9px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 12.5, color: '#b91c1c', fontWeight: 600 }}>
          ⚠ 수행이력을 불러오지 못했습니다(서버 응답 오류). 아래 빈 화면은 <b>실제 데이터 0건이 아닙니다</b>. 잠시 후 다시 [조회]해 주세요. ({loadError})
        </div>
      )}

      {/* 목록 — 최근 수행일 순 · zebra(veritas-read-table) */}
      <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 10 }}>
        <table className="veritas-read-table vz-sticky" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr>{['수행일', '출처', '거래처', '고객 담당자', '통역·번역', '언어', '상품/업무', '상세내역', '파일명', '수행상태', ...(canRelink ? ['연결'] : [])].map(h => <th key={h} style={{ padding: '9px 12px', textAlign: 'left', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
          <tbody>
            {items.map((r, i) => (
              <tr key={r.sourceKey} data-testid={`tph-row-${i}`} data-source={r.source}>
                <td style={td}>{r.workDate ?? <span style={{ color: '#b45309' }}>(수행일 미상)</span>}</td>
                <td style={td}><span style={{ fontSize: 11, fontWeight: 700, color: r.source === 'legacy' ? '#6d28d9' : '#047857', background: r.source === 'legacy' ? '#f5f3ff' : '#ecfdf5', padding: '1px 6px', borderRadius: 7 }}>{r.source === 'legacy' ? '과거 CRM' : '신규'}</span></td>
                <td style={{ ...td, whiteSpace: 'normal', maxWidth: 200 }} title={r.client ?? undefined}><div style={clamp2}>{r.client ?? '-'}</div></td>
                <td style={td}>{r.contact ?? '-'}</td>
                <td style={td}>{r.workType ?? '-'}</td>
                <td style={td}>{r.language ?? '-'}</td>
                <td style={{ ...td, whiteSpace: 'normal', maxWidth: 220 }} title={r.product ?? undefined}><div style={clamp2}>{r.product ?? '-'}</div></td>
                <td style={{ ...td, whiteSpace: 'normal', maxWidth: 180 }} title={r.content ?? undefined}><div style={clamp2}>{r.content ?? '-'}</div></td>
                <td style={{ ...td, whiteSpace: 'normal', maxWidth: 240 }} title={r.filename ?? undefined}><div style={clamp2}>{r.filename ?? '-'}</div></td>
                <td style={td}>{r.status ? <span style={{ fontSize: 11, fontWeight: 600, color: r.source === 'legacy' ? '#475569' : '#1d4ed8', background: r.source === 'legacy' ? '#f1f5f9' : '#eff6ff', padding: '1px 6px', borderRadius: 7 }}>{r.status}</span> : '-'}</td>
                {canRelink && <td style={td}>{r.source === 'legacy'
                  ? <button type="button" onClick={() => setRelinkRow(r)} data-testid={`tph-relink-${r.id}`} aria-label="연결 수정" title="이 과거 CRM 행을 다른 통번역사로 재연결(동명이인 분리)"
                      style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontWeight: 600 }}>연결 수정</button>
                  : '-'}</td>}
              </tr>
            ))}
            {items.length === 0 && !loading && <tr className="vz-summary"><td colSpan={canRelink ? 11 : 10} style={{ padding: 28, textAlign: 'center', color: '#9ca3af' }}>{loadError ? '조회 오류로 표시할 수 없습니다(데이터 0건 아님).' : '수행이력이 없습니다.'}</td></tr>}
          </tbody>
        </table>
      </div>
      {relinkRow && <RelinkModal row={relinkRow} fromTranslatorId={translatorId} token={token} onClose={() => setRelinkRow(null)}
        onDone={(m) => { setRelinkRow(null); onToast(m); load(pg.page); }} />}
      {pg.total > 0 && <Pagination idPrefix="tph" page={pg.page} pageSize={pg.pageSize} total={pg.total} unit="건" disabled={loading} onPageChange={(p) => load(p)} onPageSizeChange={(s) => { setPg(v => ({ ...v, pageSize: s })); setTimeout(() => load(1), 0); }} />}
    </div>
  );
}
