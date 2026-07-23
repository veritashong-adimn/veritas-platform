/**
 * CompanyTrashTab — 거래처 휴지통 페이지
 *
 * soft-delete(휴지통 이동)된 거래처만 조회한다. 복원 / 영구삭제(모두 관리자 전용)를 제공한다.
 * 견적 휴지통(QuoteTrashTab)과 동일한 UX·버튼 패턴을 유지한다. 서버가 권한을 재검증한다.
 *
 * 일반 영구삭제는 연결 업무 데이터가 전혀 없을 때만 가능하다. 연결 데이터가 존재하면
 * 서버가 409로 차단하며 "연결된 업무 데이터가 존재하여 영구삭제할 수 없습니다." 를 안내한다.
 * (연결 데이터가 있는 거래처의 강제 정리는 Phase B: 관리자 강제 영구삭제에서 제공 예정)
 */
import React, { useState, useEffect, useCallback } from 'react';
import { api, CUSTOMER_TYPE_LABELS, VENDOR_TYPE_LABELS, getCustomerTypeBadgeColors } from '../../lib/constants';
import { PageHeader } from './PageHeader';
import { dsStickyPageHeader } from '../../lib/ds';

interface TrashRow {
  id: number;
  name: string;
  companyType: string;
  vendorType: string | null;
  customerType: string | null;
  deletedAt: string | null;
  deletionReason: string | null;
  deletedByName: string | null;
}

const th: React.CSSProperties = { padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 12, color: '#374151', whiteSpace: 'nowrap' };

/** 거래처 유형 컴팩트 배지 — 목록/상세와 동일 데이터(customerType/vendorType) 기준 */
function typeBadge(r: TrashRow): { label: string; style: React.CSSProperties } {
  const base: React.CSSProperties = { display: 'inline-block', fontSize: 11, fontWeight: 600, padding: '1px 7px', borderRadius: 4, lineHeight: 1.4, whiteSpace: 'nowrap' };
  if (r.companyType === 'vendor') {
    const label = r.vendorType ? (VENDOR_TYPE_LABELS[r.vendorType] ?? r.vendorType) : '외주업체';
    return { label, style: { ...base, background: '#f5f3ff', color: '#7c3aed', border: '1px solid #ddd6fe' } };
  }
  const ct = r.customerType ?? 'CORPORATE';
  const { bg, color, border } = getCustomerTypeBadgeColors(ct);
  return { label: CUSTOMER_TYPE_LABELS[ct] ?? '기업', style: { ...base, background: bg, color, border: `1px solid ${border}` } };
}

