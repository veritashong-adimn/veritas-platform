// ─────────────────────────────────────────────────────────────────────────────
// 지급회차 상세 — 지급회차 목록(PayoutUnifiedTab)에서 지급일을 클릭하면 열리는 화면.
//  · 상단: 지급일·지급금액 요약(선택 지급일 전체 — 목록의 거래처·통번역사·출처 필터와 무관).
//  · 탭 4개가 같은 지급일을 공유: 지급준비점검 · 지급대상별 요약 · 건별 상세내역 · 지급확정·은행이체.
//  · 데이터 구분(혼합 금지):
//      통합 조회 = /admin/payout-unified/payees(과거 CRM + 신규 플랫폼, 조회 전용 — 탭 1~3)
//      운영 지급 = /admin/payout-rounds(신규 플랫폼 수행정보만, 생성·확정·지급 실행·IBK·지급완료 — 탭 4, 기존 PayoutRoundsTab 재사용)
//  · 계산·저장 로직 없음. 서버가 내려준 값만 표시·합산한다.
// ─────────────────────────────────────────────────────────────────────────────
import { canExport as canExportData } from '../../lib/exportAccess';   // Excel·CSV 출력 — 관리자만(공통 기준)
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/constants';
import { exportReproStatementExcel, exportReproStatementPdf, reproPayeeLanguages } from '../../lib/payoutReproStatement';
import { ConversionCell, type ConversionInfo } from './LegacyPayoutConversion';
import { PayoutReadinessPanel } from './PayoutReadinessPanel';
import PayoutRoundsTab, { CreateDialog, type PayoutPerms } from './PayoutRoundsTab';
import { BackToListButton } from './BackToListButton';
import './readTableView.css';
import { formatDisplayDate } from '../../lib/dateFormat';
import { exportDataset } from '../../lib/excelExport';
import { PAY_STATUS_META, PAY_STATUS_FILTER_OPTS, PayStatusBadge, payStatusChips, fxSummaryText, fxNum, SaleLink, domesticPayeeKeyOf, wonPayTotalsOf, roundingNote, type PayStatusKey, type ForeignTotal } from './payoutDisplayShared';

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
  // 화면 공통 표시값(서버, 표시 전용): 지급상태 6종 · 판매번호·판매 id(판매상세 연결) · 실제 지급일 · 명부 기준으로 바뀌기 전 원래 이름
  payStatus?: PayStatusKey; payStatusLabel?: string; saleNo?: string | null; projectId?: number | null; actualPaymentDate?: string | null;
  originalTranslator?: string | null; supply?: number | null; payTotal?: number | null; vendorId?: number | null;
  withholdingTreatment?: string | null; withholdingRate?: number | null;   // 수행정보 세금처리 유형(명세서 표기용)
};
export type PayeeGroup = {
  masterKey: string; name: string; confirmed: boolean; matchStatus: string; matchedUserId: number | null;
  email: string | null; phone: string | null; count: number; languages: string[];
  pretaxTotal: number; posttaxTotal: number; withholdingImplied: number; payeeType?: 'individual' | 'vendor'; vatTotal?: number;
  payTotal?: number; payRoundingAdjustment?: number;   // 실지급(송금 기준) = 지급대상자별 원 단위 반올림 — posttaxTotal(건별 합계)과의 차이
  paidPretax: number; unpaidPretax: number; paidCount: number; unpaidCount: number; needReviewCount: number; dupSuspectCount: number; sources: string[];
  scheduledCount?: number;
  foreignTotals?: ForeignTotal[];
  payStatusCounts?: Record<string, number>;
  // Excel 정렬 그룹(서버 lib/payeeRemitGroup) — 1 국내 · 2 해외·국내송금 · 3 해외·해외송금 · 4 외주업체. 화면 순서에는 쓰지 않음.
  remitGroup?: number; remitGroupReason?: string;
  residentMasked?: string | null;   // 통번역사 명부 주민등록번호(마스킹) — 외주업체 null
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

// 지급대상·언어·이메일·연락처·건수·세전금액·원천세공제·부가세·실지급금액·지급상태·출력
// 지급대상 · 주민등록번호 · 언어 · 이메일 · 연락처 · 건수 · 세전금액 · 원천세공제 · 부가세 · 실지급금액 · 지급상태 · 명세서
//   이름·언어·이메일 열이 남는 폭을 독차지하지 않도록 금액 열과 비율을 나눠 갖는다. 지급상태·명세서는 고정폭(행마다 열 위치 동일).
const STMT_COLS = 'minmax(96px,0.9fr) 112px minmax(64px,0.6fr) minmax(110px,0.9fr) 104px 44px minmax(96px,0.8fr) minmax(90px,0.75fr) minmax(76px,0.6fr) minmax(136px,1fr) 160px 128px';
const sumBy = <T,>(a: T[], f: (x: T) => unknown) => Math.round(a.reduce((s, x) => s + num(f(x)), 0) * 100) / 100;
/** 행 목록의 외화 통화별 합계(원화 합계와 별도) */
function fxTotalsOf(rows: DetailRow[]): ForeignTotal[] {
  const m = new Map<string, ForeignTotal>();
  for (const r of rows) { if (!r.payCurrency || r.payCurrency === 'KRW') continue; const g = m.get(r.payCurrency) ?? { currency: r.payCurrency, count: 0, amount: 0, missing: 0 };
    g.count++; if (r.foreignAmount != null) g.amount = Math.round((g.amount + r.foreignAmount) * 100) / 100; else g.missing++; m.set(r.payCurrency, g); }
  return [...m.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}
const isFxRow = (r: DetailRow) => !!r.payCurrency && r.payCurrency !== 'KRW';
const fxCell = (r: DetailRow) => `${r.payCurrency} ${r.foreignAmount != null ? fxNum(r.payCurrency!, r.foreignAmount) : '금액 미입력'}`;
const payTotalOf = (r: DetailRow) => num(r.payTotal ?? r.posttax);
const statusText = (c?: Record<string, number>) => Object.entries(c ?? {}).filter(([, v]) => v > 0).map(([k, v]) => `${PAY_STATUS_META[k as PayStatusKey]?.label ?? k} ${v}`).join(', ');
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

  const label = payoutDate ? `${formatDisplayDate(payoutDate)} 지급` : '지급일 미확인';
  // 상단 요약 — 화면 공통 명칭(세전금액·원천세공제·부가세·실지급금액) · 외화 통화별(금액 미입력 건수) · 지급상태 6종 건수
  const summary: [string, string, string?][] = totals ? [
    ['지급대상', `${num(totals.payeeCount)}명`], ['수행건수', `${num(totals.assignmentCount)}건`],
    ['세전금액', `${won(totals.pretaxTotal)}원`, '외주업체는 공급가'],
    ['원천세공제', `${won(totals.withholdingImpliedTotal)}원`, '개인 통번역사 원천세 공제 합계'],
    ['부가세', `${won(totals.vatTotal)}원`, '외주업체 부가세 합계'],
    ['실지급금액', `${won(totals.payTotal ?? totals.posttaxTotal)}원`, '세전금액 − 원천세공제 + 부가세 · 국내 지급은 지급대상자별 원 단위 반올림 후 합산(기업은행 송금 기준)'],
    ...(roundingNote(num(totals.payTotalExact ?? totals.posttaxTotal), num(totals.payRoundingAdjustment)) ? [['원 단위 조정', `${num(totals.payRoundingAdjustment) > 0 ? '+' : '−'}${Math.abs(num(totals.payRoundingAdjustment)).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원`, roundingNote(num(totals.payTotalExact ?? totals.posttaxTotal), num(totals.payRoundingAdjustment))!]] as [string, string, string?][] : []),
    ...(((totals.foreignTotals ?? []) as ForeignTotal[]).length ? [['외화', fxSummaryText(totals.foreignTotals as ForeignTotal[]), '외화 지급 — 원화 합계 제외(별도 해외송금)']] as [string, string, string?][] : []),
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
        {totals?.payStatusCounts && <span data-testid="pd-status-counts" style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', gap: 2 }}>{payStatusChips(totals.payStatusCounts)}</span>}
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
        status={itemStatus} setStatus={setItemStatus} onChanged={load} payoutDate={payoutDate} />}
      {tab === 'operational' && canOps && <OperationalTab token={token} onToast={onToast} payoutDate={payoutDate} opRounds={opRounds} reloadOpRounds={reloadOpRounds}
        perms={payoutPerms} unifiedItems={items} />}
    </div>
  );
}

// ── 탭 2: 지급대상별 요약(통합 조회) — 지급대상(명부 기준)별 금액·지급상태 + 전체 Excel + 개별 지급명세서 Excel·PDF ──
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
  const fxAll = fxTotalsOf(items);
  // 실지급 = 지급대상별 송금 기준(원 단위 반올림) 금액의 합. 건별 합계(posttaxTotal)와의 차이는 원 단위 조정으로 구분 표시.
  const payOfG = (g: PayeeGroup) => num(g.payTotal ?? g.posttaxTotal);
  const tot = { count: sumBy(payees, g => g.count), pre: sumBy(payees, g => g.pretaxTotal), wh: sumBy(payees, g => g.withholdingImplied), vat: sumBy(payees, g => g.vatTotal), pay: Math.round(sumBy(payees, payOfG) * 100) / 100 };
  const payExact = Math.round(sumBy(payees, g => g.posttaxTotal) * 100) / 100;
  const payNote = roundingNote(payExact, Math.round((tot.pay - payExact) * 100) / 100);
  const exportAll = () => {
    type R = { name: string; type: string; langs: string; email: string; phone: string; count: number; pre: number; wh: number; vat: number; pay: number; fx: string; st: string };
    // 행 순서(Excel만) — 지급 그룹(국내 → 해외·국내송금 → 해외·해외송금 → 외주업체) 후 그룹 안 가나다순. 항목·금액·합계 불변, 화면 목록 순서 불변.
    const ordered = [...payees].sort((a, b) => ((a.remitGroup ?? 1) - (b.remitGroup ?? 1)) || a.name.localeCompare(b.name, 'ko'));
    const rows: R[] = ordered.map(g => ({ name: g.name, type: g.payeeType === 'vendor' ? '외주업체' : '개인', langs: g.languages.join(', '), email: g.email ?? '', phone: g.phone ?? '', count: g.count,
      pre: g.pretaxTotal, wh: g.withholdingImplied, vat: num(g.vatTotal), pay: payOfG(g), fx: fxSummaryText(g.foreignTotals ?? []), st: statusText(g.payStatusCounts) }));
    rows.push({ name: `합계 (${payees.length}명)`, type: '', langs: '', email: '', phone: '', count: tot.count, pre: tot.pre, wh: tot.wh, vat: tot.vat, pay: tot.pay, fx: fxSummaryText(fxAll), st: '' });
    if (payNote) rows.push({ name: '※ 실지급 합계 = 지급대상자별 원 단위 반올림 후 합산(기업은행 송금 기준)', type: '', langs: '', email: '', phone: '', count: '', pre: '', wh: '', vat: '', pay: Math.round((tot.pay - payExact) * 100) / 100, fx: payNote, st: '원 단위 조정' } as any);
    exportDataset<R>({ filename: `지급대상별요약_${payoutDate ?? '지급일미확인'}.xlsx`, sheetName: '지급대상별 요약', rows, columns: [
      { header: '지급대상', value: 'name', width: 22 }, { header: '구분', value: 'type', width: 9 }, { header: '언어', value: 'langs', width: 16 },
      { header: '이메일', value: 'email', width: 24 }, { header: '연락처', value: 'phone', width: 15 }, { header: '건수', value: 'count', type: 'number', width: 7 },
      { header: '세전금액', value: 'pre', type: 'number', width: 14 }, { header: '원천세공제', value: 'wh', type: 'number', width: 13 }, { header: '부가세', value: 'vat', type: 'number', width: 12 },
      { header: '실지급금액', value: 'pay', type: 'number', width: 14 }, { header: '외화', value: 'fx', width: 22 }, { header: '지급상태', value: 'st', width: 28 } ] });
    onToast(`지급대상별 요약 ${payees.length}명을 Excel로 내보냈습니다.`);
  };
  const H = ({ c, r }: { c: string; r?: boolean }) => <div style={{ textAlign: r ? 'right' : 'left' }}>{c}</div>;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        {canExportData() && (<button type="button" onClick={exportAll} disabled={!payees.length} data-testid="pu-payee-excel-all" aria-label="지급대상별 요약 전체 Excel"
          style={{ border: 'none', borderRadius: 7, padding: '6px 12px', background: '#059669', color: '#fff', fontWeight: 700, fontSize: 12, cursor: payees.length ? 'pointer' : 'default', opacity: payees.length ? 1 : 0.5 }}>전체 Excel</button>)}
      </div>
      <div data-testid="pu-payee-panel" style={{ border: '1px solid #e5e7eb', borderRadius: 10, background: '#fff', overflowX: 'auto' }}>
        <div style={{ minWidth: 1318 }}>
          <div style={{ display: 'grid', gridTemplateColumns: STMT_COLS, gap: '0 8px', alignItems: 'center', fontSize: 12, padding: '7px 12px', background: '#f3f4f6', color: '#6b7280', fontWeight: 700 }}>
            <H c="지급대상" /><H c="주민등록번호" /><H c="언어" /><H c="이메일" /><H c="연락처" /><H c="건수" r /><H c="세전금액" r /><H c="원천세공제" r /><H c="부가세" r /><H c="실지급금액" r /><H c="지급상태" r /><H c="명세서 Excel · PDF" r />
          </div>
          <div className="pu-payee-list">
            {payees.map((g) => {
              const opts = stmtFor(g);
              return (
                <div className="pu-payee-row" key={g.masterKey} data-testid={`pu-payee-${g.name}`} onClick={() => onPick(g.masterKey)} title="클릭 → 이 지급대상의 건별 상세내역"
                  style={{ display: 'grid', gridTemplateColumns: STMT_COLS, gap: '0 8px', alignItems: 'center', fontSize: 12.5, padding: '8px 12px', cursor: 'pointer' }}>
                  <div style={{ color: '#111827', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={g.name}>
                    {g.name}
                    {g.payeeType === 'vendor' && <span style={{ marginLeft: 5 }}>{badge('외주업체', '#7c3aed', '#f5f3ff')}</span>}
                    {!g.confirmed && g.matchStatus !== 'internal' && g.matchStatus !== 'vendor' && g.matchStatus !== 'client' && <span style={{ marginLeft: 5 }}>{badge('명부 연결 확인', '#1d4ed8', '#eff6ff', '통번역사 명부 연결 미확정(지급상태와 무관)')}</span>}
                  </div>
                  <div data-testid={`pu-payee-rrn-${g.masterKey}`} style={{ whiteSpace: 'nowrap', fontSize: 11.5, fontVariantNumeric: 'tabular-nums', color: g.payeeType === 'vendor' || g.residentMasked ? '#374151' : '#9ca3af' }}>
                    {g.payeeType === 'vendor' ? '—' : (g.residentMasked || '미등록')}</div>
                  <div style={{ color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11.5 }} title={g.languages.join(', ')}>{g.languages.join(', ')}</div>
                  <div style={{ color: '#9ca3af', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11 }} title={g.email ?? undefined}>{g.email || ''}</div>
                  <div style={{ color: '#9ca3af', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11 }} title={g.phone ?? undefined}>{g.phone || ''}</div>
                  <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{g.count}</div>
                  <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{won(g.pretaxTotal)}</div>
                  <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#dc2626' }}>{won(g.withholdingImplied)}</div>
                  <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#7c3aed' }} data-testid={`pu-vendor-vat-${g.masterKey}`}>{won(num(g.vatTotal))}</div>
                  <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 800, color: '#111827' }} title={roundingNote(num(g.posttaxTotal), num(g.payRoundingAdjustment)) ?? undefined}>{won(payOfG(g))}
                    {(g.foreignTotals ?? []).map(f => <div key={f.currency} data-testid={`pu-payee-fx-${g.masterKey}-${f.currency}`} style={{ fontSize: 10, color: '#1d4ed8', fontWeight: 700, whiteSpace: 'normal', wordBreak: 'keep-all', overflowWrap: 'anywhere' }} title="외화 지급 — 원화 합계 제외(별도 해외송금)">{fxSummaryText([f])}</div>)}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', rowGap: 2 }}>{payStatusChips(g.payStatusCounts, true)}</div>
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    {canExportData() && (<button type="button" style={stmtBtn} data-testid={`pu-excel-${g.name}`} aria-label={`${g.name} 지급명세서 Excel`} onClick={(e) => { e.stopPropagation(); exportReproStatementExcel(opts); onToast(`${g.name} 지급명세서 Excel을 다운로드했습니다.`); }}>Excel</button>)}
                    <button type="button" style={stmtBtn} data-testid={`pu-pdf-${g.name}`} aria-label={`${g.name} 지급명세서 PDF`} onClick={(e) => { e.stopPropagation(); if (!exportReproStatementPdf(opts)) onToast('팝업 차단을 해제한 후 다시 시도해 주세요.'); }}>PDF</button>
                  </div>
                </div>
              );
            })}
            {payees.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>{loading ? '불러오는 중…' : '지급대상이 없습니다.'}</div>}
          </div>
          {payees.length > 0 && (
            <div data-testid="pu-payee-total" style={{ display: 'grid', gridTemplateColumns: STMT_COLS, gap: '0 8px', alignItems: 'center', fontSize: 12.5, padding: '9px 12px', background: '#f8fafc', borderTop: '2px solid #e5e7eb', fontWeight: 800, color: '#111827' }}>
              <div>합계 ({payees.length}명)</div><div /><div /><div /><div />
              <div style={{ textAlign: 'right' }}>{tot.count}</div>
              <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{won(tot.pre)}</div>
              <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#dc2626' }}>{won(tot.wh)}</div>
              <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#7c3aed' }}>{won(tot.vat)}</div>
              <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} data-testid="pu-payee-total-pay">{won(tot.pay)}{payNote && <div data-testid="pu-payee-total-rounding" style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, whiteSpace: 'normal' }}>{payNote}</div>}{fxAll.length > 0 && <div data-testid="pu-payee-total-fx" style={{ fontSize: 10, color: '#1d4ed8', whiteSpace: 'normal', wordBreak: 'keep-all', overflowWrap: 'anywhere' }}>{fxSummaryText(fxAll)}</div>}</div>
              <div /><div />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 탭 3: 건별 상세내역(통합 조회) — 지급대상·지급상태 필터 + 거래처·판매번호 검색 + 전체 Excel + 하단 합계 ──
