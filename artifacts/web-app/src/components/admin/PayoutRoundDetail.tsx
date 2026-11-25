// ─────────────────────────────────────────────────────────────────────────────
// 지급회차 상세 — 지급회차 목록(PayoutUnifiedTab)에서 지급일을 클릭하면 열리는 화면.
//  · 상단: 지급일·지급금액 요약(선택 지급일 전체 — 목록의 거래처·통번역사·출처 필터와 무관).
//  · 탭 4개가 같은 지급일을 공유: 지급준비점검 · 지급대상별 요약 · 건별 상세내역 · 지급확정·은행이체.
//  · 데이터 구분(혼합 금지):
//      통합 조회 = /admin/payout-unified/payees(과거 CRM + 신규 플랫폼, 조회 전용 — 탭 1~3)
//      운영 지급 = /admin/payout-rounds(신규 플랫폼 수행정보만, 생성·확정·지급 실행·IBK·지급완료 — 탭 4, 기존 PayoutRoundsTab 재사용)
//  · 계산·저장 로직 없음. 서버가 내려준 값만 표시·합산한다.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/constants';
import { exportReproStatementExcel, exportReproStatementPdf, reproPayeeLanguages } from '../../lib/payoutReproStatement';
import { ConversionCell, type ConversionInfo } from './LegacyPayoutConversion';
import { PayoutReadinessPanel } from './PayoutReadinessPanel';
import PayoutRoundsTab, { CreateDialog, type PayoutPerms } from './PayoutRoundsTab';
import { BackToListButton } from './BackToListButton';
import './readTableView.css';

// ── 통합 조회 공용 타입·표시 헬퍼(목록 PayoutUnifiedTab 과 공유) ──
export type StatusCounts = { paid: number; unpaid: number; scheduled: number; review: number };
export type RoundRow = {
  payoutDate: string | null; label: string;
  assignmentCount: number; legacyCount: number; currentCount: number;
  pretaxTotal: number; posttaxTotal: number; withholdingImplied: number; withholdingRecalc: number;
  vatTotal?: number;   // 외주업체 부가세 합계(원천세와 분리, 2026-11-23)
  paidTotal: number; unpaidTotal: number; needReviewCount: number; excludedCount: number;
  scheduledCount?: number; scheduledTotal?: number;
  statusCounts?: StatusCounts;   // 지급상태 4분류 건수(지급완료·미지급·지급예정·확인필요, 합계 = 수행건수)
  opOnly?: boolean;              // 통합 조회에는 없고 운영 지급회차만 있는 지급일(목록 표시용)
};
export type DetailRow = {
  source: 'legacy' | 'current'; sourceKey: string; id: number;
  deliveryDate: string | null; payoutDate: string | null; client: string | null;
  translator: string | null; residentMasked: string | null; language: string | null;
  masterEmail: string | null; masterPhone: string | null; originalPhone: string | null;
  matchStatus: string; matchedUserId: number | null; masterKey: string; confirmed: boolean;
  content: string | null; filename: string | null; pretax: number; posttax: number; withholdingImplied: number;
  payeeType?: 'individual' | 'vendor'; vat?: number | null; taxConflict?: string | null;
  status: 'paid' | 'scheduled' | 'pending' | 'deposit_unconfirmed' | 'excluded' | 'dup_suspect'; statusLabel: string; dupSuspect: boolean;
  paidBasis: string | null;
  conversion?: ConversionInfo; conversionEligible?: boolean;
  languageSource?: 'original' | 'master' | null; masterLanguages?: string | null;
  payCurrency?: string | null; foreignAmount?: number | null;   // 외화 지급(원화 합계와 별도)
  withholdingTreatment?: string | null; withholdingRate?: number | null;   // 수행정보 세금처리 유형(명세서 표기용)
};
export type PayeeGroup = {
  masterKey: string; name: string; confirmed: boolean; matchStatus: string; matchedUserId: number | null;
  email: string | null; phone: string | null; count: number; languages: string[];
  pretaxTotal: number; posttaxTotal: number; withholdingImplied: number; payeeType?: 'individual' | 'vendor'; vatTotal?: number;
  paidPretax: number; unpaidPretax: number; paidCount: number; unpaidCount: number; needReviewCount: number; dupSuspectCount: number; sources: string[];
  scheduledCount?: number;
  foreignTotals?: { currency: string; count: number; amount: number; missing: number }[];
};
// 지급상태 — 실제 '지급' 여부만(검증상태와 분리).
export const STATUS_META: Record<string, { label: string; bg: string; fg: string }> = {
  paid: { label: '지급완료', bg: '#eff6ff', fg: '#1d4ed8' },
  pending: { label: '지급대기', bg: '#fffbeb', fg: '#b45309' },
  scheduled: { label: '지급예정', bg: '#ecfdf5', fg: '#047857' },
  deposit_unconfirmed: { label: '지급확인 필요', bg: '#fef3c7', fg: '#92400e' },
  dup_suspect: { label: '중복 의심', bg: '#fef2f2', fg: '#dc2626' },
  excluded: { label: '지급 제외', bg: '#f1f5f9', fg: '#475569' },
};
export const STATUS_OPTS: [string, string][] = [['all', '전체'], ['paid', '지급완료'], ['scheduled', '지급예정'], ['pending', '지급대기'], ['deposit_unconfirmed', '지급확인 필요'], ['dup_suspect', '중복 의심'], ['excluded', '지급 제외']];
export const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export const won = (n: number | null | undefined) => (n == null ? '-' : Math.round(Number(n)).toLocaleString());
export const td: React.CSSProperties = { padding: '8px 12px', fontSize: 13, color: '#374151', whiteSpace: 'nowrap' };
export const tdR: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
export const sc = (r: { statusCounts?: StatusCounts; scheduledCount?: number; needReviewCount?: number }): StatusCounts =>
  r.statusCounts ?? { paid: 0, unpaid: 0, scheduled: num(r.scheduledCount), review: num(r.needReviewCount) };