export function CompanyTrashTab({ token, isAdmin, onToast, onBack }: {
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
      const res = await fetch(api('/api/admin/companies-trash'), { headers: authH });
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
      || (r.deletionReason ?? '').toLowerCase().includes(s)
      || (r.deletedByName ?? '').toLowerCase().includes(s);
  });

  const handleRestore = async (r: TrashRow) => {
    if (!window.confirm(`'${r.name}' 거래처를 복원하시겠습니까?\n기존 거래처 목록으로 되돌아갑니다. (연결 데이터는 모두 유지됩니다)`)) return;
    setBusyId(r.id);
    try {
      const res = await fetch(api(`/api/admin/companies/${r.id}/restore`), { method: 'POST', headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(`복원 실패: ${data.error ?? res.status}`); return; }
      onToast('거래처를 복원했습니다.');
      load();
    } catch { onToast('복원 중 오류가 발생했습니다.'); }
    finally { setBusyId(null); }
  };

  const handlePurge = async () => {
    if (!purgeTarget) return;
    setPurging(true);
    try {
      const res = await fetch(api(`/api/admin/companies/${purgeTarget.id}/permanent`), { method: 'DELETE', headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 연결 데이터 존재 시 서버가 409 + reasons 반환
        const detail = Array.isArray(data?.reasons) && data.reasons.length
          ? ` (${data.reasons.map((x: { label: string; count: number }) => `${x.label} ${x.count}`).join(', ')})`
          : '';
        onToast(`${data.error ?? '영구삭제 실패'}${detail}`);
        return;
      }
      onToast('거래처를 영구삭제했습니다.');
      setPurgeTarget(null);
      load();
    } catch { onToast('영구삭제 중 오류가 발생했습니다.'); }
    finally { setPurging(false); }
  };

  return (
    <div style={{ background: '#f9fafb', minHeight: '100vh' }}>
      <PageHeader
        onBack={onBack}
        testId="btn-company-trash-back"
        title="거래처 휴지통"
        subtitle={loading ? '불러오는 중…' : `${rows.length}건`}
        right={
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="거래처명 · 삭제 사유 · 삭제자 검색"
            data-testid="input-company-trash-search"
            style={{ width: 260, padding: '7px 12px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 8, outline: 'none' }} />
        }
        style={dsStickyPageHeader()}
      />

      <div style={{ padding: '20px 0 64px' }}>
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['거래처명', '유형', '삭제일', '삭제자', '삭제 사유', '관리'].map(h => (
                  <th key={h} style={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={6} style={{ ...td, textAlign: 'center', color: '#9ca3af', padding: '32px 8px' }}>
                  {loading ? '불러오는 중…' : (search ? '검색 결과가 없습니다.' : '휴지통이 비어 있습니다.')}
                </td></tr>
              ) : filtered.map(r => {
                const b = typeBadge(r);
                return (
                  <tr key={r.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <td style={{ ...td, color: '#111827', fontWeight: 700, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</td>
                    <td style={td}><span style={b.style}>{b.label}</span></td>
                    <td style={td}>{r.deletedAt ? new Date(r.deletedAt).toLocaleDateString('ko-KR') : '—'}</td>
                    <td style={td}>{r.deletedByName ?? '—'}</td>
                    <td style={{ ...td, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', color: '#6b7280' }} title={r.deletionReason ?? ''}>{r.deletionReason ?? '—'}</td>
                    <td style={{ ...td }}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {/* 복원 — 관리자 전용(서버에서도 재검증) */}
                        <button type="button" onClick={() => handleRestore(r)} disabled={busyId === r.id}
                          data-testid={`btn-restore-company-${r.id}`} aria-label={`${r.name} 복원`}
                          style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: busyId === r.id ? 'default' : 'pointer', background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe', fontWeight: 600, opacity: busyId === r.id ? 0.5 : 1 }}>
                          {busyId === r.id ? '…' : '복원'}
                        </button>
                        {/* 영구삭제 — 관리자만 노출(서버에서도 재검증) */}
                        {isAdmin && (
                          <button type="button" onClick={() => setPurgeTarget(r)}
                            data-testid={`btn-purge-company-${r.id}`} aria-label={`${r.name} 영구삭제`}
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
          ※ 영구삭제는 연결된 업무 데이터가 전혀 없는 거래처만 가능하며, 복원할 수 없습니다. 연결 데이터가 있는 거래처는 관계 보존을 위해 휴지통에 보관됩니다.
        </p>
      </div>

      {/* 영구삭제 재확인 모달 (관리자 전용, 위험도 강조) */}
      {purgeTarget && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => { if (!purging) setPurgeTarget(null); }}>
          <div onClick={e => e.stopPropagation()} data-testid="modal-company-purge"
            style={{ background: '#fff', borderRadius: 14, padding: '26px 30px', width: 460, maxWidth: '92vw', boxShadow: '0 20px 60px rgba(0,0,0,0.25)', borderTop: '4px solid #dc2626' }}>
            <h2 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 800, color: '#dc2626' }}>거래처를 영구삭제하시겠습니까?</h2>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: '#374151', lineHeight: 1.6 }}>
              영구삭제한 거래처는 <strong style={{ color: '#dc2626' }}>복원할 수 없습니다.</strong><br />
              연결된 업무 데이터가 존재하면 삭제할 수 없습니다.
            </p>
            <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', marginBottom: 18, fontSize: 12.5 }}>
              <div style={{ color: '#111827', fontWeight: 700 }}>{purgeTarget.name}</div>
              <div style={{ color: '#6b7280', marginTop: 2 }}>{typeBadge(purgeTarget).label}</div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setPurgeTarget(null)} disabled={purging} data-testid="btn-company-purge-cancel"
                style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #d1d5db', background: '#f9fafb', fontSize: 13, fontWeight: 600, cursor: purging ? 'not-allowed' : 'pointer', color: '#374151' }}>
                취소
              </button>
              <button onClick={handlePurge} disabled={purging} data-testid="btn-company-purge-confirm"
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
