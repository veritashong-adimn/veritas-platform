// ─── 과거 CRM 고객 담당자 확인 필요(B)·미확인(C) 목록 ─────────────────────────────
// 최신 복원 실행 배치(import_row_sources) 기준. 자동 확정하지 않은 판매건의 후보 고객명·연결 근거를 보여 주고,
// 행을 누르면 담당자 보완 창(SaleContactPicker)으로 직접 확인·연결한다.
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/constants';
import { ModalOverlay, GhostBtn } from '../ui';

type Row = { saleRowId: number; saleNo: string | null; companyName: string | null; productName: string | null; totalAmount: string | null;
  evidence: { reason?: string; candidates?: string[]; keyShared?: number | null; customerName?: string | null; detail?: string } };

export function ContactReviewListModal({ authHeaders, onClose, onPick }: {
  authHeaders: Record<string, string>; onClose: () => void; onPick: (saleRowId: number) => void;
}) {
  const [status, setStatus] = useState<'review' | 'unverified'>('review');
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    setRows(null);
    fetch(api(`/api/admin/legacy-contact-restore/review?status=${status}`), { headers: authHeaders })
      .then(r => r.json()).then(d => setRows(d.rows ?? [])).catch(() => setRows([]));
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const tab = (s: typeof status, label: string) => (
    <GhostBtn onClick={() => setStatus(s)} style={status === s ? { background: '#eff6ff', color: '#1d4ed8' } : undefined}
      data-testid={`btn-contact-review-${s}`} aria-label={label}>{label}</GhostBtn>
  );
  return (
    <ModalOverlay onClose={onClose} maxWidth={900}>
      <div data-testid="contact-review-list">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 16, fontWeight: 800 }}>과거 CRM 고객 담당자 확인</span>
          <span style={{ fontSize: 12, color: '#6b7280' }}>자동 확정하지 않은 판매건 — 행을 눌러 직접 확인·연결</span>
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>{tab('review', '확인 필요(후보 복수)')}{tab('unverified', '담당자 미확인(고객명 없음)')}</div>
        <div style={{ maxHeight: '60vh', overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ background: '#f3f4f6', textAlign: 'left' }}>
              {['판매번호', '거래처', '상품', '금액', status === 'review' ? '후보 고객명' : '사유', '근거'].map(h => <th key={h} style={{ padding: '7px 8px', position: 'sticky', top: 0, background: '#f3f4f6' }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {rows?.map(r => (
                <tr key={r.saleRowId} onClick={() => onPick(r.saleRowId)} style={{ borderTop: '1px solid #f3f4f6', cursor: 'pointer' }} data-testid={`contact-review-row-${r.saleRowId}`}>
                  <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{r.saleNo ?? '-'}</td>
                  <td style={{ padding: '6px 8px' }}>{r.companyName ?? '-'}</td>
                  <td style={{ padding: '6px 8px' }}>{r.productName ?? '-'}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>{r.totalAmount != null ? Number(r.totalAmount).toLocaleString() : '-'}</td>
                  <td style={{ padding: '6px 8px', fontWeight: 600 }}>{status === 'review' ? (r.evidence.candidates?.join(', ') || r.evidence.customerName || '-') : (r.evidence.reason ?? '-')}</td>
                  <td style={{ padding: '6px 8px', color: '#6b7280' }}>{status === 'review' ? <>{r.evidence.reason}{r.evidence.detail ? <span style={{ color: '#9ca3af' }}> · {r.evidence.detail}</span> : null}</> : '진행관리표'}</td>
                </tr>
              ))}
              {rows && !rows.length && <tr><td colSpan={6} style={{ padding: 20, textAlign: 'center', color: '#9ca3af' }}>대상이 없습니다.</td></tr>}
              {!rows && <tr><td colSpan={6} style={{ padding: 20, textAlign: 'center', color: '#9ca3af' }}>불러오는 중…</td></tr>}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontSize: 12, color: '#6b7280' }}>
          <span>{rows ? `${rows.length.toLocaleString()}건` : ''}</span>
          <GhostBtn onClick={onClose} data-testid="btn-contact-review-close" aria-label="닫기">닫기</GhostBtn>
        </div>
      </div>
    </ModalOverlay>
  );
}
