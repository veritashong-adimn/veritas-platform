// 거래처·담당자 대량등록 — 최근 등록 배치 이력 · 배치 되돌리기(삭제 없이 소프트 삭제·이전 값 복원)
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/constants';

export function PartyImportBatches({ token, module, onToast, refreshKey }: { token: string; module: 'company' | 'contact'; onToast: (m: string) => void; refreshKey?: unknown }) {
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [open, setOpen] = useState(false);
  const [batches, setBatches] = useState<any[]>([]);
  const [plan, setPlan] = useState<any>(null);
  const load = useCallback(async () => {
    try { const r = await fetch(api(`/api/admin/party-import/${module}/batches`), { headers: auth }); const d = await r.json(); if (r.ok) setBatches(d.batches ?? []); } catch { /* 무시 */ }
  }, [module, token]); // eslint-disable-line
  useEffect(() => { if (open) load(); }, [open, load, refreshKey]);
  const preview = async (id: number) => { const r = await fetch(api(`/api/admin/party-import/batches/${id}/rollback-preview`), { headers: auth }); const d = await r.json(); if (!r.ok) { onToast(d?.error || '되돌리기 미리보기 실패'); return; } setPlan(d); };
  const run = async () => {
    const r = await fetch(api(`/api/admin/party-import/batches/${plan.batchId}/rollback`), { method: 'POST', headers: auth, body: JSON.stringify({ confirm: true }) }); const d = await r.json();
    if (!r.ok) { onToast(d?.error || '되돌리기 실패'); return; }
    onToast(`배치 #${plan.batchId} 되돌리기 완료: 신규 ${d.softDeleted}건 비활성 · 수정 항목 ${d.restored}개 복원 · 보존 ${d.kept}건`); setPlan(null); load();
  };
  const td: React.CSSProperties = { padding: '5px 8px', borderTop: '1px solid #f3f4f6', fontSize: 12 };
  const btn = (c: string): React.CSSProperties => ({ padding: '5px 10px', borderRadius: 6, border: 'none', background: c, color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' });
  return (
    <div style={{ marginTop: 12 }} data-testid={`party-batches-${module}`}>
      <button onClick={() => setOpen(v => !v)} aria-expanded={open} aria-label="등록 이력 · 배치 되돌리기" data-testid={`party-batches-toggle-${module}`}
        style={{ fontSize: 12.5, fontWeight: 700, background: 'none', border: 'none', color: '#475569', cursor: 'pointer', padding: 0 }}>{open ? '▾' : '▸'} 등록 이력 · 배치 되돌리기</button>
      {open && (<>
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6 }}>
          <thead><tr style={{ background: '#f9fafb', textAlign: 'left', fontSize: 12 }}>{['배치', '파일', '신규', '수정', '상태', '등록일', ''].map(h => <th key={h} style={{ padding: '5px 8px' }}>{h}</th>)}</tr></thead>
          <tbody>
            {batches.length === 0 && <tr><td colSpan={7} style={{ ...td, color: '#9ca3af' }}>이력 없음</td></tr>}
            {batches.map(b => (
              <tr key={b.id}><td style={td}>#{b.id}</td><td style={td}>{b.original_filename ?? '-'}</td><td style={td}>{b.created}</td><td style={td}>{b.updated}</td>
                <td style={td}>{b.status === 'rolled_back' ? '되돌림' : '반영됨'}</td><td style={td}>{new Date(b.created_at).toLocaleString()}</td>
                <td style={td}>{b.status !== 'rolled_back' && <button style={btn('#6b7280')} onClick={() => preview(b.id)} data-testid={`party-rb-preview-${b.id}`} aria-label={`배치 ${b.id} 되돌리기 확인`}>되돌리기 확인</button>}</td></tr>
            ))}
          </tbody>
        </table>
        {plan && (
          <div style={{ marginTop: 6, padding: 10, borderRadius: 8, background: plan.ok ? '#fef2f2' : '#f9fafb', border: '1px solid #fecaca', fontSize: 12.5 }} data-testid="party-rb-plan">
            <b>배치 #{plan.batchId} 되돌리기 {plan.ok ? '가능' : '불가'}</b> — {plan.reason}
            {plan.ok && <div>신규 {plan.created}건 중 {plan.createdRollbackable}건 비활성(이후 업무 연결된 {plan.createdKept}건 보존) · 수정 항목 복원 {plan.fieldsRestorable} · 이후 변경으로 보존 {plan.fieldsKept}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              {plan.ok && <button style={btn('#dc2626')} onClick={run} data-testid="party-rb-run" aria-label="되돌리기 실행">되돌리기 실행</button>}
              <button style={btn('#6b7280')} onClick={() => setPlan(null)} data-testid="party-rb-close" aria-label="닫기">닫기</button>
            </div>
          </div>
        )}
      </>)}
    </div>
  );
}