// 운영 지급회차 상태 라벨(PayoutRoundsTab ROUND_STATUS 와 같은 값)
export const OP_STATUS: Record<string, { label: string; color: string; bg: string }> = {
  draft: { label: '작성중', color: '#b45309', bg: '#fffbeb' }, reviewing: { label: '검토중', color: '#b45309', bg: '#fffbeb' },
  confirmed: { label: '지급확정', color: '#1d4ed8', bg: '#eff6ff' }, paid: { label: '지급완료', color: '#047857', bg: '#ecfdf5' },
  cancelled: { label: '취소', color: '#6b7280', bg: '#f3f4f6' },
};
const ACTIVE_OP = ['draft', 'reviewing', 'confirmed'];
export type OpRound = { id: number; batchNumber: string | null; paymentDate: string; status: string; totalAssignments?: number | null; netAmount?: string | number | null; collectionBasis?: string | null; periodStart?: string | null; periodEnd?: string | null };
export const opDate = (r: OpRound) => String(r.paymentDate ?? '').slice(0, 10);
// 상태별 묶음(진행 중 → 완료 → 취소 순) — 같은 지급일에 회차가 여러 개일 때 배지를 상태별 건수로 표시
export const opStatusGroups = (rs: OpRound[]): [string, number][] => {
  const order = ['draft', 'reviewing', 'confirmed', 'paid', 'cancelled'];
  const m = new Map<string, number>(); for (const r of rs) m.set(r.status, (m.get(r.status) ?? 0) + 1);
  return [...m].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
};

// 통번역사·언어·이메일·연락처·건수·세전·원천세공제·실지급·지급상태·출력
const STMT_COLS = 'minmax(96px,1fr) minmax(64px,0.7fr) minmax(140px,1.3fr) 118px 48px 104px 104px 104px minmax(104px,auto) 128px';
function pickPhone(rows: DetailRow[]): string | null {
  const conf = new Set(rows.filter(r => r.matchStatus === 'confirmed' && r.masterPhone).map(r => r.masterPhone as string));
  if (conf.size === 1) return [...conf][0]; if (conf.size > 1) return null;
  const orig = new Set(rows.filter(r => r.originalPhone).map(r => r.originalPhone as string));
  return orig.size === 1 ? [...orig][0] : null;
}

type TabKey = 'readiness' | 'payees' | 'items' | 'operational';

interface Props {
  token: string; onToast: (m: string) => void;
  payoutDate: string | null;          // 선택 지급일(null = 지급일 미확인)
  opRounds: OpRound[];                // 이 지급일의 운영 지급회차(0..N, 취소 포함)
  reloadOpRounds: () => void;         // 운영 회차 생성·상태 변경 후 목록 재조회
  canOps: boolean;                    // menu.payout_ops — 지급확정·은행이체 탭
  payoutPerms?: PayoutPerms;
  initialTab?: TabKey;
  onBack: () => void;
}

