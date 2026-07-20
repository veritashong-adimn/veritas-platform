/**
 * QuoteTrashTab — 견적 휴지통 페이지
 *
 * soft-delete(휴지통 이동)된 견적만 조회한다. 복원(PM·관리자) / 영구삭제(관리자 전용)를 제공한다.
 * 30일 보관기간은 표시 기준일 뿐 자동삭제하지 않는다(경과해도 데이터 유지). 서버가 권한을 재검증한다.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/constants';
import { formatDocNumber } from '../../lib/quoteTitle';
import { PageHeader } from './PageHeader';
import { dsStickyPageHeader } from '../../lib/ds';

interface TrashRow {
  id: number;
  quoteNumber: string | null;
  title: string | null;
  price: number;
  status: string;
  issueDate: string | null;
  deletedAt: string | null;
  deletionReason: string | null;
  deletedByName: string | null;
  companyName: string | null;
}

const RETENTION_DAYS = 30;

/** 삭제일 + 30일 기준 보관 상태(표시 전용, 자동삭제 아님) */
function retentionLabel(deletedAt: string | null): { text: string; expired: boolean } {
  if (!deletedAt) return { text: '—', expired: false };
  const remain = Math.floor((new Date(deletedAt).getTime() + RETENTION_DAYS * 86400000 - Date.now()) / 86400000);
  return remain >= 0
    ? { text: `보관 중 · ${remain}일 남음`, expired: false }
    : { text: '보관기간 경과', expired: true };
}

