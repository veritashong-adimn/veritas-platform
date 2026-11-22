// ─── 지급 준비 점검 · 지급 누락 방지(통합 지급회차관리 상단) — 조회·출력 전용 ─────────────────────────
//   GET /admin/payout-unified/readiness?date=&scope=date|all
//   ① 지급일 기준: 그 지급일 지급 후보(기본 후보) + 누락 방지 교차조회(납품기간 납품·지급일 경과 이월·지급예정일 없음)
//   ② 전체 기간: 지급 누락·날짜 공란·확인필요 전체
//   플랫폼·과거 CRM 전환·CRM 원본 통합. A 지급 준비 완료 / B 계좌 / C 금액·세금·수행정보·날짜 / D 과거 지급 여부·중복.
//   한 건의 모든 사유·필요한 조치 표시. 지급상태·금액·날짜·회차를 바꾸지 않는다(처리는 기존 화면).
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/constants';
import { exportDataset } from '../../lib/excelExport';
import { DateField } from './DatePickerShared';

type Blocker = { cat: 'B' | 'C' | 'D' | 'I'; code: string; text: string; action: string };
type Item = {
  source: string; kind: 'platform' | 'crm_converted' | 'crm_only'; sourceKey: string; crmRowId: number | null; assignmentId: number | null;
  projectId: number | null; projectTitle: string | null; saleNo: string | null; quoteNumber: string | null; payee: string | null; client: string | null;
  deliveryDate: string | null; payoutDate: string | null; actualPaymentDate: string | null;
  dateMismatch?: boolean;   // CRM·플랫폼 날짜 불일치(덮어쓰지 않음 — 사유에 상세)
  pretax: number; withholding: number; posttax: number;
  paymentStatus: string; payoutRoundId: number | null; hasAccount: boolean; roundEligible: boolean; candidate: string; countedInTotals: boolean;
  state: 'A' | 'B' | 'C' | 'D'; stateLabel: string; blockers: Blocker[]; actions: string[];
};
type Sum = { count: number; counted: number; pretax: number; posttax: number };
type Resp = { scope: 'date' | 'all'; payoutDate: string | null; deliveryWindow: { from: string; to: string } | null; items: Item[];
  summary: { total: Sum; byState: Record<string, Sum>; byKind: Record<string, Sum>; byCandidate: Record<string, Sum>; roundEligible: Sum; duplicates: number; issueCounts: Record<string, number> } };

const STATE_STYLE: Record<string, { bg: string; c: string }> = {
  A: { bg: '#dcfce7', c: '#15803d' }, B: { bg: '#e0f2fe', c: '#0369a1' }, C: { bg: '#fef3c7', c: '#92400e' }, D: { bg: '#fee2e2', c: '#b91c1c' }, I: { bg: '#f1f5f9', c: '#475569' },
};
const STATE_LABEL: Record<string, string> = { A: '지급 준비 완료', B: '계좌정보 확인 필요', C: '금액·세금·수행정보 확인 필요', D: '과거 지급 여부·중복 확인 필요' };
const KIND_LABEL: Record<string, string> = { platform: '플랫폼', crm_converted: 'CRM 전환', crm_only: 'CRM 원본' };
const CAND_LABEL: Record<string, string> = { base: '지급 후보(지급일 일치)', delivery_window: '추가: 납품기간 납품', carry_over: '추가: 지급일 경과(이월)', no_payout_date: '추가: 지급예정일 없음', other: '추가: 기타', all: '전체 기간' };
const STATUS_LABEL: Record<string, string> = { unpaid: '미지급', payment_hold: '지급보류', paid: '지급완료', unconfirmed: '확인 전(CRM)' };
const won = (n: number) => Math.round(n || 0).toLocaleString('ko-KR');
/** 다음 지급일(1~15일 → 그달 15일 / 16일~ → 그달 말일, KST) — 기본 조회 지급일 */
export function nextPayoutDate(): string {
  const t = new Date(Date.now() + 9 * 3600 * 1000); const y = t.getUTCFullYear(), m = t.getUTCMonth(), d = t.getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return d <= 15 ? `${y}-${pad(m + 1)}-15` : `${y}-${pad(m + 1)}-${pad(new Date(Date.UTC(y, m + 1, 0)).getUTCDate())}`;
}

