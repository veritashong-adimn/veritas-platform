/**
 * TranslatorTrashTab — 통번역사 휴지통
 *
 * 통번역사는 별도 deletedAt 소프트삭제 컬럼이 없고 `users.isActive`(활성/비활성)로 관리된다.
 * 따라서 휴지통 = 비활성(isActive=false) 통번역사 세트를 재사용한다(schema 변경 없음).
 *  · 조회: GET /api/admin/translators?includeInactive=true → isActive=false 만 클라이언트 필터(검색 API·DB 불변).
 *  · 복원: PATCH /api/admin/translators/:id/activate (기존 엔드포인트)
 *  · 완전삭제: DELETE /api/admin/translators/:id/permanent (프로젝트/정산 이력이 있으면 서버가 409 차단)
 * 권한은 서버가 재검증한다. 완전삭제 버튼은 관리자에게만 노출한다.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/constants';

const th: React.CSSProperties = { padding: '8px 10px', fontSize: 11, fontWeight: 700, color: '#6b7280', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 12, color: '#374151', whiteSpace: 'nowrap' };
const tdEllip: React.CSSProperties = { ...td, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' };

export function TranslatorTrashTab({ token, isAdmin, onToast, onRestored }: {
  token: string; isAdmin: boolean; onToast: (m: string) => void; onRestored?: () => void;
}) {
  const authH = { Authorization: `Bearer ${token}` };
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<any | null>(null);
  const [purging, setPurging] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(api('/api/admin/translators?includeInactive=true'), { headers: authH });
      const data = await res.json().catch(() => []);
      if (!res.ok) { onToast(`휴지통 조회 실패: ${(data as any)?.error ?? res.status}`); setRows([]); return; }
      const list = Array.isArray(data) ? data : (data?.rows ?? []);
      // 휴지통 = 비활성(isActive=false)만. 활성 통번역사는 목록 탭에서 관리.
      setRows(list.filter((r: any) => r.isActive === false));
    } catch { onToast('휴지통 조회 중 오류가 발생했습니다.'); setRows([]); }
    finally { setLoading(false); }
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  const filtered = rows.filter(r => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (r.name ?? '').toLowerCase().includes(s)
      || (r.email ?? '').toLowerCase().includes(s)
      || (r.languagePairs ?? '').toLowerCase().includes(s);
  });

  const handleRestore = async (r: any) => {
    if (!window.confirm(`'${r.name ?? r.email}' 통번역사를 복원(활성화)하시겠습니까?\n기존 단가·정산·작업 데이터는 모두 유지됩니다.`)) return;
    setBusyId(r.id);
    try {
      const res = await fetch(api(`/api/admin/translators/${r.id}/activate`), { method: 'PATCH', headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(`복원 실패: ${data.error ?? res.status}`); return; }
      onToast('통번역사를 복원했습니다.');
      onRestored?.();
      load();
    } catch { onToast('복원 중 오류가 발생했습니다.'); }
    finally { setBusyId(null); }
  };

  const handlePurge = async () => {
    if (!purgeTarget) return;
    setPurging(true);
    try {
      const res = await fetch(api(`/api/admin/translators/${purgeTarget.id}/permanent`), { method: 'DELETE', headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? '완전삭제 실패'); return; } // 이력 존재 시 서버가 409 + 사유 반환
      onToast('통번역사를 완전삭제했습니다.');
      setPurgeTarget(null);
      load();
    } catch { onToast('완전삭제 중 오류가 발생했습니다.'); }
    finally { setPurging(false); }
  };

  return (
    <div data-testid="translator-trash-tab">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 800, color: '#111827', margin: 0 }}>통번역사 휴지통</h1>
          <p style={{ fontSize: 12, color: '#9ca3af', margin: '4px 0 0' }}>{loading ? '불러오는 중…' : `비활성 통번역사 ${rows.length}명`}</p>
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="이름 · 이메일 · 가능언어 검색"
          data-testid="input-translator-trash-search"
          style={{ width: 280, maxWidth: '100%', padding: '8px 12px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 8, outline: 'none' }} />
      </div>

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              {['이름', '이메일', '가능언어', '등급', '관리'].map(h => <th key={h} style={th}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={5} style={{ ...td, textAlign: 'center', color: '#9ca3af', padding: '32px 8px' }}>
                {loading ? '불러오는 중…' : (search ? '검색 결과가 없습니다.' : '휴지통이 비어 있습니다.')}
              </td></tr>
            ) : filtered.map(r => (
              <tr key={r.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                <td style={{ ...tdEllip, color: '#111827', fontWeight: 700 }}>{r.name ?? '—'}</td>
                <td style={{ ...tdEllip, color: '#6b7280' }}>{r.email ?? '—'}</td>
                <td style={{ ...tdEllip, color: '#6b7280' }}>{r.languagePairs ?? '—'}</td>
                <td style={td}>{r.grade ?? '—'}</td>
                <td style={td}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button type="button" onClick={() => handleRestore(r)} disabled={busyId === r.id}
                      data-testid={`btn-restore-translator-${r.id}`} aria-label={`${r.name ?? r.email} 복원`}
                      style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: busyId === r.id ? 'default' : 'pointer', background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe', fontWeight: 600, opacity: busyId === r.id ? 0.5 : 1 }}>
                      {busyId === r.id ? '…' : '복원'}
                    </button>
                    {isAdmin && (
                      <button type="button" onClick={() => setPurgeTarget(r)}
                        data-testid={`btn-purge-translator-${r.id}`} aria-label={`${r.name ?? r.email} 완전삭제`}
                        style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', background: '#dc2626', color: '#fff', border: '1px solid #b91c1c', fontWeight: 700 }}>
                        완전삭제
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
        ※ 휴지통은 비활성 처리된 통번역사입니다. [복원]은 다시 활성화하며 기존 데이터가 유지됩니다. [완전삭제]는 연결된 프로젝트/정산 이력이 전혀 없는 경우에만 가능하며 복원할 수 없습니다.
      </p>

      {/* 완전삭제 재확인 모달 (관리자 전용) */}
      {purgeTarget && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => { if (!purging) setPurgeTarget(null); }}>
          <div onClick={e => e.stopPropagation()} data-testid="modal-translator-purge"
            style={{ background: '#fff', borderRadius: 14, padding: '26px 30px', width: 460, maxWidth: '92vw', boxShadow: '0 20px 60px rgba(0,0,0,0.25)', borderTop: '4px solid #dc2626' }}>
            <h2 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 800, color: '#dc2626' }}>통번역사를 완전삭제하시겠습니까?</h2>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: '#374151', lineHeight: 1.6 }}>
              완전삭제한 통번역사는 <strong style={{ color: '#dc2626' }}>복원할 수 없습니다.</strong><br />
              연결된 프로젝트/정산 이력이 존재하면 삭제할 수 없습니다(서버 재검증).
            </p>
            <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', marginBottom: 18, fontSize: 12.5 }}>
              <div style={{ color: '#111827', fontWeight: 700 }}>{purgeTarget.name ?? '—'}</div>
              <div style={{ color: '#6b7280', marginTop: 2 }}>{purgeTarget.email ?? '—'}</div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setPurgeTarget(null)} disabled={purging} data-testid="btn-translator-purge-cancel"
                style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #d1d5db', background: '#f9fafb', fontSize: 13, fontWeight: 600, cursor: purging ? 'not-allowed' : 'pointer', color: '#374151' }}>
                취소
              </button>
              <button onClick={handlePurge} disabled={purging} data-testid="btn-translator-purge-confirm"
                style={{ padding: '9px 20px', borderRadius: 8, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, background: purging ? '#fca5a5' : '#dc2626', cursor: purging ? 'not-allowed' : 'pointer' }}>
                {purging ? '삭제 중…' : '완전삭제'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default TranslatorTrashTab;