export function PayoutRoundDetail({ token, onToast, payoutDate, opRounds, reloadOpRounds, canOps, payoutPerms, initialTab, onBack }: Props) {
  const authH = { Authorization: `Bearer ${token}` };
  const [tab, setTab] = useState<TabKey>(initialTab ?? 'readiness');
  const [items, setItems] = useState<DetailRow[]>([]);
  const [payees, setPayees] = useState<PayeeGroup[]>([]);
  const [totals, setTotals] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [selPayee, setSelPayee] = useState<string>('__all__');   // 건별 상세 — 통번역사 선택('__all__' = 전체)
  const [itemStatus, setItemStatus] = useState('all');           // 건별 상세 — 지급상태 필터(화면 내 필터)

  // 선택 지급일 전체(목록 필터 미적용) — 통합 조회 상세 API 를 지급일만으로 호출.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams(); p.set('date', payoutDate ?? 'none'); p.set('basis', 'payout');
      const r = await fetch(api(`/api/admin/payout-unified/payees?${p}`), { headers: authH });
      const d = await r.json(); if (!r.ok) throw new Error(d?.error || '조회 실패');
      setItems(d.items ?? []); setPayees(d.payees ?? []); setTotals(d.totals ?? null);
    } catch (e: any) { onToast(e?.message || '지급회차 상세 조회 실패'); } finally { setLoading(false); }
  }, [token, payoutDate]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);

  const label = payoutDate ? `${payoutDate} 지급` : '지급일 미확인';
  const stc = totals ? sc(totals) : { paid: 0, unpaid: 0, scheduled: 0, review: 0 };
  const summary: [string, string, string?][] = totals ? [
    ['지급대상', `${num(totals.payeeCount)}명`], ['수행건수', `${num(totals.assignmentCount)}건`],
    ['세전금액', `${won(totals.pretaxTotal)}원`],
    ['원천세공제', `${won(totals.withholdingImpliedTotal)}원`, '개인 통번역사 실제 공제(세전−세후) 합계 · 외주업체 부가세 미포함'],
    ...(num(totals.vatTotal) > 0 ? [['부가세(외주업체)', `${won(totals.vatTotal)}원`]] as [string, string, string?][] : []),
    ['실지급액(세후)', `${won(totals.posttaxTotal)}원`, '세전 − 원천세공제 + 외주업체 부가세'],
    ...((totals.foreignTotals ?? []) as { currency: string; count: number; amount: number; missing: number }[]).map(f =>
      ['외화 지급', `${f.currency} ${f.amount.toLocaleString('ko-KR', { maximumFractionDigits: 2 })} · ${f.count}건`, '외화 지급 — 원화 합계 제외(별도 해외송금)'] as [string, string, string?]),
    ['지급완료(세전)', `${won(totals.paidTotal)}원 · ${stc.paid}건`],
    ['미지급(세전)', `${won(totals.unpaidTotal)}원 · ${stc.unpaid}건`],
    ['지급예정', `${stc.scheduled}건`], ['지급확인 필요', `${stc.review}건`],
  ] : [];

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'readiness', label: '지급준비점검' }, { key: 'payees', label: `지급대상별 요약${payees.length ? ` (${payees.length})` : ''}` },
    { key: 'items', label: `건별 상세내역${items.length ? ` (${items.length})` : ''}` },
    ...(canOps ? [{ key: 'operational' as TabKey, label: '지급확정·은행이체' }] : []),
  ];

  return (
    <div data-testid="payout-round-detail">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <BackToListButton variant="subtle" label="지급회차 목록" ariaLabel="지급회차 목록으로 돌아가기" testId="pd-back" onClick={onBack} />
        <h1 style={{ fontSize: 19, fontWeight: 800, color: '#111827', margin: 0 }} data-testid="pd-title">{label}</h1>
        {opRounds.length > 0 && (
          <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {opStatusGroups(opRounds).map(([st, n]) => { const m = OP_STATUS[st] ?? OP_STATUS.draft; return (
              <span key={st} style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: m.bg, color: m.color }}>운영 회차 {m.label}{n > 1 ? ` ${n}` : ''}</span>); })}
          </span>
        )}
      </div>
      {/* 상단 요약 — 선택 지급일 전체(통합 조회 기준). 운영 지급회차 금액은 지급확정·은행이체 탭에서 따로 표시. */}
      <div data-testid="pd-summary" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 0', alignItems: 'center', border: '1px solid #e5e7eb', borderRadius: 10, padding: '9px 12px', marginBottom: 12, background: '#fff', minHeight: 22 }}>
        {loading && !totals ? <span style={{ fontSize: 12, color: '#9ca3af' }}>불러오는 중…</span> : summary.map(([k, v, tip], idx) => (
          <React.Fragment key={k}>
            {idx > 0 && <span style={{ color: '#e5e7eb', margin: '0 10px' }}>|</span>}
            <span style={{ fontSize: 11.5, color: '#9ca3af', marginRight: 5, cursor: tip ? 'help' : undefined }} title={tip}>{k}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: k.includes('원천세') ? '#dc2626' : k.includes('실지급') ? '#111827' : '#374151', fontVariantNumeric: 'tabular-nums' }} title={tip}>{v}</span>
          </React.Fragment>
        ))}
        {totals && <span style={{ marginLeft: 'auto', fontSize: 11, color: '#9ca3af' }}>통합 조회 기준(과거 CRM {items.filter(i => i.source === 'legacy').length} · 신규 플랫폼 {items.filter(i => i.source === 'current').length})</span>}
      </div>

      <div role="tablist" aria-label="지급회차 상세 탭" style={{ display: 'flex', gap: 2, borderBottom: '1px solid #e5e7eb', marginBottom: 12 }}>
        {tabs.map(t => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} aria-label={t.label} data-testid={`pd-tab-${t.key}`} onClick={() => setTab(t.key)}
            style={{ padding: '8px 16px', fontSize: 13, fontWeight: 700, borderWidth: '0 0 2px 0', borderStyle: 'solid', borderColor: tab === t.key ? '#0369a1' : 'transparent', marginBottom: -1, background: 'transparent', color: tab === t.key ? '#0369a1' : '#6b7280', cursor: 'pointer' }}>{t.label}</button>
        ))}
      </div>

      {tab === 'readiness' && <PayoutReadinessPanel token={token} payoutDate={payoutDate} onToast={onToast} defaultOpen />}
      {tab === 'payees' && <PayeeTable payees={payees} items={items} payoutDate={payoutDate} loading={loading} onToast={onToast}
        onPick={(k) => { setSelPayee(k); setItemStatus('all'); setTab('items'); }} />}
      {tab === 'items' && <ItemTable token={token} onToast={onToast} items={items} payees={payees} loading={loading} selPayee={selPayee} setSelPayee={setSelPayee}
        status={itemStatus} setStatus={setItemStatus} onChanged={load} />}
      {tab === 'operational' && canOps && <OperationalTab token={token} onToast={onToast} payoutDate={payoutDate} opRounds={opRounds} reloadOpRounds={reloadOpRounds}
        perms={payoutPerms} unifiedItems={items} />}
    </div>
  );
}

