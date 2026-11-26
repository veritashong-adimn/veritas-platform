// ─────────────────────────────────────────────────────────────────────────────
// 지급 실행(Payment Execution) — 정산 Phase 2.
//  · confirmed/paid 지급회차의 payout_transfers(1인 1송금)를 은행 송금 전 최종 검토·확정하는 화면.
//  · 실제 송금은 하지 않는다. 계좌검증/재검증/제외/제외해제 + 송금파일 생성 가능 여부 계산 + IBK 대량이체 파일 생성(서버).
//  · 금액(amount)은 payout_transfers snapshot 그대로 표시 — 정산 재계산 없음(§2·§14).
//  · 계좌번호는 서버가 마스킹한 값만 수신(전체 계좌번호 미수신, §3·§13).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { formatDisplayDate, formatLabelDates } from '../../lib/dateFormat';
import { api } from '../../lib/constants';
import { PrimaryBtn, GhostBtn, confirmDialog } from '../ui';
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
// 지급실패 사유(2026-11) — 은행 이체 결과 실패. 실패 건은 미지급 유지 → 계좌 재검증 후 재처리.
const FAILURE_REASONS = ['계좌번호 오류', '예금주 불일치', '해지·거래정지 계좌', '은행 처리 오류', '기타'];

interface Transfer {
  id: number; payeeType: string; payeeId: number | null; payeeName: string | null;
  bankName: string | null; bankAccountMasked: string | null; accountHolder: string | null;
  assignmentCount: number; amount: number;
  verificationStatus: string; status: string; failureReason: string | null; exclusionReason: string | null;
  ibkFileGenerated?: boolean;
}
interface Summary {
  round: { id: number; batchNumber: string | null; paymentDate: string | null; status: string };
  totalPayees: number; totalAmount: number;
  payable: number; missing: number; invalid: number; excluded: number; paid: number; failed: number;
  fileGate: { canGenerateFile: boolean; activeCount: number; missing: number; invalid: number; notReady: number };
}

interface Props { token: string; round: { id: number; batchNumber?: string | null; paymentDate?: string | null; status: string }; onToast: (m: string) => void; onClose: () => void;
  /** 송금 실행 권한(payout.transfer) — 없으면 조회 전용(송금건 생성·재검증·제외·은행파일 숨김). 기본 true(기존 동작). */
  canTransfer?: boolean;
  /** 송금 성공 확인 → 지급완료 처리 후 갱신된 회차 상세 전달(상위 화면 반영) */
  onPaid?: (detail: any) => void | Promise<void>; }

const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