function ItemTable({ token, onToast, items, payees, loading, selPayee, setSelPayee, status, setStatus, onChanged, payoutDate }: {
  token: string; onToast: (m: string) => void; items: DetailRow[]; payees: PayeeGroup[]; loading: boolean;
  selPayee: string; setSelPayee: (k: string) => void; status: string; setStatus: (s: string) => void; onChanged: () => void; payoutDate: string | null;
}) {
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return items.filter(r => (selPayee === '__all__' || r.masterKey === selPayee) && (status === 'all' || r.payStatus === status)
      && (!t || [r.client, r.saleNo].some(v => String(v ?? '').toLowerCase().includes(t))));
  }, [items, selPayee, status, q]);
  const clamp2 = { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'normal', lineHeight: 1.35 } as React.CSSProperties;
  const inp: React.CSSProperties = { padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13 };
  // 실지급 합계 = 송금 기준(국내 플랫폼 건 지급대상자별 원 단위 반올림 후 합산). 건별 표시금액 합계와 차이는 원 단위 조정으로 구분.
  const wp = wonPayTotalsOf(rows, payTotalOf, (r) => domesticPayeeKeyOf({ source: r.source, payeeType: r.payeeType, payCurrency: r.payCurrency, userId: r.matchedUserId, vendorId: r.vendorId }));
  const tot = { pre: sumBy(rows, r => r.pretax), wh: sumBy(rows, r => r.withholdingImplied), vat: sumBy(rows, r => r.vat), pay: wp.pay };
  const payNote = roundingNote(wp.exact, wp.adjustment);
  const fxT = fxTotalsOf(rows);
  const HEADS = ['거래처', '판매번호', '지급대상', '언어', '상품/업무', '상세내역', '납품일', '지급예정일', '실제 지급일', '세전금액', '원천세공제', '부가세', '실지급금액', '지급상태', '지급 전환'];
  const AMT = new Set(['세전금액', '원천세공제', '부가세', '실지급금액']);
  const exportAll = () => {
    type R = DetailRow & { _total?: boolean };
    const out: R[] = [...rows, { _total: true, client: `합계 (${rows.length}건)`, pretax: tot.pre, withholdingImplied: tot.wh, vat: tot.vat, payTotal: tot.pay, posttax: tot.pay } as R];
    if (payNote) out.push({ _total: true, _adj: true, client: `※ ${payNote}` } as any);
    const v = (f: (r: R) => unknown) => (r: R) => (r._total ? '' : f(r));
    exportDataset<R>({ filename: `건별상세내역_${payoutDate ?? '지급일미확인'}.xlsx`, sheetName: '건별 상세내역', rows: out, columns: [
      { header: '거래처', value: (r) => r.client ?? '', width: 22 }, { header: '판매번호', value: v(r => r.saleNo ?? ''), width: 16 },
      { header: '지급대상', value: v(r => r.translator ?? ''), width: 16 }, { header: '구분', value: v(r => (r.payeeType === 'vendor' ? '외주업체' : '개인')), width: 9 },
      { header: '언어', value: v(r => r.language ?? ''), width: 12 }, { header: '상품/업무', value: v(r => r.content ?? ''), width: 28 }, { header: '상세내역', value: v(r => r.filename ?? ''), width: 30 },
      { header: '납품일', value: v(r => r.deliveryDate ?? ''), width: 11 }, { header: '지급예정일', value: v(r => r.payoutDate ?? ''), width: 11 }, { header: '실제 지급일', value: v(r => r.actualPaymentDate ?? ''), width: 11 },
      { header: '세전금액', value: (r) => ((r as any)._adj ? '' : r.pretax), type: 'number', width: 13 }, { header: '원천세공제', value: (r) => ((r as any)._adj ? '' : r.withholdingImplied), type: 'number', width: 12 },
      { header: '부가세', value: (r) => ((r as any)._adj ? '' : num(r.vat)), type: 'number', width: 11 }, { header: '실지급금액', value: (r) => ((r as any)._adj ? wp.adjustment : r._total ? tot.pay : isFxRow(r) ? '' : payTotalOf(r)), type: 'number', width: 14 },
      { header: '지급통화', value: (r) => (r._total ? '' : r.payCurrency ?? 'KRW'), width: 8 },
      { header: '외화 지급금액', value: (r) => ((r as any)._adj ? '' : r._total ? fxSummaryText(fxT) : isFxRow(r) ? (r.foreignAmount ?? '') : ''), width: 16 },
      { header: '지급상태', value: v(r => r.payStatusLabel ?? ''), width: 13 }, { header: '지급완료 근거', value: v(r => r.paidBasis ?? ''), width: 30 } ] });
    onToast(`건별 상세내역 ${rows.length}건을 Excel로 내보냈습니다.`);
  };
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <select style={inp} value={selPayee} onChange={e => setSelPayee(e.target.value)} aria-label="지급대상 선택" data-testid="pd-item-payee">
          <option value="__all__">전체 지급대상</option>
          {payees.map(g => <option key={g.masterKey} value={g.masterKey}>{g.name} ({g.count})</option>)}
        </select>
        <select style={inp} value={status} onChange={e => setStatus(e.target.value)} aria-label="지급상태" data-testid="pd-item-status">{PAY_STATUS_FILTER_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <input style={{ ...inp, minWidth: 220 }} value={q} onChange={e => setQ(e.target.value)} placeholder="거래처·판매번호 검색" aria-label="거래처·판매번호 검색" data-testid="pd-item-search" />
        <span style={{ fontSize: 12, color: '#6b7280' }} data-testid="pu-detail-title">{rows.length}건</span>
        {canExportData() && (<button type="button" onClick={exportAll} disabled={!rows.length} data-testid="pd-item-excel-all" aria-label="건별 상세내역 전체 Excel"
          style={{ marginLeft: 'auto', border: 'none', borderRadius: 7, padding: '6px 12px', background: '#059669', color: '#fff', fontWeight: 700, fontSize: 12, cursor: rows.length ? 'pointer' : 'default', opacity: rows.length ? 1 : 0.5 }}>전체 Excel</button>)}
      </div>
      <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 10 }}>
        <table className="veritas-read-table vz-sticky pr-detail-zebra" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr>{HEADS.map(h => <th key={h} style={{ padding: '9px 12px', textAlign: AMT.has(h) ? 'right' : 'left', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((p, i) => (
              <tr key={p.sourceKey} data-testid={`pu-detail-${i}`} data-source={p.source} data-status={p.payStatus}>
                <td style={{ ...td, whiteSpace: 'normal', maxWidth: 180 }} title={p.client ?? undefined}><div style={clamp2}>{p.client ?? <span style={{ color: '#b45309', fontWeight: 700 }}>거래처 확인 필요</span>}</div></td>
                <td style={td}><SaleLink projectId={p.projectId} saleNo={p.saleNo} testid={`pu-detail-sale-${i}`} /></td>
                <td style={{ ...td, whiteSpace: 'normal', lineHeight: 1.35 }}>
                  <div style={{ fontWeight: 600, color: '#111827' }}>{p.translator ?? '-'}{p.payeeType === 'vendor' && <span style={{ marginLeft: 4, fontSize: 10, color: '#7c3aed', fontWeight: 700 }}>외주업체</span>}</div>
                  {(p.masterEmail || p.masterPhone) && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }} title="현재 명부 등록 연락처">{p.masterEmail && <div>{p.masterEmail}</div>}{p.masterPhone && <div>{p.masterPhone}</div>}</div>}
                </td>
                <td style={{ ...td, whiteSpace: 'normal', maxWidth: 140 }}>{p.language ?? '-'}</td>
                <td style={{ ...td, maxWidth: 200 }} title={p.content ?? undefined}><div style={clamp2}>{p.content ?? '-'}</div></td>
                <td style={{ ...td, maxWidth: 230 }} title={p.filename ?? undefined}><div style={clamp2}>{p.filename ?? '-'}</div></td>
                <td style={td}>{p.deliveryDate ? formatDisplayDate(p.deliveryDate) : <span style={{ color: '#b45309' }}>(납품일 미상)</span>}</td>
                <td style={td}>{p.payoutDate ? formatDisplayDate(p.payoutDate) : <span style={{ color: '#b45309', fontWeight: 700 }}>(지급일 미확인)</span>}</td>
                <td style={td} data-testid={`pu-detail-actual-${i}`}>{p.actualPaymentDate ? formatDisplayDate(p.actualPaymentDate) : <span style={{ color: '#d1d5db' }}>-</span>}</td>
                <td style={tdR}>{won(p.pretax)}</td>
                <td style={{ ...tdR, color: '#dc2626' }}>{won(p.withholdingImplied)}
                  {p.taxConflict && <div title={p.taxConflict} style={{ fontSize: 10, color: '#c2410c', fontWeight: 700 }}>⚠ 세금 확인</div>}</td>
                <td style={{ ...tdR, color: '#7c3aed' }}>{p.payeeType === 'vendor' ? (p.vat != null ? won(p.vat) : '미확정') : '-'}</td>
                <td style={{ ...tdR, fontWeight: 700 }}>{isFxRow(p)
                  ? <span data-testid={`pu-detail-fx-${i}`} style={{ color: '#1d4ed8' }} title="외화 지급 — 원화 합계 제외(별도 해외송금)">{fxCell(p)}</span>
                  : won(payTotalOf(p))}</td>
                <td style={td}><span title={p.paidBasis ? `지급완료 근거: ${p.paidBasis}` : undefined}><PayStatusBadge status={p.payStatus} label={p.payStatusLabel} testid={`pu-detail-status-${i}`} /></span></td>
                <td style={td}>{p.source === 'legacy'
                  ? <ConversionCell token={token} rowId={p.id} conversion={p.conversion ?? null} eligible={!!p.conversionEligible} onToast={onToast} onChanged={onChanged} />
                  : <span style={{ color: '#d1d5db' }}>-</span>}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={HEADS.length} style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>{loading ? '불러오는 중…' : '상세 내역이 없습니다.'}</td></tr>}
          </tbody>
          {rows.length > 0 && (
            <tfoot><tr data-testid="pu-detail-total" style={{ background: '#f8fafc', fontWeight: 800 }}>
              <td style={{ ...td, fontWeight: 800 }} colSpan={9}>합계 ({rows.length}건)</td>
              <td style={{ ...tdR, fontWeight: 800 }}>{won(tot.pre)}</td>
              <td style={{ ...tdR, fontWeight: 800, color: '#dc2626' }}>{won(tot.wh)}</td>
              <td style={{ ...tdR, fontWeight: 800, color: '#7c3aed' }}>{won(tot.vat)}</td>
              <td style={{ ...tdR, fontWeight: 800 }} data-testid="pd-item-total-pay">{won(tot.pay)}{payNote && <div data-testid="pd-item-total-rounding" style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, whiteSpace: 'normal' }}>{payNote}</div>}{fxT.length > 0 && <div style={{ fontSize: 10, color: '#1d4ed8' }}>{fxSummaryText(fxT)}</div>}</td>
              <td style={td} colSpan={2} />
            </tr></tfoot>
          )}
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
          // 서버 수집 조건과 같은 기준: 최종 지급예정일(수동 지정 → 자동 산정, 서버 expectedPaymentDate) = 지급일. 납품일로 대체하지 않는다.
          const list = r.ok ? (d.summary ?? []).flatMap((g: any) => g.items ?? []).filter((it: any) => String(it.expectedPaymentDate ?? '').slice(0, 10) === payoutDate) : [];
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
            style={{ marginLeft: 'auto', padding: '7px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, border: 'none', background: '#0369a1', color: '#fff', cursor: 'pointer' }}>+ 지급회차 생성 ({formatDisplayDate(payoutDate)})</button>
        )}
      </div>

      {!roundSel && preview && (
        <div data-testid="pd-op-preview" style={{ border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 12, overflowX: 'auto' }}>
          <div style={{ padding: '8px 12px', fontSize: 12.5, fontWeight: 700, background: '#f0f9ff', color: '#0369a1' }}>
            수집 예정 {preview.length}건 — 지급예정일 {formatDisplayDate(payoutDate)} · 미지급·미배정·납품확인·지급액 확정 건(회차 생성 시 지급예정일 기준으로 자동수집)
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
                    <td style={td}>{i.translator ?? '-'}</td><td style={td}>{i.client ?? '-'}</td><td style={td}>{formatDisplayDate(i.deliveryDate) || '-'}</td><td style={td}>{formatDisplayDate(i.payoutDate) || '-'}</td>
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