const th: React.CSSProperties = { padding: '7px 8px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: '#6b7280', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '6px 8px', fontSize: 12, color: '#374151', whiteSpace: 'nowrap' };

export function QuoteTrashTab({ token, isAdmin, onToast, onBack }: {
  token: string; isAdmin: boolean; onToast: (m: string) => void; onBack: () => void;
}) {
  const authH = { Authorization: `Bearer ${token}` };
  const [rows, setRows]         = useState<TrashRow[]>([]);
  const [loading, setLoading]   = useState(false);
  const [search, setSearch]     = useState('');
  const [busyId, setBusyId]     = useState<number | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<TrashRow | null>(null);
  const [purging, setPurging]   = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(api('/api/admin/quotes-trash'), { headers: authH });
      const data = await res.json().catch(() => []);
      if (!res.ok) { onToast(`휴지통 조회 실패: ${data?.error ?? res.status}`); setRows([]); return; }
      setRows(Array.isArray(data) ? data : []);
    } catch { onToast('휴지통 조회 중 오류가 발생했습니다.'); setRows([]); }
    finally { setLoading(false); }
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  const filtered = rows.filter(r => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (r.quoteNumber ?? '').toLowerCase().includes(s)
      || formatDocNumber('Q', r.quoteNumber, r.issueDate).toLowerCase().includes(s)
      || (r.title ?? '').toLowerCase().includes(s)
      || (r.companyName ?? '').toLowerCase().includes(s);
  });

  const handleRestore = async (r: TrashRow) => {
    if (!window.confirm(`'${formatDocNumber('Q', r.quoteNumber, r.issueDate)}' 견적서를 복원하시겠습니까?\n기본 견적 목록으로 되돌아갑니다.`)) return;
    setBusyId(r.id);
    try {
      const res = await fetch(api(`/api/admin/quotes/${r.id}/restore`), { method: 'POST', headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(`복원 실패: ${data.error ?? res.status}`); return; }
      onToast('견적서를 복원했습니다.');
      load();
    } catch { onToast('복원 중 오류가 발생했습니다.'); }
    finally { setBusyId(null); }
  };

  const handlePurge = async () => {
    if (!purgeTarget) return;
    setPurging(true);
    try {
      const res = await fetch(api(`/api/admin/quotes/${purgeTarget.id}/permanent`), { method: 'DELETE', headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(`영구삭제 실패: ${data.error ?? res.status}`); return; }
      onToast('견적서를 영구삭제했습니다.');
      setPurgeTarget(null);
      load();
    } catch { onToast('영구삭제 중 오류가 발생했습니다.'); }
    finally { setPurging(false); }
  };

  const fmt = (v: number) => (v || 0).toLocaleString();

  return (
    <div style={{ background: '#f9fafb', minHeight: '100vh' }}>
      <PageHeader
        onBack={onBack}
        testId="btn-trash-back"
        title="견적 휴지통"
        subtitle={loading ? '불러오는 중…' : `${rows.length}건`}
        right={
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="견적번호 · 견적서명 · 고객사 검색"
            data-testid="input-trash-search"
            style={{ width: 260, padding: '7px 12px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 8, outline: 'none' }} />
        }
        style={dsStickyPageHeader()}
      />

      <div style={{ padding: '20px 0 64px' }}>
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['견적번호', '견적서명', '고객사', '견적일', '금액', '삭제일', '삭제자', '삭제 사유', '보관상태', '관리'].map(h => (
                  <th key={h} style={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={10} style={{ ...td, textAlign: 'center', color: '#9ca3af', padding: '32px 8px' }}>
                  {loading ? '불러오는 중…' : (search ? '검색 결과가 없습니다.' : '휴지통이 비어 있습니다.')}
                </td></tr>
              ) : filtered.map(r => {
                const ret = retentionLabel(r.deletedAt);
                return (
                  <tr key={r.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <td style={{ ...td, fontFamily: 'monospace', color: '#475569' }}>{formatDocNumber('Q', r.quoteNumber, r.issueDate) || `#${r.id}`}</td>
                    <td style={{ ...td, color: '#111827', fontWeight: 600, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title ?? '(미입력)'}</td>
                    <td style={td}>{r.companyName ?? '—'}</td>
                    <td style={td}>{r.issueDate ?? '—'}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{fmt(r.price)}원</td>
                    <td style={td}>{r.deletedAt ? new Date(r.deletedAt).toLocaleDateString('ko-KR') : '—'}</td>
                    <td style={td}>{r.deletedByName ?? '—'}</td>
                    <td style={{ ...td, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', color: '#6b7280' }} title={r.deletionReason ?? ''}>{r.deletionReason ?? '—'}</td>
                    <td style={{ ...td, color: ret.expired ? '#b45309' : '#15803d', fontWeight: 600 }}>{ret.text}</td>
                    <td style={{ ...td }}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {/* 복원 — PM·관리자 모두 가능 */}
                        <button type="button" onClick={() => handleRestore(r)} disabled={busyId === r.id}
                          data-testid={`btn-restore-quote-${r.id}`} aria-label={`${r.quoteNumber ?? r.id} 복원`}
                          style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: busyId === r.id ? 'default' : 'pointer', background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe', fontWeight: 600, opacity: busyId === r.id ? 0.5 : 1 }}>
                          {busyId === r.id ? '…' : '복원'}
                        </button>
                        {/* 영구삭제 — 관리자만 노출(서버에서도 재검증) */}
                        {isAdmin && (
                          <button type="button" onClick={() => setPurgeTarget(r)}
                            data-testid={`btn-purge-quote-${r.id}`} aria-label={`${r.quoteNumber ?? r.id} 영구삭제`}
                            style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', background: '#dc2626', color: '#fff', border: '1px solid #b91c1c', fontWeight: 700 }}>
                            영구삭제
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p style={{ marginTop: 12, fontSize: 11, color: '#9ca3af' }}>
          ※ 보관기간(30일)이 지나도 자동으로 삭제되지 않습니다. 영구삭제는 관리자가 직접 실행해야 하며, 복원할 수 없습니다.
        </p>
      </div>

      {/* 영구삭제 재확인 모달 (관리자 전용, 위험도 강조) */}
      {purgeTarget && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => { if (!purging) setPurgeTarget(null); }}>
          <div onClick={e => e.stopPropagation()} data-testid="modal-quote-purge"
            style={{ background: '#fff', borderRadius: 14, padding: '26px 30px', width: 460, maxWidth: '92vw', boxShadow: '0 20px 60px rgba(0,0,0,0.25)', borderTop: '4px solid #dc2626' }}>
            <h2 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 800, color: '#dc2626' }}>견적서를 영구삭제하시겠습니까?</h2>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: '#374151', lineHeight: 1.6 }}>
              영구삭제한 견적서는 <strong style={{ color: '#dc2626' }}>복원할 수 없습니다.</strong><br />
              견적번호와 관련 견적 데이터가 모두 삭제됩니다.
            </p>
            <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', marginBottom: 18, fontSize: 12.5 }}>
              <div style={{ color: '#111827', fontWeight: 700, fontFamily: 'monospace' }}>{formatDocNumber('Q', purgeTarget.quoteNumber, purgeTarget.issueDate) || `#${purgeTarget.id}`}</div>
              <div style={{ color: '#6b7280', marginTop: 2 }}>{purgeTarget.title ?? '(미입력)'} · {purgeTarget.companyName ?? '—'}</div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setPurgeTarget(null)} disabled={purging} data-testid="btn-purge-cancel"
                style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #d1d5db', background: '#f9fafb', fontSize: 13, fontWeight: 600, cursor: purging ? 'not-allowed' : 'pointer', color: '#374151' }}>
                취소
              </button>
              <button onClick={handlePurge} disabled={purging} data-testid="btn-purge-confirm"
                style={{ padding: '9px 20px', borderRadius: 8, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, background: purging ? '#fca5a5' : '#dc2626', cursor: purging ? 'not-allowed' : 'pointer' }}>
                {purging ? '삭제 중…' : '영구삭제'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
