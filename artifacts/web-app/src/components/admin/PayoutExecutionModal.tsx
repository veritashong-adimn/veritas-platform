// ─────────────────────────────────────────────────────────────────────────────
// 지급 실행(Payment Execution) — 정산 Phase 2.
//  · confirmed/paid 지급회차의 payout_transfers(1인 1송금)를 은행 송금 전 최종 검토·확정하는 화면.
//  · 실제 송금·IBK 파일은 만들지 않는다. 계좌검증/재검증/제외/제외해제 + 송금파일 생성 가능 여부만 계산.
//  · 금액(amount)은 payout_transfers snapshot 그대로 표시 — 정산 재계산 없음(§2·§14).
//  · 계좌번호는 서버가 마스킹한 값만 수신(전체 계좌번호 미수신, §3·§13).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../../lib/constants';
import { PrimaryBtn, GhostBtn } from '../ui';
import { C, TYPO, SP, BD, dsInputStd } from '../../lib/ds';

const won = (n: unknown) => Math.round(Number(n ?? 0)).toLocaleString('ko-KR');
const dateVal = (v?: string | null) => (v ? String(v).slice(0, 10) : '');

// 계좌검증 badge(§4)
const VERIF: Record<string, { label: string; color: string; bg: string }> = {
  verified: { label: '검증완료', color: '#047857', bg: '#ecfdf5' },
  missing:  { label: '정보누락', color: '#b45309', bg: '#fffbeb' },
  invalid:  { label: '정보오류', color: '#dc2626', bg: '#fef2f2' },
};
// 지급상태 badge(§12)
const STATUS: Record<string, { label: string; color: string; bg: string }> = {
  pending:   { label: '지급대기',     color: '#6b7280', bg: '#f3f4f6' },
  ready:     { label: '지급준비완료', color: '#1d4ed8', bg: '#eff6ff' },
  paid:      { label: '지급완료',     color: '#047857', bg: '#ecfdf5' },
  failed:    { label: '지급실패',     color: '#dc2626', bg: '#fef2f2' },
  excluded:  { label: '제외',         color: '#9333ea', bg: '#faf5ff' },
  cancelled: { label: '취소',         color: '#dc2626', bg: '#fef2f2' },
};
// 지급 제외 사유(§7) — 기타 선택 시 직접입력.
const EXCLUSION_REASONS = ['계좌정보 확인 중', '차기 지급회차로 이월', '본인 요청', '해외송금 별도 처리', '기타'];

interface Transfer {
  id: number; payeeType: string; payeeId: number | null; payeeName: string | null;
  bankName: string | null; bankAccountMasked: string | null; accountHolder: string | null;
  assignmentCount: number; amount: number;
  verificationStatus: string; status: string; failureReason: string | null; exclusionReason: string | null;
}
interface Summary {
  round: { id: number; batchNumber: string | null; paymentDate: string | null; status: string };
  totalPayees: number; totalAmount: number;
  payable: number; missing: number; invalid: number; excluded: number; paid: number; failed: number;
  fileGate: { canGenerateFile: boolean; activeCount: number; missing: number; invalid: number; notReady: number };
}

interface Props { token: string; round: { id: number; batchNumber?: string | null; paymentDate?: string | null; status: string }; onToast: (m: string) => void; onClose: () => void; }

