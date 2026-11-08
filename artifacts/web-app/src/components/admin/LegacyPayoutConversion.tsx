// 과거 CRM 미지급 수행건 → 운영 지급(은행이체) 전환 — 요청 버튼(건별) · 관리자 승인/반려 패널.
//  · 대상: 지급일이 없는 '지급확인 필요' 과거 수행건만(서버에서 다시 확인). 승인 = 운영 판매건 전환 + 미지급 확인(지급확정·송금 아님).
//  · 지급회차관리 화면 안에서만 사용(별도 메뉴 없음).
import React, { useCallback, useEffect, useState } from 'react';
import { api, loadSession } from '../../lib/constants';

export type ConversionInfo = { id: number; status: 'requested' | 'approved' | 'rejected'; decisionNote: string | null } | null;
type Req = {
  id: number; progress_row_id: number; sale_no: string | null; translator_name: string | null; delivery_date: string | null;
  amount_pretax: string | null; amount_posttax: string | null; status: string; request_note: string | null;
  requested_by_name: string | null; requested_at: string;
};
const won = (v: unknown) => Math.round(Number(v ?? 0)).toLocaleString('ko-KR');
export const isAdminUser = () => { try { return loadSession()?.user?.role === 'admin'; } catch { return false; } };
const fmtAt = (v: string) => { const d = new Date(String(v).replace(' ', 'T') + (/[zZ+]/.test(String(v)) ? '' : 'Z')); return isNaN(d.getTime()) ? v : d.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }); };