export function PayoutReadinessPanel({ token, payoutDate: propDate, onToast }: { token: string; payoutDate?: string | null; onToast: (m: string) => void }) {
  const [scope, setScope] = useState<'date' | 'all'>('date');
  const [date, setDate] = useState<string>(propDate || nextPayoutDate());
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<string>('all');
  const [kind, setKind] = useState<string>('all');
  const [cand, setCand] = useState<string>('all');
  const [q, setQ] = useState('');
  useEffect(() => { if (propDate) setDate(propDate); }, [propDate]);

  useEffect(() => {
    let alive = true; setData(null); setErr(null);
    if (!open || (scope === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(date))) return;
    setLoading(true);
    fetch(api(`/api/admin/payout-unified/readiness?scope=${scope}${scope === 'date' ? `&date=${date}` : ''}`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async r => { const d = await r.json().catch(() => null); if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`); return d; })
      .then(d => { if (alive) setData(d); })
      .catch(e => { if (alive) setErr(e.message || '지급 준비 점검 조회 실패'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, scope, date, token]);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data?.items ?? []).filter(i => (state === 'all' || i.state === state) && (kind === 'all' || i.kind === kind) && (cand === 'all' || i.candidate === cand)
      && (!s || [i.payee, i.client, i.saleNo, i.quoteNumber, i.projectTitle, i.sourceKey, String(i.crmRowId ?? ''), String(i.projectId ?? '')].some(v => String(v ?? '').toLowerCase().includes(s))));
  }, [data, state, kind, cand, q]);

  const exportExcel = () => {
    exportDataset<Item>({
      filename: scope === 'date' ? `지급준비점검_${date}.xlsx` : `지급누락점검_전체기간.xlsx`, sheetName: scope === 'date' ? '지급준비점검' : '지급누락점검',
      columns: [
        { header: '상태', value: (r) => `${r.state} ${r.stateLabel}`, width: 22 },
        { header: '후보 구분', value: (r) => CAND_LABEL[r.candidate] ?? r.candidate, width: 20 },
        { header: '출처', value: (r) => KIND_LABEL[r.kind] ?? r.kind, width: 9 },
        { header: '원본키', value: 'sourceKey', width: 15 },
        { header: '거래처', value: (r) => r.client ?? '', width: 22 },
        { header: '판매번호', value: (r) => r.saleNo ?? r.quoteNumber ?? '', width: 16 },
        { header: '프로젝트', value: (r) => r.projectTitle ?? '', width: 22 },
        { header: '판매ID', value: (r) => r.projectId ?? '', type: 'number', numFmt: '0', width: 8 },
        { header: '수행정보ID', value: (r) => r.assignmentId ?? '', type: 'number', numFmt: '0', width: 9 },
        { header: 'CRM행ID', value: (r) => r.crmRowId ?? '', type: 'number', numFmt: '0', width: 9 },
        { header: '통번역사·외주업체', value: (r) => r.payee ?? '', width: 16 },
        { header: '납품일', value: (r) => r.deliveryDate ?? '', width: 11 },
        { header: '지급예정일', value: (r) => r.payoutDate ?? '', width: 11 },
        { header: '실제 지급일', value: (r) => r.actualPaymentDate ?? '', width: 11 },
        { header: '날짜 불일치', value: (r) => (r.dateMismatch ? 'CRM·플랫폼 불일치' : ''), width: 14 },
        { header: '세전', value: 'pretax', type: 'number', width: 12 },
        { header: '원천세', value: 'withholding', type: 'number', width: 10 },
        { header: '세후', value: 'posttax', type: 'number', width: 12 },
        { header: '합계 집계', value: (r) => (r.countedInTotals ? '예' : '아니오(중복)'), width: 9 },
        { header: '지급상태', value: (r) => STATUS_LABEL[r.paymentStatus] ?? r.paymentStatus, width: 11 },
        { header: '지급회차', value: (r) => r.payoutRoundId ?? '', width: 8 },
        { header: '계좌', value: (r) => (r.hasAccount ? '등록' : '미등록'), width: 7 },
        { header: '공식 회차 자동포함', value: (r) => (r.roundEligible ? '예' : '아니오'), width: 10 },
        { header: '누락·확인필요 사유', value: (r) => r.blockers.map(b => `[${b.cat === 'I' ? '참고' : b.cat}] ${b.text}`).join(' / '), width: 80 },
        { header: '필요한 조치', value: (r) => r.actions.join(' / '), width: 60 },
      ],
      rows,
    });
    onToast(`${rows.length}건을 Excel로 내보냈습니다.`);
  };

  const chip = (k: string, s?: Sum) => (
    <button key={k} type="button" data-testid={`ready-chip-${k}`} onClick={() => setState(state === k ? 'all' : k)}
      style={{ border: `1px solid ${state === k ? '#334155' : '#e5e7eb'}`, borderRadius: 8, padding: '6px 10px', background: STATE_STYLE[k]?.bg ?? '#f8fafc', cursor: 'pointer', textAlign: 'left' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: STATE_STYLE[k]?.c ?? '#334155' }}>{k} {STATE_LABEL[k]}</div>
      <div style={{ fontSize: 13, fontWeight: 800, color: '#111827', fontVariantNumeric: 'tabular-nums' }}>{s?.count ?? 0}건 · {won(s?.pretax ?? 0)}원</div>
    </button>
  );
  const tabBtn = (k: 'date' | 'all', label: string) => (
    <button type="button" onClick={() => { setScope(k); setCand('all'); }} data-testid={`ready-scope-${k}`} aria-pressed={scope === k}
      style={{ border: '1px solid #cbd5e1', borderRadius: 7, padding: '5px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer', background: scope === k ? '#0f172a' : '#fff', color: scope === k ? '#fff' : '#334155' }}>{label}</button>
  );
  const th: React.CSSProperties = { padding: '6px 8px', fontSize: 11.5, color: '#475569', textAlign: 'left', whiteSpace: 'nowrap', background: '#f3f4f6' };
  const td: React.CSSProperties = { padding: '6px 8px', fontSize: 12, borderTop: '1px solid #f1f5f9', whiteSpace: 'nowrap', verticalAlign: 'top' };
  const sel: React.CSSProperties = { fontSize: 12, padding: '4px 6px' };

  return (
    <div data-testid="payout-readiness" style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 12px', marginBottom: 16, background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13.5, fontWeight: 800, color: '#111827' }}>
          지급 준비 점검 · 지급 누락 방지 <span style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af' }}>· 플랫폼 + 과거 CRM 전환 + CRM 원본 통합 · 조회 전용(지급상태·금액·날짜 불변)</span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {open && tabBtn('date', '① 지급일 기준 후보')}
          {open && tabBtn('all', '② 전체 기간 누락·공란')}
          {open && scope === 'date' && <DateField value={date} onChange={v => v && setDate(v)} style={{ fontSize: 12, padding: '4px 6px', width: 130, border: '1px solid #cbd5e1', borderRadius: 6 }} testid="ready-date" ariaLabel="지급일" allowClear={false} />}
          {open && data && <button type="button" onClick={exportExcel} data-testid="ready-excel" aria-label="지급 준비 점검 Excel"
            style={{ border: 'none', borderRadius: 7, padding: '5px 10px', background: '#059669', color: '#fff', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>Excel</button>}
          <button type="button" onClick={() => setOpen(o => !o)} data-testid="ready-toggle" aria-expanded={open} aria-label="지급 준비 점검 열기"
            style={{ border: '1px solid #cbd5e1', borderRadius: 7, padding: '5px 10px', background: open ? '#0369a1' : '#fff', color: open ? '#fff' : '#334155', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
            {open ? '접기' : '점검 열기'}</button>
        </div>
      </div>
      {open && (
        <div style={{ marginTop: 10 }}>
          {loading && <div data-testid="ready-loading" style={{ fontSize: 12, color: '#6b7280' }}>조회 중…(전체 자료 대조로 수 초 걸릴 수 있습니다)</div>}
          {err && <div data-testid="ready-error" style={{ fontSize: 12, color: '#b91c1c', fontWeight: 700 }}>{err}</div>}
          {data && (
            <>
              <div data-testid="ready-scope-note" style={{ fontSize: 11.5, color: '#475569', marginBottom: 6 }}>
                {data.scope === 'date'
                  ? <>① <b>{data.payoutDate} 지급</b> — 지급 후보(지급일 일치) + 누락 방지 추가 확인(납품기간 {data.deliveryWindow?.from}~{data.deliveryWindow?.to} 납품, 지급일 경과 이월, 지급예정일 없음). 추가 확인 건은 송금 대상으로 자동 확정되지 않습니다.</>
                  : <>② <b>전체 기간</b> — 지급완료가 아닌 모든 지급행, 지급완료인데 실제 지급일 없는 건, 납품일·지급예정일 공란 건.</>}
                {data.summary.duplicates > 0 && <span style={{ color: '#b91c1c', fontWeight: 700 }}> · 중복 지급 후보 {data.summary.duplicates}건(합계 1회 집계)</span>}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }} data-testid="ready-summary">
                {(['A', 'B', 'C', 'D'] as const).map(k => chip(k, data.summary.byState[k]))}
                <div style={{ fontSize: 11.5, color: '#475569', alignSelf: 'center', lineHeight: 1.6 }}>
                  전체 <b data-testid="ready-total">{data.summary.total.count}건 · {won(data.summary.total.pretax)}원</b>
                  {' · '}공식 회차 자동포함 <b data-testid="ready-round-eligible">{data.summary.roundEligible.count}건 · {won(data.summary.roundEligible.pretax)}원</b><br />
                  {data.scope === 'date' && Object.entries(data.summary.byCandidate).map(([k, v]) => <span key={k} data-testid={`ready-cand-${k}`} style={{ marginRight: 10 }}>{CAND_LABEL[k] ?? k} {v.count}건·{won(v.pretax)}원</span>)}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="수취인·거래처·판매번호·프로젝트·CRM행 검색" data-testid="ready-search" aria-label="지급 점검 검색"
                  style={{ fontSize: 12, padding: '4px 8px', minWidth: 260, border: '1px solid #cbd5e1', borderRadius: 6 }} />
                <select value={state} onChange={e => setState(e.target.value)} data-testid="ready-filter-state" aria-label="상태 필터" style={sel}>
                  <option value="all">전체 상태</option>{(['A', 'B', 'C', 'D'] as const).map(k => <option key={k} value={k}>{k} {STATE_LABEL[k]}</option>)}
                </select>
                <select value={kind} onChange={e => setKind(e.target.value)} data-testid="ready-filter-kind" aria-label="출처 필터" style={sel}>
                  <option value="all">전체 출처</option><option value="platform">플랫폼</option><option value="crm_converted">CRM 전환</option><option value="crm_only">CRM 원본</option>
                </select>
                {data.scope === 'date' && <select value={cand} onChange={e => setCand(e.target.value)} data-testid="ready-filter-cand" aria-label="후보 구분 필터" style={sel}>
                  <option value="all">전체 후보</option>{Object.keys(data.summary.byCandidate).map(k => <option key={k} value={k}>{CAND_LABEL[k] ?? k}</option>)}
                </select>}
                <span data-testid="ready-filtered-count" style={{ fontSize: 12, color: '#475569' }}>{rows.length}건</span>
              </div>
              <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 8, maxHeight: 640, overflowY: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <thead style={{ position: 'sticky', top: 0 }}><tr>{['상태', '후보', '출처', '거래처', '판매번호·프로젝트', 'CRM행', '통번역사·외주업체', '납품일', '지급예정일', '실제 지급일', '세전', '세후', '지급상태', '회차', '계좌', '누락·확인필요 사유', '필요한 조치'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.sourceKey} data-testid={`ready-row-${r.sourceKey}`} data-state={r.state} data-candidate={r.candidate} style={r.countedInTotals ? undefined : { background: '#fff7ed' }}>
                        <td style={td}><span style={{ fontSize: 11, fontWeight: 700, padding: '1px 7px', borderRadius: 7, background: STATE_STYLE[r.state].bg, color: STATE_STYLE[r.state].c }}>{r.state}</span></td>
                        <td style={{ ...td, fontSize: 11, color: r.candidate === 'base' || r.candidate === 'all' ? '#334155' : '#b45309' }}>{CAND_LABEL[r.candidate] ?? r.candidate}</td>
                        <td style={td}>{KIND_LABEL[r.kind]}</td>
                        <td style={{ ...td, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.client ?? ''}>{r.client ?? '—'}</td>
                        <td style={{ ...td, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.projectTitle ?? ''}>{r.saleNo ?? r.quoteNumber ?? (r.projectId ? `#${r.projectId}` : '—')}{r.projectTitle ? <div style={{ fontSize: 10.5, color: '#94a3b8' }}>{r.projectTitle}</div> : null}</td>
                        <td style={{ ...td, color: '#64748b' }}>{r.crmRowId ?? '—'}</td>
                        <td style={{ ...td, fontWeight: 700 }}>{r.payee ?? '—'}</td>
                        <td style={{ ...td, color: r.deliveryDate ? undefined : '#b91c1c' }}>{r.deliveryDate ?? '공란'}
                          {r.dateMismatch && <span title="CRM·플랫폼 날짜 불일치 — 사유 참고" aria-label="날짜 불일치" data-testid={`ready-date-mismatch-${r.sourceKey}`} style={{ marginLeft: 4, color: '#c2410c', fontWeight: 700 }}>⚠</span>}</td>
                        <td style={{ ...td, color: r.payoutDate ? undefined : '#b91c1c' }}>{r.payoutDate ?? '공란'}</td>
                        <td style={td}>{r.actualPaymentDate ?? '—'}</td>
                        <td style={{ ...td, textAlign: 'right' }}>{won(r.pretax)}</td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{won(r.posttax)}{!r.countedInTotals && <div style={{ fontSize: 10, color: '#c2410c' }}>합계 제외(중복)</div>}</td>
                        <td style={td}>{STATUS_LABEL[r.paymentStatus] ?? r.paymentStatus}</td>
                        <td style={td}>{r.payoutRoundId ? `#${r.payoutRoundId}` : '—'}</td>
                        <td style={{ ...td, color: r.hasAccount ? '#15803d' : '#b91c1c' }}>{r.hasAccount ? '등록' : '미등록'}</td>
                        <td style={{ ...td, whiteSpace: 'normal', minWidth: 260, fontSize: 11.5 }}>
                          {r.blockers.length === 0 ? <span style={{ color: '#15803d' }}>없음</span>
                            : r.blockers.map((b, i) => <div key={i}><b style={{ color: STATE_STYLE[b.cat].c }}>[{b.cat === 'I' ? '참고' : b.cat}]</b> {b.text}</div>)}
                        </td>
                        <td style={{ ...td, whiteSpace: 'normal', minWidth: 220, fontSize: 11.5, color: '#334155' }}>{r.actions.length ? r.actions.map((a, i) => <div key={i}>· {a}</div>) : '—'}</td>
                      </tr>
                    ))}
                    {rows.length === 0 && <tr><td colSpan={17} style={{ ...td, textAlign: 'center', color: '#9ca3af', padding: 18 }}>해당 건이 없습니다.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default PayoutReadinessPanel;