export default function PayoutExecutionModal({ token, round, onToast, onClose }: Props) {
  const authH = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [summary, setSummary] = useState<Summary | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [excludeFor, setExcludeFor] = useState<Transfer | null>(null);
  const [exclReason, setExclReason] = useState('');
  const isPaid = round.status === 'paid';   // paid = 지급결과 조회 성격(§1) — 변경 액션 비활성

  // ── 팝업 이동(제목 영역 드래그) — 위치 UX 전용. 데이터/API/계산 로직과 무관. ──
  //  · pos=null 이면 중앙(기본). 컴포넌트는 닫힐 때 언마운트되므로 다시 열면 중앙에서 시작.
  //  · 헤더 내부 버튼(X 등)에서는 드래그 시작 안 함 → 닫기/내부 조작 정상.
  //  · 화면 밖으로 완전히 벗어나지 않도록 중심 이동량을 뷰포트 절반 이내로 제한.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ sx: number; sy: number; bx: number; by: number } | null>(null);
  const onDragMove = useCallback((e: MouseEvent) => {
    const d = drag.current; if (!d) return;
    const limX = Math.max(60, window.innerWidth / 2 - 60);
    const limY = Math.max(40, window.innerHeight / 2 - 40);
    const nx = Math.max(-limX, Math.min(limX, d.bx + (e.clientX - d.sx)));
    const ny = Math.max(-limY, Math.min(limY, d.by + (e.clientY - d.sy)));
    setPos({ x: nx, y: ny });
  }, []);
  const onDragEnd = useCallback(() => {
    drag.current = null;
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);
    document.body.style.userSelect = '';
  }, [onDragMove]);
  const onDragStart = (e: React.MouseEvent) => {
    // 버튼(닫기 등) 클릭 시에는 드래그 시작 안 함 — 닫기/내부 조작 보존.
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const base = pos ?? { x: 0, y: 0 };
    drag.current = { sx: e.clientX, sy: e.clientY, bx: base.x, by: base.y };
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
    document.body.style.userSelect = 'none';
  };
  useEffect(() => () => {   // 언마운트 시 리스너·선택방지 정리
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);
    document.body.style.userSelect = '';
  }, [onDragMove, onDragEnd]);

  const applyView = (data: any) => { if (data?.summary) setSummary(data.summary); if (Array.isArray(data?.transfers)) setTransfers(data.transfers); };

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      // confirmed면 송금건이 없을 수 있으므로 생성/동기화(idempotent — 기존건·paid 불변, snapshot 재검증 안 함).
      if (round.status === 'confirmed') {
        await fetch(api(`/api/admin/payout-rounds/${round.id}/transfers/generate`), { method: 'POST', headers: authH }).catch(() => {});
      }
      const res = await fetch(api(`/api/admin/payout-rounds/${round.id}/transfers`), { headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? '지급 송금건 조회 실패'); return; }
      applyView(data);
    } catch { setError('지급 실행 정보 조회 중 오류'); } finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round.id, round.status, token]);

  useEffect(() => { load(); }, [load]);

  // 개별 계좌 재검증(§5)
  const reverifyOne = async (t: Transfer) => {
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/payout-rounds/${round.id}/transfers/${t.id}/reverify`), { method: 'POST', headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? '계좌 재검증 실패'); return; }
      applyView(data);
      const v = data.result?.verificationStatus;
      onToast(v === 'verified' ? `${t.payeeName}: 검증완료 — 계좌정보 갱신됨` : `${t.payeeName}: ${VERIF[v]?.label ?? v} (계좌 확인 필요)`);
    } catch { onToast('계좌 재검증 중 오류'); } finally { setBusy(false); }
  };

  // 전체 재검증(§6) — pending/ready/failed 대상만. 확정금액 불변.
  const reverifyAll = async () => {
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/payout-rounds/${round.id}/transfers/reverify-all`), { method: 'POST', headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? '전체 재검증 실패'); return; }
      applyView(data);
      onToast(`전체 재검증 완료 — ${data.result?.reverified ?? 0}건 검증 (검증완료 ${data.result?.nowVerified ?? 0}건)`);
    } catch { onToast('전체 재검증 중 오류'); } finally { setBusy(false); }
  };

  // 지급 제외(§7) — 사유 필수.
  const submitExclude = async () => {
    if (!excludeFor) return;
    const reason = exclReason.trim();
    if (!reason) { onToast('제외 사유를 입력하세요.'); return; }
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/payout-rounds/${round.id}/transfers/${excludeFor.id}/exclude`), { method: 'POST', headers: authH, body: JSON.stringify({ reason }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? '지급 제외 실패'); return; }
      applyView(data);
      onToast(`${excludeFor.payeeName} 지급 제외 처리됨`);
      setExcludeFor(null); setExclReason('');
    } catch { onToast('지급 제외 중 오류'); } finally { setBusy(false); }
  };

  // 지급 제외 해제(§9)
  const unexclude = async (t: Transfer) => {
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/payout-rounds/${round.id}/transfers/${t.id}/unexclude`), { method: 'POST', headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? '제외 해제 실패'); return; }
      applyView(data);
      onToast(`${t.payeeName} 제외 해제됨`);
    } catch { onToast('제외 해제 중 오류'); } finally { setBusy(false); }
  };

  const th: React.CSSProperties = { ...TYPO.gridHeader, padding: '8px 10px', borderBottom: BD.grid, whiteSpace: 'nowrap', textAlign: 'left', background: C.g50 };
  const td: React.CSSProperties = { ...TYPO.inputValue, padding: '8px 10px', borderBottom: BD.divider, whiteSpace: 'nowrap' };
  const tdR: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
  const badge = (m: { label: string; color: string; bg: string } | undefined, fallback: string) => (
    <span style={{ ...TYPO.helper, fontWeight: 700, color: m?.color ?? C.textSecondary, background: m?.bg ?? C.g100, padding: '3px 9px', borderRadius: 6, display: 'inline-block' }}>{m?.label ?? fallback}</span>
  );
  const gate = summary?.fileGate;

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} data-testid="payout-execution-modal" style={{ background: C.bgCard, borderRadius: 12, boxShadow: '0 12px 44px rgba(0,0,0,0.24)', padding: 22, width: 1160, maxWidth: '97%', maxHeight: '92vh', overflowY: 'auto', transform: pos ? `translate(${pos.x}px, ${pos.y}px)` : undefined }}>
        {/* ── 헤더(드래그 핸들) — 제목 영역을 눌러 팝업 이동. 내부 버튼/닫기에서는 드래그 안 함. ── */}
        <div onMouseDown={onDragStart} data-testid="payout-execution-drag-handle" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, cursor: 'move', userSelect: 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h3 style={{ margin: 0, ...TYPO.sectionTitle }}>지급 실행 — {round.batchNumber || dateVal(round.paymentDate)}</h3>
            {isPaid && <span style={{ ...TYPO.helper, fontWeight: 700, color: STATUS.paid.color, background: STATUS.paid.bg, padding: '3px 9px', borderRadius: 6 }}>지급결과 조회</span>}
          </div>
          <button type="button" onClick={onClose} aria-label="닫기" style={{ border: 'none', background: 'none', fontSize: 20, cursor: 'pointer', color: C.textSecondary, lineHeight: 1 }}>×</button>
        </div>

        {loading ? <p style={{ ...TYPO.helper, padding: 20 }}>불러오는 중…</p>
        : error ? <p style={{ ...TYPO.helper, color: C.danger, padding: 20 }}>{error}</p>
        : summary && (
        <>
          {/* ── 상단 요약(§2) ── */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: SP[4], padding: `${SP[3]}px ${SP[4]}px`, background: C.g50, borderRadius: 10, marginBottom: 12 }}>
            {[
              ['지급예정일', dateVal(round.paymentDate)],
              ['지급대상', `${summary.totalPayees}명`],
              ['총 실지급액', `${won(summary.totalAmount)}원`],
              ['지급가능', `${summary.payable}명`],
              ['정보누락', `${summary.missing}명`],
              ['정보오류', `${summary.invalid}명`],
              ['제외', `${summary.excluded}명`],
              ['지급완료', `${summary.paid}명`],
              ['지급실패', `${summary.failed}명`],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 74 }}>
                <span style={TYPO.helper}>{k}</span>
                <span style={{ ...TYPO.inputValue, fontWeight: 800, color: k === '총 실지급액' ? C.primaryText : C.textPrimary }}>{v}</span>
              </div>
            ))}
          </div>

          {/* ── 송금파일 생성 가능 상태(§10) + 전체 재검증(§6) ── */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <div data-testid="payout-file-gate" style={{ ...TYPO.inputValue, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 8, fontWeight: 700,
              color: gate?.canGenerateFile ? '#047857' : '#b45309', background: gate?.canGenerateFile ? '#ecfdf5' : '#fffbeb', border: `1px solid ${gate?.canGenerateFile ? '#a7f3d0' : '#fde68a'}` }}>
              {gate?.canGenerateFile ? '✅ 송금파일 생성 가능' : '⛔ 송금파일 생성 불가'}
              {!gate?.canGenerateFile && (
                <span style={{ ...TYPO.helper, fontWeight: 600, color: C.textSecondary }}>
                  {[gate?.missing ? `정보누락 ${gate.missing}명` : '', gate?.invalid ? `정보오류 ${gate.invalid}명` : '', gate?.notReady ? `준비안됨 ${gate.notReady}명` : '', (gate && gate.activeCount === 0) ? '대상 없음' : ''].filter(Boolean).join(' · ')}
                </span>
              )}
            </div>
            {!isPaid && <GhostBtn onClick={reverifyAll} disabled={busy} data-testid="payout-reverify-all" style={{ fontSize: 12, padding: '7px 14px' }}>전체 재검증</GhostBtn>}
          </div>

          {/* ── 지급대상 목록(§3) — 1인 1행 ── */}
          <div style={{ overflowX: 'auto', border: BD.grid, borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1080 }}>
              <thead><tr>
                {['지급대상', '은행', '계좌번호', '예금주', '수행건수', '실지급액', '계좌검증', '지급상태', '비고', '작업'].map((h, i) => (
                  <th key={h} style={{ ...th, textAlign: i === 4 || i === 5 ? 'right' : 'left' }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {transfers.length === 0 && <tr><td colSpan={10} style={{ ...td, textAlign: 'center', color: C.textMuted, padding: 20 }}>지급대상이 없습니다.</td></tr>}
                {transfers.map(t => {
                  const isExcluded = t.status === 'excluded';
                  const rowPaid = t.status === 'paid';
                  const note = isExcluded ? t.exclusionReason : t.failureReason;
                  return (
                    <tr key={t.id} data-testid={`payout-transfer-row-${t.id}`} style={{ background: isExcluded ? C.g50 : undefined, opacity: isExcluded ? 0.7 : 1 }}>
                      <td style={{ ...td, fontWeight: 700 }}>{t.payeeName}{t.payeeType === 'vendor' && <span style={{ ...TYPO.helper, color: C.textMuted, marginLeft: 6 }}>외주</span>}</td>
                      <td style={td}>{t.bankName || <span style={{ color: C.textMuted }}>-</span>}</td>
                      <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{t.bankAccountMasked || <span style={{ color: C.textMuted }}>-</span>}</td>
                      <td style={td}>{t.accountHolder || <span style={{ color: C.textMuted }}>-</span>}</td>
                      <td style={tdR}>{t.assignmentCount}건</td>
                      <td style={{ ...tdR, fontWeight: 700 }}>{won(t.amount)}원</td>
                      <td style={td}>{badge(VERIF[t.verificationStatus], t.verificationStatus)}</td>
                      <td style={td}>{badge(STATUS[t.status], t.status)}</td>
                      <td style={{ ...td, whiteSpace: 'normal', maxWidth: 220, ...TYPO.helper, color: C.textSecondary }}>{note || '-'}</td>
                      <td style={td}>
                        {isPaid || rowPaid ? <span style={{ color: C.textMuted }}>-</span>
                          : isExcluded ? (
                            <button type="button" onClick={() => unexclude(t)} disabled={busy} data-testid={`payout-unexclude-${t.id}`}
                              style={{ border: '1px solid #86efac', borderRadius: 6, background: '#f0fdf4', color: '#15803d', cursor: busy ? 'not-allowed' : 'pointer', padding: '4px 10px', fontSize: 11, fontWeight: 700 }}>제외 해제</button>
                          ) : (
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button type="button" onClick={() => reverifyOne(t)} disabled={busy} data-testid={`payout-reverify-${t.id}`}
                                style={{ border: `1px solid ${C.primaryBorder}`, borderRadius: 6, background: C.primaryBg, color: C.primaryText, cursor: busy ? 'not-allowed' : 'pointer', padding: '4px 10px', fontSize: 11, fontWeight: 700 }}>계좌 재검증</button>
                              <button type="button" onClick={() => { setExcludeFor(t); setExclReason(''); }} disabled={busy} data-testid={`payout-exclude-${t.id}`}
                                style={{ border: `1px solid ${C.g300}`, borderRadius: 6, background: C.bgCard, color: C.textSecondary, cursor: busy ? 'not-allowed' : 'pointer', padding: '4px 10px', fontSize: 11, fontWeight: 700 }}>지급 제외</button>
                            </div>
                          )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p style={{ ...TYPO.helper, color: C.textMuted, marginTop: 10 }}>
            ※ 「지급 실행」은 은행 송금 전 지급대상·계좌를 최종 검토·확정하는 화면입니다. 실제 송금 및 IBK 대량이체 파일 생성은 다음 단계에서 진행됩니다. 계좌번호는 보안상 마스킹되어 표시됩니다.
          </p>
        </>
        )}

        {/* ── 지급 제외 사유 입력(§7) — 사유 필수 ── */}
        {excludeFor && (
          <div onClick={() => setExcludeFor(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 9200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
            <div onClick={e => e.stopPropagation()} style={{ background: C.bgCard, borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.2)', padding: 22, width: 460, maxWidth: '100%' }}>
              <h3 style={{ margin: '0 0 12px', ...TYPO.sectionTitle }}>지급 제외 — {excludeFor.payeeName}</h3>
              <p style={{ ...TYPO.helper, margin: '0 0 8px' }}>제외 사유를 선택하거나 입력하세요 (필수). 제외해도 데이터는 삭제되지 않으며 언제든 해제할 수 있습니다.</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {EXCLUSION_REASONS.map(r => (
                  <button key={r} type="button" onClick={() => setExclReason(r === '기타' ? '' : r)}
                    style={{ fontSize: 11, padding: '4px 10px', borderRadius: 14, cursor: 'pointer', border: `1px solid ${exclReason === r ? C.primaryText : C.g300}`, background: exclReason === r ? C.primaryBg : C.bgCard }}>{r}</button>
                ))}
              </div>
              <input style={{ ...dsInputStd(), minHeight: 34, padding: '6px 10px', width: '100%' }} value={exclReason} onChange={e => setExclReason(e.target.value)} placeholder="제외 사유 (필수)" data-testid="payout-exclude-reason" aria-label="지급 제외 사유" />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
                <GhostBtn onClick={() => setExcludeFor(null)} style={{ fontSize: 12, padding: '6px 12px' }}>취소</GhostBtn>
                <PrimaryBtn onClick={submitExclude} disabled={busy || !exclReason.trim()} style={{ fontSize: 12, padding: '6px 14px' }} data-testid="payout-exclude-submit">제외 처리</PrimaryBtn>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
