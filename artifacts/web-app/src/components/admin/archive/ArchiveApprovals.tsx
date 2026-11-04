/** 승인관리 — 요청자·자료명·요청유형·변경 전후·사유·AI 작성 여부·승인자·처리결과 */
import React, { useCallback, useEffect, useState } from 'react';
import { APPROVAL_STATUS_LABEL, APPROVAL_TYPE_LABEL, S, badgeStyle, fmtDateTime, type ArchiveApi } from './archiveApi';

export function ArchiveApprovals({ api, onOpen, setToast, refreshKey, onChanged }: {
  api: ArchiveApi; onOpen: (id: number) => void; setToast: (m: string) => void; refreshKey: number; onChanged: () => void;
}) {
  const [status, setStatus] = useState('pending');
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  const [notes, setNotes] = useState<Record<number, string>>({});
  const load = useCallback(() => { api.get(`/archive/approvals?status=${status}`).then(r => { setRows(r); setErr(''); }).catch(e => setErr(e.message)); }, [api, status]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const decide = async (id: number, decision: 'approve' | 'reject' | 'cancel') => {
    try {
      await api.post(`/archive/approvals/${id}/${decision}`, { note: notes[id] ?? '' });
      setToast(decision === 'approve' ? '승인했습니다.' : decision === 'reject' ? '반려했습니다.' : '요청을 취소했습니다.');
      load(); onChanged();
    } catch (e: any) { setToast(e.message); }
  };

  return (
    <div style={S.card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <h2 style={{ ...S.h2, margin: 0, flex: 1 }}>승인관리</h2>
        {['pending', 'approved', 'rejected', 'cancelled', 'all'].map(k => (
          <button key={k} type="button" onClick={() => setStatus(k)} data-testid={`archive-approvals-filter-${k}`} aria-label={`${APPROVAL_STATUS_LABEL[k] ?? '전체'} 보기`}
            style={{ ...S.btn, background: status === k ? '#eff6ff' : '#fff', borderColor: status === k ? '#93c5fd' : '#d1d5db', fontWeight: status === k ? 700 : 400 }}>
            {APPROVAL_STATUS_LABEL[k] ?? '전체'}
          </button>
        ))}
      </div>
      <div style={{ ...S.muted, marginBottom: 10 }}>
        요청자는 본인 요청을 승인할 수 없습니다(최고관리자 제외). AI가 작성한 문서도 동일한 승인 절차를 거칩니다.
      </div>
      {err && <div style={{ color: '#b91c1c' }}>{err}</div>}
      {rows?.length === 0 && <div style={{ ...S.muted, padding: 24, textAlign: 'center' }}>해당 상태의 승인 요청이 없습니다.</div>}
      {rows?.map(r => (
        <div key={r.id} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginBottom: 10 }} data-testid={`archive-approval-${r.id}`}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={badgeStyle(r.status === 'approved' ? '#059669' : r.status === 'rejected' ? '#dc2626' : r.status === 'pending' ? '#d97706' : '#6b7280')}>{APPROVAL_STATUS_LABEL[r.status]}</span>
            <b style={{ fontSize: 13 }}>{APPROVAL_TYPE_LABEL[r.requestType] ?? r.requestType}</b>
            {r.isAiAuthored && <span style={badgeStyle('#7c3aed')}>AI 작성</span>}
            <button type="button" onClick={() => onOpen(r.documentId)} disabled={r.documentDeleted} data-testid={`archive-approval-open-${r.id}`} aria-label={`${r.documentTitle} 열기`}
              style={{ border: 0, background: 'none', color: '#1d4ed8', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>{r.documentTitle}{r.documentDeleted && ' (휴지통)'}</button>
            <span style={S.muted}>{r.folderPath}</span>
          </div>
          <div style={{ ...S.muted, marginTop: 4 }}>
            요청자 {r.requesterName ?? '—'} · {fmtDateTime(r.requestedAt)}
            {r.version && <> · v{r.version.versionNo} {r.version.fileName}</>}
            {r.reason && <> · 사유: {r.reason}</>}
          </div>
          {r.payload && (r.requestType === 'acl_change' || r.requestType === 'status_change') && (
            <details style={{ marginTop: 4, fontSize: 12 }}>
              <summary style={{ cursor: 'pointer', color: '#4b5563' }}>변경 전후 내용</summary>
              <pre style={{ fontSize: 11, background: '#f9fafb', padding: 8, borderRadius: 6, whiteSpace: 'pre-wrap' }}>{JSON.stringify(r.payload, null, 2)}</pre>
            </details>
          )}
          {r.decidedAt && <div style={{ ...S.muted, marginTop: 4 }}>처리 {r.deciderName ?? '—'} · {fmtDateTime(r.decidedAt)}{r.decisionNote ? ` · 의견: ${r.decisionNote}` : ''}</div>}
          {(r.canDecide || r.canCancel) && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <input style={{ ...S.input, flex: 1 }} placeholder={r.canDecide ? '검토 의견(반려 시 필수)' : '취소 사유'} value={notes[r.id] ?? ''}
                onChange={e => setNotes(n => ({ ...n, [r.id]: e.target.value }))} aria-label="검토 의견" data-testid={`archive-approval-note-${r.id}`} />
              {r.canDecide && <button type="button" style={S.btnPrimary} onClick={() => decide(r.id, 'approve')} data-testid={`archive-approval-approve-${r.id}`} aria-label="승인">승인</button>}
              {r.canDecide && <button type="button" style={S.btnDanger} onClick={() => decide(r.id, 'reject')} data-testid={`archive-approval-reject-${r.id}`} aria-label="반려">반려</button>}
              {r.canCancel && <button type="button" style={S.btn} onClick={() => decide(r.id, 'cancel')} data-testid={`archive-approval-cancel-${r.id}`} aria-label="요청 취소">요청 취소</button>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
