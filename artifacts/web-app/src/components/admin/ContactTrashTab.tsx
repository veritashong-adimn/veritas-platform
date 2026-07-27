/**
 * ContactTrashTab — 담당자 휴지통 페이지
 *
 * soft-delete(휴지통 이동)된 담당자만 조회한다. 복원 / 영구삭제를 제공한다.
 * 거래처 휴지통(CompanyTrashTab)과 동일한 UX·버튼 패턴을 유지한다. 서버가 권한을 재검증한다.
 *
 * 일반 영구삭제는 연결 업무 데이터(프로젝트/견적/청구)가 전혀 없을 때만 가능하다.
 * 연결 데이터가 존재하면 서버가 409로 차단한다.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/constants';
import { PageHeader } from './PageHeader';
import { dsStickyPageHeader } from '../../lib/ds';

interface TrashRow {
  id: number;
  name: string;
  companyName: string | null;
  department: string | null;
  position: string | null;
  deletedAt: string | null;
  deletionReason: string | null;
  deletedByName: string | null;
}

const th: React.CSSProperties = { padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 12, color: '#374151', whiteSpace: 'nowrap' };

export function ContactTrashTab({ token, isAdmin, onToast, onBack, onRestored }: {
  token: string; isAdmin: boolean; onToast: (m: string) => void; onBack: () => void; onRestored?: () => void;
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
      const res = await fetch(api('/api/admin/contacts-trash'), { headers: authH });
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
    return (r.name ?? '').toLowerCase().includes(s)
      || (r.companyName ?? '').toLowerCase().includes(s)
      || (r.deletionReason ?? '').toLowerCase().includes(s)
      || (r.deletedByName ?? '').toLowerCase().includes(s);
  });

  const handleRestore = async (r: TrashRow) => {
    if (!window.confirm(`'${r.name}' 담당자를 복원하시겠습니까?\n기존 담당자 목록으로 되돌아갑니다. (연결 데이터는 모두 유지됩니다)`)) return;
    setBusyId(r.id);
    try {
      const res = await fetch(api(`/api/admin/contacts/${r.id}/restore`), { method: 'POST', headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(`복원 실패: ${data.error ?? res.status}`); return; }
      onToast('담당자를 복원했습니다.');
      onRestored?.();
      load();
    } catch { onToast('복원 중 오류가 발생했습니다.'); }
    finally { setBusyId(null); }
  };

  const handlePurge = async () => {
    if (!purgeTarget) return;
    setPurging(true);
    try {
      const res = await fetch(api(`/api/admin/contacts/${purgeTarget.id}/permanent`), { method: 'DELETE', headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 연결 데이터 존재 시 서버가 409 + reason/count 반환
        const detail = typeof data?.count === 'number' && data.count > 0 ? ` (프로젝트 ${data.count})` : '';
        onToast(`${data.error ?? '영구삭제 실패'}${detail}`);
        return;
      }
      onToast('담당자를 영구삭제했습니다.');
      setPurgeTarget(null);
      load();
    } catch { onToast('영구삭제 중 오류가 발생했습니다.'); }
    finally { setPurging(false); }
  };

  return (
    <div style={{ background: '#f9fafb', minHeight: '100vh' }}>
      <PageHeader
        onBack={onBack}
        testId="btn-contact-trash-back"
        title="담당자 휴지통"
        subtitle={loading ? '불러오는 중…' : `${rows.length}건`}
        right={
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="담당자명 · 거래처 · 삭제 사유 · 삭제자 검색"
            data-testid="input-contact-trash-search"
            style={{ width: 280, padding: '7px 12px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 8, outline: 'none' }} />
        }
        style={dsStickyPageHeader()}
      />

      <div style={{ padding: '20px 0 64px' }}>
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['담당자명', '거래처', '부서/직책', '삭제일', '삭제자', '삭제 사유', '관리'].map(h => (
                  <th key={h} style={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={7} style={{ ...td, textAlign: 'center', color: '#9ca3af', padding: '32px 8px' }}>
                  {loading ? '불러오는 중…' : (search ? '검색 결과가 없습니다.' : '휴지통이 비어 있습니다.')}
                </td></tr>
              ) : filtered.map(r => (
                <tr key={r.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ ...td, color: '#111827', fontWeight: 700, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</td>
                  <td style={{ ...td, color: '#6b7280', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.companyName ?? '—'}</td>
                  <td style={{ ...td, color: '#6b7280' }}>{[r.department, r.position].filter(Boolean).join(' / ') || '—'}</td>
                  <td style={td}>{r.deletedAt ? new Date(r.deletedAt).toLocaleDateString('ko-KR') : '—'}</td>
                  <td style={td}>{r.deletedByName ?? '—'}</td>
                  <td style={{ ...td, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', color: '#6b7280' }} title={r.deletionReason ?? ''}>{r.deletionReason ?? '—'}</td>
                  <td style={{ ...td }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {/* 복원 */}
                      <button type="button" onClick={() => handleRestore(r)} disabled={busyId === r.id}
                        data-testid={`btn-restore-contact-${r.id}`} aria-label={`${r.name} 복원`}
                        style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: busyId === r.id ? 'default' : 'pointer', background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe', fontWeight: 600, opacity: busyId === r.id ? 0.5 : 1 }}>
                        {busyId === r.id ? '…' : '복원'}
                      </button>
                      {/* 영구삭제 — 관리자만 노출(서버에서도 재검증) */}
                      {isAdmin && (
                        <button type="button" onClick={() => setPurgeTarget(r)}
                          data-testid={`btn-purge-contact-${r.id}`} aria-label={`${r.name} 영구삭제`}
                          style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', background: '#dc2626', color: '#fff', border: '1px solid #b91c1c', fontWeight: 700 }}>
                          영구삭제
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ marginTop: 12, fontSize: 11, color: '#9ca3af' }}>
          ※ 영구삭제는 연결된 업무 데이터(프로젝트/견적/청구)가 전혀 없는 담당자만 가능하며, 복원할 수 없습니다. 연결 데이터가 있는 담당자는 관계 보존을 위해 휴지통에 보관됩니다.
        </p>
      </div>

      {/* 영구삭제 재확인 모달 (관리자 전용, 위험도 강조) */}
      {purgeTarget && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => { if (!purging) setPurgeTarget(null); }}>
          <div onClick={e => e.stopPropagation()} data-testid="modal-contact-purge"
            style={{ background: '#fff', borderRadius: 14, padding: '26px 30px', width: 460, maxWidth: '92vw', boxShadow: '0 20px 60px rgba(0,0,0,0.25)', borderTop: '4px solid #dc2626' }}>
            <h2 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 800, color: '#dc2626' }}>담당자를 영구삭제하시겠습니까?</h2>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: '#374151', lineHeight: 1.6 }}>
              영구삭제한 담당자는 <strong style={{ color: '#dc2626' }}>복원할 수 없습니다.</strong><br />
              연결된 업무 데이터가 존재하면 삭제할 수 없습니다.
            </p>
            <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', marginBottom: 18, fontSize: 12.5 }}>
              <div style={{ color: '#111827', fontWeight: 700 }}>{purgeTarget.name}</div>
              <div style={{ color: '#6b7280', marginTop: 2 }}>{purgeTarget.companyName ?? '—'}</div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setPurgeTarget(null)} disabled={purging} data-testid="btn-contact-purge-cancel"
                style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #d1d5db', background: '#f9fafb', fontSize: 13, fontWeight: 600, cursor: purging ? 'not-allowed' : 'pointer', color: '#374151' }}>
                취소
              </button>
              <button onClick={handlePurge} disabled={purging} data-testid="btn-contact-purge-confirm"
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