export default function PayoutExecutionModal({ token, round, onToast, onClose, canTransfer = true, onPaid }: Props) {
  const authH = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [summary, setSummary] = useState<Summary | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [excludeFor, setExcludeFor] = useState<Transfer | null>(null);
  const [exclReason, setExclReason] = useState('');
  const [failMode, setFailMode] = useState(false);   // true = 사유 입력창을 지급실패 처리용으로 사용
  // 송금 결과 확인(2026-11) — 은행 이체 결과로 '송금 성공'을 확인한 송금건만 지급완료. 송금 대기 자체는 성공이 아니다.
  const [succSel, setSuccSel] = useState<Set<number>>(new Set());
  const [paidDate, setPaidDate] = useState(() => { const due = String(round.paymentDate ?? '').slice(0, 10); const t = kstToday(); return /^\d{4}-\d{2}-\d{2}$/.test(due) && due <= t ? due : t; });
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

  const applyView = (data: any) => {
    if (data?.summary) setSummary(data.summary);
    if (Array.isArray(data?.transfers)) {
      setTransfers(data.transfers);
      // 송금 성공 선택은 지금도 선택 가능한 건(송금 대기 + 송금파일 생성)만 유지
      const ok = new Set<number>(data.transfers.filter((t: Transfer) => t.status === 'ready' && t.ibkFileGenerated).map((t: Transfer) => t.id));
      setSuccSel(prev => new Set([...prev].filter(x => ok.has(x))));
    }
  };

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      // confirmed면 송금건이 없을 수 있으므로 생성/동기화(idempotent — 기존건·paid 불변, snapshot 재검증 안 함).
      if (round.status === 'confirmed' && canTransfer) {
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
    if (!reason) { onToast(failMode ? '지급실패 사유를 입력하세요.' : '제외 사유를 입력하세요.'); return; }
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/payout-rounds/${round.id}/transfers/${excludeFor.id}/${failMode ? 'fail' : 'exclude'}`), { method: 'POST', headers: authH, body: JSON.stringify({ reason }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? (failMode ? '지급실패 처리 실패' : '지급 제외 실패')); return; }
      applyView(data);
      onToast(failMode ? `${excludeFor.payeeName} 지급실패 처리됨 — 미지급 유지, 계좌 재검증 후 재처리하세요` : `${excludeFor.payeeName} 지급 제외 처리됨`);
      setExcludeFor(null); setExclReason('');
    } catch { onToast('지급 제외 중 오류'); } finally { setBusy(false); }
  };

  // IBK 대량이체 파일 생성·다운로드 — 서버가 메모리에서 .xlsx 생성 후 스트림 다운로드.
  //  · 계좌번호 원본은 프론트로 오지 않는다(파일 안에만 존재). 생성 가능 여부는 서버가 최종 판정(fileGate).
  const [genBusy, setGenBusy] = useState(false);
  const generateIbkFile = async () => {
    setGenBusy(true);
    try {
      const res = await fetch(api(`/api/admin/payout-rounds/${round.id}/transfers/ibk-file`), { method: 'POST', headers: authH });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        onToast(data.error ?? 'IBK 대량이체 파일 생성 실패');
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      const fname = m ? decodeURIComponent(m[1]) : `IBK_대량이체_${dateVal(round.paymentDate)}_지급회차.xlsx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      const cnt = res.headers.get('X-Ibk-Count');
      onToast(`IBK 대량이체 파일 생성 완료${cnt ? ` — 지급대상 ${cnt}명` : ''}`);
      load(); // 생성 이력(ibkFileGeneratedAt) 반영
    } catch { onToast('IBK 대량이체 파일 생성 중 오류'); } finally { setGenBusy(false); }
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

  // 송금 성공 확인 → 지급완료 — 선택한 송금건 지급대상의 수행건만 지급완료(서버 /pay successTransferIds). 미선택(결과 미확인)·실패·제외는 미지급 유지.
  const succCandidates = transfers.filter(t => t.status === 'ready' && t.ibkFileGenerated);
  const submitSuccess = async () => {
    if (!succSel.size || busy) return;
    const t = kstToday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidDate) || paidDate > t) { onToast('실제 지급일(이체일)을 오늘 이전 날짜로 입력하세요.'); return; }
    const names = succCandidates.filter(x => succSel.has(x.id)).map(x => x.payeeName ?? `#${x.id}`);
    const rest = succCandidates.length - succSel.size;
    if (!(await confirmDialog({ title: '송금 성공 → 지급완료', variant: 'danger', confirmLabel: '지급완료',
      message: `은행 이체 결과 송금 성공으로 확인한 ${succSel.size}명을 지급완료 처리할까요?\n${names.slice(0, 8).join(', ')}${names.length > 8 ? ` 외 ${names.length - 8}명` : ''}\n실제 지급일 ${paidDate}이 해당 수행건에 기록됩니다.${rest > 0 ? `\n선택하지 않은 송금 대기 ${rest}명은 결과 미확인으로 미지급 유지됩니다.` : ''}\n(지급완료는 되돌릴 수 없습니다)` }))) return;
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/payout-rounds/${round.id}/pay`), { method: 'PATCH', headers: authH, body: JSON.stringify({ actualPaymentDate: paidDate, successTransferIds: [...succSel] }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? '지급완료 처리 실패'); load(); return; }
      const pr = data.payResult;
      onToast(pr?.roundPaid ? `지급완료 처리되었습니다 — 회차 지급완료 (실제 지급일 ${paidDate})`
        : `${pr?.paidPayees ?? succSel.size}명(${pr?.paidAssignments ?? 0}건) 지급완료 — 미지급 ${pr?.remainingUnpaid ?? 0}건 남음(결과 미확인·실패·제외 대상). (실제 지급일 ${paidDate})`);
      setSuccSel(new Set());
      await onPaid?.(data);
      load();
    } catch { onToast('지급완료 처리 중 오류'); } finally { setBusy(false); }
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
            <h3 style={{ margin: 0, ...TYPO.sectionTitle }}>지급 실행 — {formatLabelDates(round.batchNumber) || formatDisplayDate(round.paymentDate)}</h3>
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
              ['지급예정일', formatDisplayDate(round.paymentDate)],
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {!isPaid && canTransfer && <GhostBtn onClick={reverifyAll} disabled={busy || genBusy} data-testid="payout-reverify-all" style={{ fontSize: 12, padding: '7px 14px' }}>전체 재검증</GhostBtn>}
              {canTransfer && <PrimaryBtn
                onClick={generateIbkFile}
                disabled={!gate?.canGenerateFile || busy || genBusy}
                data-testid="payout-ibk-file"
                aria-label="IBK 대량이체 파일 생성"
                style={{ fontSize: 12, padding: '7px 16px' }}
              >
                {genBusy ? '생성 중…' : '📥 IBK 대량이체 파일 생성'}
              </PrimaryBtn>}
            </div>
          </div>

          {/* ── 송금 결과 확인(2026-11) — 송금파일로 이체한 뒤 은행 결과가 '성공'인 지급대상만 체크해 지급완료 ── */}
          {canTransfer && !isPaid && succCandidates.length > 0 && (
            <div data-testid="payout-success-bar" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '9px 12px', marginBottom: 10, border: '1px solid #bfdbfe', background: '#eff6ff', borderRadius: 8 }}>
              <span style={{ ...TYPO.helper, color: '#1e40af', fontWeight: 600, flex: '1 1 320px' }}>
                은행 이체 결과를 확인한 뒤 <b>송금 성공</b>한 지급대상만 체크하세요. 체크하지 않은 송금 대기 건은 결과 미확인으로 미지급 유지되며, 실패 건은 [지급실패]로 기록하세요.
              </span>
              <label style={{ ...TYPO.helper, display: 'flex', alignItems: 'center', gap: 6 }}>실제 지급일
                <input type="date" value={paidDate} max={kstToday()} onChange={e => setPaidDate(e.target.value)} style={{ ...dsInputStd(), minHeight: 30, padding: '3px 8px' }} data-testid="payout-success-date" aria-label="실제 지급일(이체일)" />
              </label>
              <PrimaryBtn onClick={submitSuccess} disabled={busy || succSel.size === 0} style={{ fontSize: 12, padding: '7px 14px' }} data-testid="payout-success-submit" aria-label="송금 성공 지급완료">
                송금 성공 {succSel.size}명 → 지급완료
              </PrimaryBtn>
            </div>
          )}

          {/* ── 지급대상 목록(§3) — 1인 1행 ── */}
          <div style={{ overflowX: 'auto', border: BD.grid, borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1080 }}>
              <thead><tr>
                <th style={{ ...th, width: 64 }}>
                  {canTransfer && !isPaid && succCandidates.length > 0
                    ? <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={succSel.size > 0 && succSel.size === succCandidates.length}
                        onChange={e => setSuccSel(e.target.checked ? new Set(succCandidates.map(t => t.id)) : new Set())} data-testid="payout-success-all" aria-label="송금 성공 전체 선택" />성공</label>
                    : '성공'}
                </th>
                {['지급대상', '은행', '계좌번호', '예금주', '수행건수', '실지급액', '계좌검증', '지급상태', '비고', '작업'].map((h, i) => (
                  <th key={h} style={{ ...th, textAlign: i === 4 || i === 5 ? 'right' : 'left' }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {transfers.length === 0 && <tr><td colSpan={11} style={{ ...td, textAlign: 'center', color: C.textMuted, padding: 20 }}>지급대상이 없습니다.</td></tr>}
                {transfers.map(t => {
                  const isExcluded = t.status === 'excluded';
                  const rowPaid = t.status === 'paid';
                  const note = isExcluded ? t.exclusionReason : t.failureReason;
                  return (
                    <tr key={t.id} data-testid={`payout-transfer-row-${t.id}`} style={{ background: isExcluded ? C.g50 : undefined, opacity: isExcluded ? 0.7 : 1 }}>
                      <td style={td}>
                        {canTransfer && !isPaid && t.status === 'ready' && t.ibkFileGenerated
                          ? <input type="checkbox" checked={succSel.has(t.id)} onChange={() => setSuccSel(prev => { const n = new Set(prev); n.has(t.id) ? n.delete(t.id) : n.add(t.id); return n; })}
                              data-testid={`payout-success-${t.id}`} aria-label={`${t.payeeName ?? ''} 송금 성공 확인`} />
                          : <span style={{ color: C.textMuted }}>-</span>}
                      </td>
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
                        {isPaid || rowPaid || !canTransfer ? <span style={{ color: C.textMuted }}>-</span>
                          : isExcluded ? (
                            <button type="button" onClick={() => unexclude(t)} disabled={busy} data-testid={`payout-unexclude-${t.id}`}
                              style={{ border: '1px solid #86efac', borderRadius: 6, background: '#f0fdf4', color: '#15803d', cursor: busy ? 'not-allowed' : 'pointer', padding: '4px 10px', fontSize: 11, fontWeight: 700 }}>제외 해제</button>
                          ) : (
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button type="button" onClick={() => reverifyOne(t)} disabled={busy} data-testid={`payout-reverify-${t.id}`}
                                style={{ border: `1px solid ${C.primaryBorder}`, borderRadius: 6, background: C.primaryBg, color: C.primaryText, cursor: busy ? 'not-allowed' : 'pointer', padding: '4px 10px', fontSize: 11, fontWeight: 700 }}>계좌 재검증</button>
                              {t.status === 'ready' && t.ibkFileGenerated && (
                                <button type="button" onClick={() => { setFailMode(true); setExcludeFor(t); setExclReason(''); }} disabled={busy} data-testid={`payout-fail-${t.id}`} aria-label={`${t.payeeName ?? ''} 지급실패 처리`}
                                  style={{ border: '1px solid #fca5a5', borderRadius: 6, background: '#fef2f2', color: '#dc2626', cursor: busy ? 'not-allowed' : 'pointer', padding: '4px 10px', fontSize: 11, fontWeight: 700 }}>지급실패</button>
                              )}
                              <button type="button" onClick={() => { setFailMode(false); setExcludeFor(t); setExclReason(''); }} disabled={busy} data-testid={`payout-exclude-${t.id}`}
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
            ※ 「지급 실행」은 은행 송금 전 지급대상·계좌를 최종 검토·확정하는 화면입니다. 송금 가능 상태가 되면 위 [IBK 대량이체 파일 생성]으로 은행 업로드 파일을 받고, 실제 이체는 은행에서 진행합니다. 계좌번호는 보안상 마스킹되어 표시됩니다.
          </p>
        </>
        )}

        {/* ── 지급 제외 사유 입력(§7) — 사유 필수 ── */}
        {excludeFor && (
          <div onClick={() => setExcludeFor(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 9200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
            <div onClick={e => e.stopPropagation()} style={{ background: C.bgCard, borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.2)', padding: 22, width: 460, maxWidth: '100%' }}>
              <h3 style={{ margin: '0 0 12px', ...TYPO.sectionTitle }}>{failMode ? '지급실패' : '지급 제외'} — {excludeFor.payeeName}</h3>
              <p style={{ ...TYPO.helper, margin: '0 0 8px' }}>{failMode
                ? '은행 이체가 실패한 경우 사유를 선택하거나 입력하세요 (필수). 이 지급대상의 수행건은 미지급으로 유지되며, 계좌 재검증 후 송금파일을 다시 만들어 재처리할 수 있습니다(이미 지급완료된 대상은 다시 포함되지 않음).'
                : '제외 사유를 선택하거나 입력하세요 (필수). 제외해도 데이터는 삭제되지 않으며 언제든 해제할 수 있습니다. 제외된 지급대상의 수행건은 회차 지급완료 시 지급완료로 바뀌지 않습니다.'}</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {(failMode ? FAILURE_REASONS : EXCLUSION_REASONS).map(r => (
                  <button key={r} type="button" onClick={() => setExclReason(r === '기타' ? '' : r)}
                    style={{ fontSize: 11, padding: '4px 10px', borderRadius: 14, cursor: 'pointer', border: `1px solid ${exclReason === r ? C.primaryText : C.g300}`, background: exclReason === r ? C.primaryBg : C.bgCard }}>{r}</button>
                ))}
              </div>
              <input style={{ ...dsInputStd(), minHeight: 34, padding: '6px 10px', width: '100%' }} value={exclReason} onChange={e => setExclReason(e.target.value)} placeholder={failMode ? '지급실패 사유 (필수)' : '제외 사유 (필수)'} data-testid="payout-exclude-reason" aria-label={failMode ? '지급실패 사유' : '지급 제외 사유'} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
                <GhostBtn onClick={() => setExcludeFor(null)} style={{ fontSize: 12, padding: '6px 12px' }}>취소</GhostBtn>
                <PrimaryBtn onClick={submitExclude} disabled={busy || !exclReason.trim()} style={{ fontSize: 12, padding: '6px 14px' }} data-testid="payout-exclude-submit" aria-label={failMode ? '지급실패 처리' : '제외 처리'}>{failMode ? '지급실패 처리' : '제외 처리'}</PrimaryBtn>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