async function call(token: string, path: string, body?: Record<string, unknown>) {
  const res = await fetch(api(path), { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d?.error || `처리 실패 (HTTP ${res.status})`);
  return d;
}

/** 건별 상세 '지급 전환' 셀 — 상태 배지 또는 요청 버튼. */
export function ConversionCell({ token, rowId, conversion, eligible, onToast, onChanged }: {
  token: string; rowId: number; conversion: ConversionInfo; eligible: boolean; onToast: (m: string) => void; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const badge = (t: string, bg: string, fg: string, title?: string) => <span title={title} style={{ padding: '2px 8px', borderRadius: 10, background: bg, color: fg, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', cursor: title ? 'help' : undefined }}>{t}</span>;
  const request = async () => {
    const note = window.prompt('지급 전환 승인 요청 — 미지급 여부·지급정보 확인 내용(선택)을 입력하세요.\n관리자 승인 후에만 은행이체 대상이 됩니다(승인 ≠ 지급완료·송금).', '');
    if (note === null) return;
    setBusy(true);
    try { await call(token, '/api/admin/legacy-payout-conversions', { progressRowId: rowId, note }); onToast('지급 전환 승인 요청을 등록했습니다.'); onChanged(); }
    catch (e: any) { onToast(e?.message || '승인 요청 실패'); } finally { setBusy(false); }
  };
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      {conversion?.status === 'approved' && badge('전환 승인', '#ecfdf5', '#047857', '관리자 승인 — 운영 지급확정·은행이체 화면에서 처리')}
      {conversion?.status === 'requested' && badge('승인 요청 중', '#eff6ff', '#1d4ed8')}
      {conversion?.status === 'rejected' && badge('반려', '#fef2f2', '#b91c1c', conversion.decisionNote ? `반려 사유: ${conversion.decisionNote}` : undefined)}
      {eligible && (
        <button type="button" onClick={request} disabled={busy} data-testid={`pu-conv-request-${rowId}`} aria-label="지급 전환 승인 요청"
          style={{ padding: '3px 9px', borderRadius: 6, border: '1px solid #93c5fd', background: '#fff', color: '#1d4ed8', fontSize: 12, fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}>
          {busy ? '요청 중…' : conversion?.status === 'rejected' ? '재요청' : '지급 전환 승인 요청'}
        </button>
      )}
      {!conversion && !eligible && <span style={{ color: '#d1d5db' }}>-</span>}
    </span>
  );
}

/** 지급 전환 승인 요청 목록 — 관리자: 승인·반려 / 담당자: 조회. 요청이 없으면 표시하지 않음. */
export function ConversionRequestsPanel({ token, onToast, reloadKey, onChanged }: { token: string; onToast: (m: string) => void; reloadKey: number; onChanged: () => void }) {
  const [rows, setRows] = useState<Req[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const admin = isAdminUser();
  const load = useCallback(async () => {
    try { const d = await call(token, '/api/admin/legacy-payout-conversions?status=requested'); setRows(d.rows ?? []); setErr(null); }
    catch (e: any) { setErr(e?.message || '전환 요청 목록 조회 실패'); }
  }, [token]);
  useEffect(() => { load(); }, [load, reloadKey]);
  const decide = async (r: Req, kind: 'approve' | 'reject') => {
    let note: string | null = '';
    if (kind === 'approve') {
      if (!window.confirm(`승인하면 이 수행건이 속한 과거 판매건(${r.sale_no ?? '-'})을 운영 판매건으로 전환하고, 이 수행건만 미지급으로 확정해 은행이체 대상에 포함합니다.\n지급확정·송금은 기존 절차로 따로 진행합니다. 승인할까요?`)) return;
      note = window.prompt('승인 메모(선택)', '') ?? '';
    } else {
      note = window.prompt('반려 사유를 입력하세요(필수)', '');
      if (!note || !note.trim()) return;
    }
    setBusy(r.id);
    try { await call(token, `/api/admin/legacy-payout-conversions/${r.id}/${kind}`, { note }); onToast(kind === 'approve' ? '승인했습니다 — 운영 지급확정·은행이체 화면에서 처리할 수 있습니다.' : '반려했습니다.'); await load(); onChanged(); }
    catch (e: any) { onToast(e?.message || '처리 실패'); } finally { setBusy(null); }
  };
  if (err) return <div role="alert" style={{ marginBottom: 10, fontSize: 12.5, color: '#b91c1c' }} data-testid="pu-conv-error">{err}</div>;
  if (!rows.length) return null;
  const td: React.CSSProperties = { padding: '6px 10px', fontSize: 12.5, borderBottom: '1px solid #f3f4f6', whiteSpace: 'nowrap' };
  return (
    <div data-testid="pu-conv-panel" style={{ marginBottom: 12, border: '1px solid #bfdbfe', background: '#f8fbff', borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: '#1e3a8a', marginBottom: 6 }}>
        과거 CRM 지급 전환 승인 요청 {rows.length}건 <span style={{ fontWeight: 600, color: '#64748b', fontSize: 11.5 }}>· 승인 시 운영 지급확정·은행이체 대상에 포함(지급확정·송금은 기존 절차)</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', background: '#fff' }}>
          <thead><tr>{['요청일시', '요청자', '판매번호', '통번역사', '납품일', '세전', '세후', '요청 메모', admin ? '처리' : ''].map(h => <th key={h} style={{ ...td, fontWeight: 700, color: '#374151', background: '#f3f4f6', textAlign: h === '세전' || h === '세후' ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} data-testid={`pu-conv-row-${r.id}`}>
                <td style={td}>{fmtAt(r.requested_at)}</td><td style={td}>{r.requested_by_name ?? '-'}</td><td style={td}>{r.sale_no ?? '-'}</td>
                <td style={td}>{r.translator_name ?? '-'}</td><td style={td}>{r.delivery_date ?? '-'}</td>
                <td style={{ ...td, textAlign: 'right' }}>{won(r.amount_pretax)}</td><td style={{ ...td, textAlign: 'right' }}>{won(r.amount_posttax)}</td>
                <td style={{ ...td, whiteSpace: 'normal', maxWidth: 260 }}>{r.request_note || '-'}</td>
                <td style={td}>{admin && (
                  <span style={{ display: 'inline-flex', gap: 6 }}>
                    <button type="button" disabled={busy === r.id} onClick={() => decide(r, 'approve')} data-testid={`pu-conv-approve-${r.id}`} aria-label="전환 승인"
                      style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: '#0ea5e9', color: '#fff', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>{busy === r.id ? '처리 중…' : '승인'}</button>
                    <button type="button" disabled={busy === r.id} onClick={() => decide(r, 'reject')} data-testid={`pu-conv-reject-${r.id}`} aria-label="전환 반려"
                      style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #fca5a5', background: '#fff', color: '#b91c1c', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>반려</button>
                  </span>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