// ── 탭 2: 지급대상별 요약(통합 조회) — 통번역사(Master)별 금액·상태 + 지급명세서 Excel·PDF ──
function PayeeTable({ payees, items, payoutDate, loading, onToast, onPick }: { payees: PayeeGroup[]; items: DetailRow[]; payoutDate: string | null; loading: boolean; onToast: (m: string) => void; onPick: (k: string) => void }) {
  const stmtBtn: React.CSSProperties = { minWidth: 58, padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 700, border: '1px solid #cbd5e1', background: '#fff', color: '#334155', cursor: 'pointer', lineHeight: 1.2 };
  const stmtFor = (g: PayeeGroup) => {
    const rows = items.filter(r => r.masterKey === g.masterKey);
    const payDate = rows.find(r => r.payoutDate)?.payoutDate ?? (payoutDate ?? '-');
    return { payeeType: g.payeeType === 'vendor' ? 'vendor' as const : 'individual' as const, payeeName: g.name, payeeLanguages: reproPayeeLanguages(rows), email: g.email, phone: g.phone ?? pickPhone(rows), scopeValue: `${payoutDate ?? '지급일 미확인'} 지급`, payDate,
      rows: rows.map(r => ({ client: r.client, filename: r.filename, deliveryDate: r.deliveryDate, payoutDate: r.payoutDate, content: r.content, pretax: r.pretax, posttax: r.posttax, payCurrency: r.payCurrency ?? null, foreignAmount: r.foreignAmount ?? null,
        withholdingTreatment: r.withholdingTreatment ?? null, withholdingRate: r.withholdingRate ?? null })) };
  };
  const badge = (text: string, fg: string, bg: string, title?: string) => <span style={{ fontSize: 10, color: fg, background: bg, padding: '1px 5px', borderRadius: 7 }} title={title}>{text}</span>;
  return (
    <div data-testid="pu-payee-panel" style={{ border: '1px solid #e5e7eb', borderRadius: 10, background: '#fff', overflowX: 'auto' }}>
      <div style={{ minWidth: 1040 }}>
        <div style={{ display: 'grid', gridTemplateColumns: STMT_COLS, gap: '0 12px', alignItems: 'center', fontSize: 12, padding: '7px 12px', background: '#f3f4f6', color: '#6b7280', fontWeight: 700 }}>
          <div>통번역사</div><div>언어</div><div>이메일</div><div>연락처</div><div style={{ textAlign: 'right' }}>건수</div><div style={{ textAlign: 'right' }}>세전금액</div><div style={{ textAlign: 'right' }}>원천세공제</div><div style={{ textAlign: 'right' }}>실지급액</div><div style={{ textAlign: 'right' }}>지급상태</div><div style={{ textAlign: 'right' }}>Excel · PDF</div>
        </div>
        <div className="pu-payee-list">
          {payees.map((g) => {
            const opts = stmtFor(g);
            return (
              <div className="pu-payee-row" key={g.masterKey} data-testid={`pu-payee-${g.name}`} onClick={() => onPick(g.masterKey)} title="클릭 → 이 통번역사의 건별 상세내역"
                style={{ display: 'grid', gridTemplateColumns: STMT_COLS, gap: '0 12px', alignItems: 'center', fontSize: 12.5, padding: '8px 12px', cursor: 'pointer' }}>
                <div style={{ color: '#111827', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {g.name}
                  {!g.confirmed && g.matchStatus === 'internal'
                    ? <span style={{ marginLeft: 5 }}>{badge('지급액 없음', '#475569', '#f1f5f9', '베리타스 명의 0원 기록 — 지급액 없음(송금 대상 아님)')}</span>
                    : !g.confirmed && (g.matchStatus === 'vendor' || g.matchStatus === 'client')
                    ? <span style={{ marginLeft: 5 }}>{badge('거래처', '#475569', '#f1f5f9', '거래처/외주업체 — 개인 통번역사 Master 연결 대상이 아님')}</span>
                    : !g.confirmed ? <span style={{ marginLeft: 5 }}>{badge('연결 확인필요', '#1d4ed8', '#eff6ff', '검증상태: Master 연결 미확정(지급상태와 무관)')}</span> : null}
                </div>
                <div style={{ color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11.5 }} title={g.languages.join(', ')}>{g.languages.join(', ')}</div>
                <div style={{ color: '#9ca3af', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11.5 }} title={g.email ?? undefined}>{g.email || ''}</div>
                <div style={{ color: '#9ca3af', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11.5 }}>{g.phone || ''}</div>
                <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{g.count}</div>
                <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{won(g.pretaxTotal)}</div>
                <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#dc2626' }}>{won(g.withholdingImplied)}
                  {g.payeeType === 'vendor' && <div style={{ fontSize: 10, color: '#7c3aed', fontWeight: 700 }} data-testid={`pu-vendor-vat-${g.masterKey}`}>외주업체 · 부가세 {won(num(g.vatTotal))}</div>}</div>
                <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 800, color: '#111827' }}>{won(g.posttaxTotal)}
                  {(g.foreignTotals ?? []).map(f => <div key={f.currency} data-testid={`pu-payee-fx-${g.masterKey}-${f.currency}`} style={{ fontSize: 10, color: '#1d4ed8', fontWeight: 700 }} title="외화 지급 — 원화 합계 제외(별도 해외송금)">외화 {f.currency} {f.amount.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}{f.missing ? ` · 미입력 ${f.missing}건` : ''}</div>)}</div>
                <div style={{ textAlign: 'right', display: 'flex', gap: 4, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                  {g.paidCount > 0 && badge(`지급완료 ${g.paidCount}건`, '#1d4ed8', '#eff6ff')}
                  {g.needReviewCount > 0 && badge(`지급확인 필요 ${g.needReviewCount}건`, '#92400e', '#fef3c7', '지급일이 지났거나 미상인데 지급확정 기록이 없는 건')}
                  {num(g.scheduledCount) > 0 && badge(`지급예정 ${num(g.scheduledCount)}건`, '#047857', '#ecfdf5')}
                  {g.unpaidCount > 0 && badge(`미지급 ${g.unpaidCount}건`, '#b45309', '#fffbeb')}
                  {g.dupSuspectCount > 0 && badge(`중복 ${g.dupSuspectCount}건`, '#dc2626', '#fef2f2')}
                  {g.paidCount === 0 && g.unpaidCount === 0 && g.needReviewCount === 0 && g.dupSuspectCount === 0 && !num(g.scheduledCount) && <span style={{ fontSize: 10, color: '#9ca3af' }}>-</span>}
                </div>
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button type="button" style={stmtBtn} data-testid={`pu-excel-${g.name}`} aria-label={`${g.name} 지급명세서 Excel`} onClick={(e) => { e.stopPropagation(); exportReproStatementExcel(opts); onToast(`${g.name} 지급명세서 Excel을 다운로드했습니다.`); }}>Excel</button>
                  <button type="button" style={stmtBtn} data-testid={`pu-pdf-${g.name}`} aria-label={`${g.name} 지급명세서 PDF`} onClick={(e) => { e.stopPropagation(); if (!exportReproStatementPdf(opts)) onToast('팝업 차단을 해제한 후 다시 시도해 주세요.'); }}>PDF</button>
                </div>
              </div>
            );
          })}
          {payees.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>{loading ? '불러오는 중…' : '지급대상이 없습니다.'}</div>}
        </div>
      </div>
    </div>
  );
}

// ── 탭 3: 건별 상세내역(통합 조회) — 통번역사·지급상태 필터(화면 내) ──
function ItemTable({ token, onToast, items, payees, loading, selPayee, setSelPayee, status, setStatus, onChanged }: {
  token: string; onToast: (m: string) => void; items: DetailRow[]; payees: PayeeGroup[]; loading: boolean;
  selPayee: string; setSelPayee: (k: string) => void; status: string; setStatus: (s: string) => void; onChanged: () => void;
}) {
  const rows = items.filter(r => (selPayee === '__all__' || r.masterKey === selPayee) && (status === 'all' || r.status === status));
  const clamp2 = { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'normal', lineHeight: 1.35 } as React.CSSProperties;
  const inp: React.CSSProperties = { padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13 };
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <select style={inp} value={selPayee} onChange={e => setSelPayee(e.target.value)} aria-label="통번역사 선택" data-testid="pd-item-payee">
          <option value="__all__">전체 통번역사</option>
          {payees.map(g => <option key={g.masterKey} value={g.masterKey}>{g.name} ({g.count})</option>)}
        </select>
        <select style={inp} value={status} onChange={e => setStatus(e.target.value)} aria-label="지급상태" data-testid="pd-item-status">{STATUS_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <span style={{ fontSize: 12, color: '#6b7280' }} data-testid="pu-detail-title">{rows.length}건</span>
      </div>
      <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 10 }}>
        <table className="veritas-read-table vz-sticky pr-detail-zebra" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr>{['거래처', '통번역사', '주민번호', '언어', '상품/업무', '상세내역', '납품일', '지급일', '세전지급액', '세후지급액', '원천세공제액', '지급상태', '지급 전환'].map(h => <th key={h} style={{ padding: '9px 12px', textAlign: h.includes('액') ? 'right' : 'left', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((p, i) => {
              const sm = STATUS_META[p.status] ?? STATUS_META.deposit_unconfirmed;
              return (
                <tr key={p.sourceKey} data-testid={`pu-detail-${i}`} data-source={p.source} data-status={p.status}>
                  <td style={{ ...td, whiteSpace: 'normal', maxWidth: 180 }} title={p.client ?? undefined}><div style={clamp2}>{p.client ?? <span style={{ color: '#b45309', fontWeight: 700 }}>거래처 확인 필요</span>}</div></td>
                  <td style={{ ...td, whiteSpace: 'normal', lineHeight: 1.35 }}>
                    <div style={{ fontWeight: 600, color: '#111827' }}>{p.translator ?? '-'}</div>
                    {(p.masterEmail || p.masterPhone) && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }} title="현재 Master 등록 연락처">{p.masterEmail && <div>{p.masterEmail}</div>}{p.masterPhone && <div>{p.masterPhone}</div>}</div>}
                  </td>
                  <td style={{ ...td, fontVariantNumeric: 'tabular-nums', color: p.residentMasked ? '#6b7280' : '#d1d5db' }} title="주민번호 앞 6자리만 표시(마스킹)">{p.residentMasked ?? '-'}</td>
                  <td style={{ ...td, whiteSpace: 'normal', maxWidth: 140 }}>{p.language ?? '-'}</td>
                  <td style={{ ...td, maxWidth: 200 }} title={p.content ?? undefined}><div style={clamp2}>{p.content ?? '-'}</div></td>
                  <td style={{ ...td, maxWidth: 230 }} title={p.filename ?? undefined}><div style={clamp2}>{p.filename ?? '-'}</div></td>
                  <td style={td}>{p.deliveryDate ?? <span style={{ color: '#b45309' }}>(납품일 미상)</span>}</td>
                  <td style={td}>{p.payoutDate ?? <span style={{ color: '#b45309', fontWeight: 700 }}>(지급일 미확인)</span>}</td>
                  <td style={tdR}>{won(p.pretax)}
                    {p.payCurrency && p.payCurrency !== 'KRW' && <div data-testid={`pu-detail-fx-${i}`} style={{ fontSize: 10, color: '#1d4ed8', fontWeight: 700 }} title="외화 지급 — 원화 합계 제외(별도 해외송금)">외화 {p.payCurrency} {p.foreignAmount != null ? p.foreignAmount.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '미입력'}</div>}</td>
                  <td style={tdR}>{won(p.posttax)}</td>
                  <td style={{ ...tdR, color: '#dc2626' }}>{won(p.withholdingImplied)}
                    {p.payeeType === 'vendor' && <div style={{ fontSize: 10, color: '#7c3aed' }}>외주 · 부가세 {p.vat != null ? won(p.vat) : '미확정'}</div>}
                    {p.taxConflict && <div title={p.taxConflict} style={{ fontSize: 10, color: '#c2410c', fontWeight: 700 }}>⚠ 세금 확인</div>}</td>
                  <td style={td}><span style={{ padding: '2px 8px', borderRadius: 10, background: sm.bg, color: sm.fg, fontSize: 12, fontWeight: 700, cursor: p.paidBasis ? 'help' : undefined }} title={p.paidBasis ? `지급완료 근거: ${p.paidBasis}` : undefined} data-testid={`pu-detail-status-${i}`} aria-label={`지급상태 ${sm.label}`}>{sm.label}</span></td>
                  <td style={td}>{p.source === 'legacy'
                    ? <ConversionCell token={token} rowId={p.id} conversion={p.conversion ?? null} eligible={!!p.conversionEligible} onToast={onToast} onChanged={onChanged} />
                    : <span style={{ color: '#d1d5db' }}>-</span>}</td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={13} style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>{loading ? '불러오는 중…' : '상세 내역이 없습니다.'}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── 탭 4: 지급확정·은행이체(운영 지급) — 기존 운영 지급회차 화면(PayoutRoundsTab) 재사용 ──
//  · 운영 회차가 없으면: 지급예정일 기준 수집 예정 건(전체 지급대상 개요 API를 같은 조건으로 필터) + [지급회차 생성](대상기간 = 지급일 하루).
//  · 운영 회차가 있으면(여러 개 가능): 회차를 골라 기존 확정·지급 실행·IBK 파일·지급완료 화면을 그대로 표시.
//  · 통합 조회(신규 플랫폼) 건 중 운영 회차에 들어가지 않은 건과 사유를 별도 표로 표시. 과거 CRM 건은 운영 지급 대상이 아님.
function OperationalTab({ token, onToast, payoutDate, opRounds, reloadOpRounds, perms, unifiedItems }: {
  token: string; onToast: (m: string) => void; payoutDate: string | null; opRounds: OpRound[]; reloadOpRounds: () => void;
  perms?: PayoutPerms; unifiedItems: DetailRow[];
}) {
  const authH = { Authorization: `Bearer ${token}` };
  const canManage = perms ? perms.manage : true;
  const sorted = useMemo(() => [...opRounds].sort((a, b) => (ACTIVE_OP.includes(b.status) ? 1 : 0) - (ACTIVE_OP.includes(a.status) ? 1 : 0) || b.id - a.id), [opRounds]);
  // 기본 선택 = 진행 중 회차 → 지급완료 회차. 취소 회차는 자동 선택하지 않는다(없으면 수집 예정 표시).
  const defaultId = () => (sorted.find(r => r.status !== 'cancelled')?.id ?? null);
  const [selId, setSelId] = useState<number | null>(defaultId);
  const [showCancelled, setShowCancelled] = useState(false);
  const awaitIdRef = React.useRef<number | null>(null);   // 방금 생성한 회차 — 상위 목록 재조회가 끝날 때까지 기본 선택으로 되돌리지 않음
  useEffect(() => {
    if (awaitIdRef.current != null) { if (opRounds.some(r => r.id === awaitIdRef.current)) { setSelId(awaitIdRef.current); awaitIdRef.current = null; } return; }
    if (selId == null || !opRounds.some(r => r.id === selId)) setSelId(defaultId());
  }, [opRounds]);   // eslint-disable-line react-hooks/exhaustive-deps
  const hasActive = opRounds.some(r => ACTIVE_OP.includes(r.status));
  const [showCreate, setShowCreate] = useState(false);

  // 운영 기준 데이터 — 선택 회차 상세(포함 건·제외/확인 필요 사유) 또는 회차 생성 전 수집 예정(미배정 자격충족 건 중 지급예정일 = 지급일).
  const [roundDetail, setRoundDetail] = useState<any>(null);
  const [preview, setPreview] = useState<any[] | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (selId != null) {
          const r = await fetch(api(`/api/admin/payout-rounds/${selId}`), { headers: authH }); const d = await r.json();
          if (alive && r.ok) setRoundDetail(d);
        } else setRoundDetail(null);
        if (!hasActive && payoutDate) {
          const r = await fetch(api('/api/admin/payout-rounds/overview?scope=unassigned'), { headers: authH }); const d = await r.json();
          // 서버 수집 조건과 같은 기준: 지급예정일 기준 수집 = COALESCE(지급예정일, 납품일) 이 대상기간(지급일 하루) 안
          const list = r.ok ? (d.summary ?? []).flatMap((g: any) => g.items ?? []).filter((it: any) => String(it.expectedPaymentDate ?? it.deliveryDate ?? '').slice(0, 10) === payoutDate) : [];
          if (alive) setPreview(list);
        } else if (alive) setPreview(null);
      } catch { if (alive) onToast('운영 지급회차 조회 실패'); }
    })();
    return () => { alive = false; };
  }, [selId, hasActive, payoutDate, refreshKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!payoutDate) return (
    <div data-testid="pd-op-none" style={{ border: '1px dashed #d1d5db', borderRadius: 10, padding: 18, color: '#6b7280', fontSize: 13 }}>
      지급일이 없는 건은 운영 지급회차 대상이 아닙니다. 지급준비점검 탭에서 지급예정일을 확인해 주세요.
    </div>
  );

  // 운영 회차 포함 건 id · 제외/확인 필요(사유) — 서버 회차 상세 값 그대로
  const inRound = new Set<number>((roundDetail?.summary ?? []).flatMap((g: any) => (g.items ?? []).map((it: any) => Number(it.id))));
  const warnReason = new Map<number, string>();
  for (const b of roundDetail?.warnings?.byReason ?? []) for (const it of b.items ?? []) warnReason.set(Number(it.id), b.reason);
  const previewIds = new Set<number>((preview ?? []).map((it: any) => Number(it.id)));
  const curItems = unifiedItems.filter(i => i.source === 'current');
  const legacyCnt = unifiedItems.length - curItems.length;
  const roundSel = opRounds.find(r => r.id === selId) ?? null;
  // 통합 조회 신규 플랫폼 건 중 운영 지급대상이 아닌 건과 사유
  const outside = curItems.filter(i => (roundSel ? !inRound.has(i.id) : !previewIds.has(i.id))).map(i => ({
    ...i,
    // 사유 우선순위: 서버 제외·확인 필요 사유(작성중 회차) → 지급상태 → 지급액 0원 → 새 회차 수집 가능(수집 예정) → 기타
    reason: warnReason.get(i.id)
      ?? (i.status === 'paid' ? '지급완료(다른 경로·다른 회차)' : i.status === 'excluded' ? '지급보류'
        // 외화 지급 건은 원화 0원이어도 0원 건이 아니다 — 원화 지급회차·국내 송금파일 대상 아님(별도 해외송금)
        : i.payCurrency && i.payCurrency !== 'KRW' ? `외화 지급(${i.payCurrency} ${i.foreignAmount != null ? i.foreignAmount.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '금액 미입력'}) — 별도 해외송금(원화 지급회차 제외)`
        : num(i.pretax) <= 0 ? '지급액 0원(미확정)'
        : previewIds.has(i.id) ? '이 회차 확정 이후 지급대상이 됨 — 새 회차로 수집 가능'
        : roundSel && ACTIVE_OP.includes(roundSel.status) ? '이 회차에 수집되지 않음(다른 회차 포함·수집 후 제외 등)'
        : '수집 조건 미충족(납품확인·지급대상·세금처리·원화 여부 확인)'),
  }));
  const targetCnt = roundSel ? inRound.size : (preview?.length ?? 0);
  const targetNet = roundSel ? num(roundDetail?.totals?.netTotal) : (preview ?? []).reduce((s: number, it: any) => s + num(it.netPayment), 0);
  const chip = (r: OpRound) => { const m = OP_STATUS[r.status] ?? OP_STATUS.draft; const on = r.id === selId; return (
    <button key={r.id} type="button" onClick={() => setSelId(r.id)} data-testid={`pd-op-round-${r.id}`} aria-label={`운영 회차 ${r.batchNumber ?? r.id} 선택`} aria-pressed={on}
      style={{ padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: on ? '2px solid #0369a1' : '1px solid #cbd5e1', background: on ? '#f0f9ff' : '#fff', color: '#334155' }}>
      {r.batchNumber ?? `회차 #${r.id}`} <span style={{ marginLeft: 4, padding: '1px 6px', borderRadius: 8, background: m.bg, color: m.color }}>{m.label}</span> · {num(r.totalAssignments)}건
    </button>); };

  return (
    <div data-testid="pd-operational">
      {/* 데이터 구분 — 통합 조회(과거 CRM + 신규) vs 운영 지급(신규 플랫폼 수행정보만) */}
      <div data-testid="pd-op-basis" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 10, background: '#f8fafc', marginBottom: 10, fontSize: 12.5 }}>
        <span>통합 조회 <b>{unifiedItems.length}건</b> <span style={{ color: '#6b7280' }}>(신규 플랫폼 {curItems.length} · 과거 CRM {legacyCnt} — 과거 CRM은 별도 지급파일 처리, 운영 지급 대상 아님)</span></span>
        <span style={{ color: '#cbd5e1' }}>|</span>
        <span data-testid="pd-op-target">{roundSel ? '운영 회차 지급대상' : '운영 회차 수집 예정'} <b>{targetCnt}건</b>{targetNet > 0 && <> · 실지급 <b>{won(targetNet)}원</b></>}</span>
        <span style={{ color: '#cbd5e1' }}>|</span>
        <span data-testid="pd-op-outside">운영 지급대상 아님 <b style={{ color: outside.length ? '#b45309' : undefined }}>{outside.length}건</b></span>
      </div>

      {/* 이 지급일의 운영 회차(여러 개면 모두 선택 가능) + 생성 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#6b7280' }}>운영 지급회차</span>
        {sorted.filter(r => r.status !== 'cancelled' || showCancelled || r.id === selId).map(chip)}
        {sorted.every(r => r.status === 'cancelled') && !showCancelled && selId == null && <span style={{ fontSize: 12, color: '#9ca3af' }}>{sorted.length ? '진행 중인 회차가 없습니다.' : '아직 생성되지 않았습니다.'}</span>}
        {sorted.some(r => r.status === 'cancelled') && (
          <button type="button" onClick={() => setShowCancelled(v => !v)} data-testid="pd-op-cancelled-toggle" aria-label="취소된 운영 회차 보기"
            style={{ padding: '4px 10px', borderRadius: 8, fontSize: 11.5, fontWeight: 600, border: '1px dashed #cbd5e1', background: '#fff', color: '#6b7280', cursor: 'pointer' }}>
            취소된 회차 {sorted.filter(r => r.status === 'cancelled').length}개 {showCancelled ? '숨기기' : '보기'}</button>
        )}
        {!hasActive && canManage && (
          <button type="button" onClick={() => setShowCreate(true)} data-testid="pd-op-create" aria-label="지급회차 생성"
            style={{ marginLeft: 'auto', padding: '7px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, border: 'none', background: '#0369a1', color: '#fff', cursor: 'pointer' }}>+ 지급회차 생성 ({payoutDate})</button>
        )}
      </div>

      {!roundSel && preview && (
        <div data-testid="pd-op-preview" style={{ border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 12, overflowX: 'auto' }}>
          <div style={{ padding: '8px 12px', fontSize: 12.5, fontWeight: 700, background: '#f0f9ff', color: '#0369a1' }}>
            수집 예정 {preview.length}건 — 지급예정일 {payoutDate} · 미지급·미배정·납품확인·지급액 확정 건(회차 생성 시 지급예정일 기준으로 자동수집)
          </div>
          <table className="veritas-read-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr>{['지급대상', '거래처', '상품·업무', '납품일', '지급예정일', '세전', '실지급'].map(h => <th key={h} style={{ padding: '7px 12px', textAlign: h === '세전' || h === '실지급' ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
            <tbody>
              {preview.map((it: any) => (
                <tr key={it.id} data-testid={`pd-op-preview-${it.id}`}>
                  <td style={td}>{it.performerName ?? '-'}</td><td style={td}>{it.customerName ?? '-'}</td><td style={td}>{it.productName ?? '-'}</td>
                  <td style={td}>{String(it.deliveryDate ?? '').slice(0, 10) || '-'}</td><td style={td}>{String(it.expectedPaymentDate ?? '').slice(0, 10) || '-'}</td>
                  <td style={tdR}>{won(num(it.gross))}</td><td style={{ ...tdR, fontWeight: 700 }}>{won(num(it.netPayment))}</td>
                </tr>
              ))}
              {preview.length === 0 && <tr><td colSpan={7} style={{ padding: 18, textAlign: 'center', color: '#9ca3af' }}>수집 조건을 충족한 미배정 건이 없습니다.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {outside.length > 0 && (
        <details data-testid="pd-op-outside-list" style={{ border: '1px solid #fde68a', borderRadius: 10, marginBottom: 12, background: '#fffbeb' }}>
          <summary style={{ padding: '8px 12px', fontSize: 12.5, fontWeight: 700, color: '#92400e', cursor: 'pointer' }}>운영 지급대상이 아닌 신규 플랫폼 건 {outside.length}건 — 사유 보기</summary>
          <div style={{ overflowX: 'auto', background: '#fff' }}>
            <table className="veritas-read-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr>{['통번역사', '거래처', '납품일', '지급일', '세전', '통합 조회 상태', '사유'].map(h => <th key={h} style={{ padding: '7px 12px', textAlign: h === '세전' ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
              <tbody>
                {outside.map((i) => { const sm = STATUS_META[i.status] ?? STATUS_META.deposit_unconfirmed; return (
                  <tr key={i.sourceKey} data-testid={`pd-op-outside-${i.id}`}>
                    <td style={td}>{i.translator ?? '-'}</td><td style={td}>{i.client ?? '-'}</td><td style={td}>{i.deliveryDate ?? '-'}</td><td style={td}>{i.payoutDate ?? '-'}</td>
                    <td style={tdR}>{won(i.pretax)}</td>
                    <td style={td}><span style={{ padding: '1px 7px', borderRadius: 8, background: sm.bg, color: sm.fg, fontSize: 11.5, fontWeight: 700 }}>{sm.label}</span></td>
                    <td style={{ ...td, whiteSpace: 'normal', color: '#92400e', fontWeight: 600 }}>{i.reason}</td>
                  </tr>); })}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {roundSel && <div style={{ fontSize: 13, fontWeight: 800, color: '#374151', margin: '4px 0 6px' }} data-testid="pd-op-round-title">운영 지급회차 상세 — 실제 지급대상(운영 회차 기준)</div>}
      {roundSel && (
        <PayoutRoundsTab key={roundSel.id} token={token} onToast={onToast} perms={perms} fixedRoundId={roundSel.id}
          onRoundsChanged={() => { reloadOpRounds(); setRefreshKey(k => k + 1); }} />
      )}

      {showCreate && (
        <CreateDialog token={token} onToast={onToast} onClose={() => setShowCreate(false)}
          initial={{ paymentDate: payoutDate, periodStart: payoutDate, periodEnd: payoutDate, basis: 'expected_payment_date' }}
          onCreated={(d: any) => { setShowCreate(false); if (d?.round?.id) { awaitIdRef.current = Number(d.round.id); setSelId(Number(d.round.id)); } reloadOpRounds(); setRefreshKey(k => k + 1); }} />
      )}
    </div>
  );
}
