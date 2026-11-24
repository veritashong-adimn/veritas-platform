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
import { orderBySale } from '../../lib/payoutReadinessExcelOrder';

type Blocker = { cat: 'B' | 'C' | 'D' | 'I'; code: string; text: string; action: string };
type Item = {
  source: string; kind: 'platform' | 'crm_converted' | 'crm_only'; sourceKey: string; crmRowId: number | null; assignmentId: number | null;
  projectId: number | null; projectTitle: string | null; saleNo: string | null; quoteNumber: string | null; payee: string | null; client: string | null;
  masterId?: number | null; vendorId?: number | null;
  residentNumberMasked?: string | null;   // 통번역사 명부 주민번호(마스킹 '900101-*******'), 없으면 null
  payeePhone?: string | null; payeeEmail?: string | null;   // 명부 연락처·이메일(수행자 ID 기준, 엑셀 전용), 없으면 null
  payeeLanguages?: string | null; payeeDetail?: string | null;   // 실제 수행자 통번역사 Master 명부 가능언어·상세정보(원문, 엑셀 전용), 없으면 null
  productWork?: string | null;   // 판매상세 C. 수행정보 '상품·업무' 원문(CRM 원본만 있는 건 = 원본 업무정보, 엑셀 전용), 없으면 null
  deliveryDate: string | null; payoutDate: string | null; actualPaymentDate: string | null;
  dateMismatch?: boolean;   // CRM·플랫폼 날짜 불일치(덮어쓰지 않음 — 사유에 상세)
  // 지급상태 표시(서버 공통 판정 — 화면·엑셀 같은 값) · 판매금액(판매정보 저장값, CRM 원본만 있는 건 null)
  payDisplay?: 'paid' | 'review' | 'prep' | 'scheduled' | 'hold' | 'excluded'; payDisplayLabel?: string;
  saleAmount?: { supply: number; vat: number; total: number } | null;
  pretax: number; withholding: number; posttax: number;
  // 지급통화(KRW 기본)·외화 지급금액 — 외화 건은 원화 합계와 별도 집계·원화 송금파일 제외. amountSource: 금액 출처(platform_fallback = CRM 0원 → 수행정보)
  payCurrency?: string; foreignAmount?: number | null; amountSource?: 'platform' | 'crm' | 'platform_fallback';
  crmPretax?: number | null; crmPosttax?: number | null;   // CRM 원본 지급액(보존·참고)
  // 지급금액 구분(서버 lib/payoutAmount — 지급명세서와 같은 기준): 개인 세전/원천세/세후 · 외주업체 공급가/부가세/지급합계
  payeeType?: 'individual' | 'vendor'; payeeTypeLabel?: string; vendorName?: string | null;
  performerName?: string | null;
  sourcePayeeName?: string | null;   // 명부 최신 이름과 다른 원본 이름(CRM·수행정보 스냅샷) — 이력 표시·검색용   // 외주업체 지급 건의 실제 수행자(CRM 통번역사명 등), 없으면 null
  payAmount?: { withholding: number; supply: number | null; vat: number | null; payTotal: number }; taxConflict?: string | null;
  paymentStatus: string; payoutRoundId: number | null; hasAccount: boolean; roundEligible: boolean; candidate: string; countedInTotals: boolean;
  state: 'A' | 'B' | 'C' | 'D'; stateLabel: string; blockers: Blocker[]; actions: string[];
};
type Sum = { count: number; counted: number; pretax: number; posttax: number };
type Resp = { canRevealResidentNumber?: boolean; scope: 'date' | 'all'; payoutDate: string | null; deliveryWindow: { from: string; to: string } | null; items: Item[];
  summary: { total: Sum; foreignTotals?: { currency: string; count: number; amount: number; missing: number }[]; byState: Record<string, Sum>; byKind: Record<string, Sum>; byCandidate: Record<string, Sum>; roundEligible: Sum; duplicates: number; issueCounts: Record<string, number> } };

const STATE_STYLE: Record<string, { bg: string; c: string }> = {
  A: { bg: '#dcfce7', c: '#15803d' }, B: { bg: '#e0f2fe', c: '#0369a1' }, C: { bg: '#fef3c7', c: '#92400e' }, D: { bg: '#fee2e2', c: '#b91c1c' }, I: { bg: '#f1f5f9', c: '#475569' },
};
const STATE_LABEL: Record<string, string> = { A: '지급 준비 완료', B: '계좌정보 확인 필요', C: '금액·세금·수행정보 확인 필요', D: '과거 지급 여부·중복 확인 필요' };
const KIND_LABEL: Record<string, string> = { platform: '플랫폼', crm_converted: 'CRM 전환', crm_only: 'CRM 원본' };
const CAND_LABEL: Record<string, string> = { base: '지급 후보(지급일 일치)', delivery_window: '추가: 납품기간 납품', carry_over: '추가: 지급일 경과(이월)', no_payout_date: '추가: 지급예정일 없음', other: '추가: 기타', all: '전체 기간' };
const STATUS_LABEL: Record<string, string> = { unpaid: '미지급', payment_hold: '지급보류', paid: '지급완료', unconfirmed: '확인 전(CRM)' };
// 화면·엑셀 지급상태 표시 — 서버 판정(payDisplayLabel) 우선, 없으면(구버전 응답) 기존 표시
const payLabel = (r: Item) => r.payDisplayLabel ?? STATUS_LABEL[r.paymentStatus] ?? r.paymentStatus;
const PAY_COLOR: Record<string, string> = { paid: '#15803d', review: '#b45309', prep: '#b91c1c', scheduled: '#1d4ed8', hold: '#7c3aed', excluded: '#64748b' };
const won = (n: number) => Math.round(n || 0).toLocaleString('ko-KR');
// Excel 연락처 — 숫자만 있는 국내 휴대전화(010·011·016·017·018·019)만 하이픈 적용(01090444203 → 010-9044-4203).
//   해외 번호·이미 형식이 있는 번호·마스킹 번호(*)는 그대로. 셀은 문자열로 출력(앞자리 0 유지).
const excelPhone = (v: string | null | undefined): string => {
  const t = String(v ?? '').trim();
  if (!/^01[016789]\d{7,8}$/.test(t)) return t;
  return t.length === 11 ? `${t.slice(0, 3)}-${t.slice(3, 7)}-${t.slice(7)}` : `${t.slice(0, 3)}-${t.slice(3, 6)}-${t.slice(6)}`;
};
// 누락·확인필요 사유(표시 전용) — 담당자가 확인·조치할 항목만 짧은 문구로. 내부 검증·분류(A~D)·지급 차단 판정은 서버 그대로.
//   참고(I) 사유(지급회차 미배정·수행정보 기준 반영·외화 원화 합계 제외·환율 미확정)와 송금파일 제외 안내(overseas)는 표시하지 않는다.
//   같은 문구는 한 번만, 여러 개면 쉼표로 구분. 확인할 것이 없으면 공란. 처음 보는 코드는 원문 그대로 표시(경고 누락 방지).
const REASON_LABEL: Record<string, string | null> = {
  legacy_review: '과거 지급 여부 확인', crm_unconfirmed: '과거 지급 여부 확인', conversion_blocked: '과거 지급 여부 확인', overdue: '과거 지급 여부 확인',
  paid_no_actual: '지급완료 기록 확인',
  amount_missing: '지급금액 미입력', amount_mismatch: '지급금액 확인',
  no_account: '계좌 미등록', no_holder: '계좌 미등록',
  no_tax: '세금처리 미설정', tax_review: '세금처리 확인', tax_conflict: '세금처리 확인',
  no_payee: '수행자 미연결',
  payee_deleted: '수취인 명부 확인', payee_type_check: '수취인 명부 확인', payee_hold: '수취인 명부 확인',
  no_confirm: '납품확인 필요', no_delivery: '납품일 미입력', no_payout_date: '지급예정일 미입력',
  date_mismatch: '납품일 불일치', payout_date_mismatch: '지급예정일 확인', date_order: '지급예정일 확인', window_mismatch: '지급예정일 확인',
  foreign_amount_missing: '외화 지급금액 미입력',
  dup_crm: '중복 지급 확인', dup_platform: '중복 지급 확인', already_paid: '중복 지급 확인',
  overseas: null,
  payment_hold: '지급보류',
};
const REASON_ORDER = ['지급보류', '과거 지급 여부 확인', '지급완료 기록 확인', '지급금액 미입력', '지급금액 확인', '계좌 미등록', '세금처리 미설정', '세금처리 확인', '수행자 미연결',
  '수취인 명부 확인', '납품확인 필요', '납품일 미입력', '지급예정일 미입력', '납품일 불일치', '지급예정일 확인', '외화 지급금액 미입력', '중복 지급 확인'];
const reasonText = (r: Item): string => {
  const out = new Set<string>();
  for (const b of r.blockers) {
    if (b.cat === 'I') continue;
    const l = b.code in REASON_LABEL ? REASON_LABEL[b.code] : b.text;
    if (l) out.add(l);
  }
  return [...out].sort((a, b) => (REASON_ORDER.indexOf(a) + 1 || 99) - (REASON_ORDER.indexOf(b) + 1 || 99)).join(', ');
};
const isFx = (r: Item) => !!r.payCurrency && r.payCurrency !== 'KRW';
const fxAmt = (cur: string, v: number | null | undefined) => v == null ? `${cur} 미입력` : `${cur} ${v.toLocaleString('ko-KR', { minimumFractionDigits: cur === 'JPY' ? 0 : 2, maximumFractionDigits: 2 })}`;
const isVendor = (r: Item) => r.payeeType === 'vendor';
// 지급금액 열(개인·외주 구분) — 해당하지 않는 쪽은 공란. 외주 부가세 미확정(null)은 공란(임의 생성 안 함).
const indiv = (r: Item, k: 'pretax' | 'withholding' | 'posttax') => (isVendor(r) ? '' : r[k]);
const vend = (r: Item, k: 'supply' | 'vat' | 'payTotal') => (!isVendor(r) ? '' : (r.payAmount?.[k] ?? ''));
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
      && (!s || [i.payee, i.performerName, i.sourcePayeeName, i.client, i.saleNo, i.quoteNumber, i.projectTitle, i.sourceKey, String(i.crmRowId ?? ''), String(i.projectId ?? '')].some(v => String(v ?? '').toLowerCase().includes(s))));
  }, [data, state, kind, cand, q]);

  const [fullBusy, setFullBusy] = useState(false);
  // full: 관리자 전용 전체번호 엑셀 — 수행자 ID → 전체 주민번호(별도 API, 메모리에서만 사용·저장 안 함)
  const exportExcel = (full?: Map<number, string>) => {
    const rrn = (r: Item) => {
      if (r.vendorId != null || r.masterId == null) return '';
      return full ? (full.get(r.masterId) ?? '') : (r.residentNumberMasked ?? '');
    };
    // 판매금액(고객)은 판매건 단위 값 — 같은 판매건의 모든 수행 행에 같은 값을 표시한다(행별 확인용).
    //   판매금액 합계를 낼 때는 판매건(판매ID)당 한 번만 집계해야 한다(행 단위 합산 시 중복). 지급금액 열·합계는 변경 없음.
    const amt = (r: Item, k: 'supply' | 'vat' | 'total') => (r.saleAmount ? r.saleAmount[k] : '');
    exportDataset<Item>({
      filename: (scope === 'date' ? `지급준비점검_${date}` : `지급누락점검_전체기간`) + (full ? '_주민번호전체' : '') + '.xlsx', sheetName: scope === 'date' ? '지급준비점검' : '지급누락점검',
      columns: [
        { header: '출처', value: (r) => KIND_LABEL[r.kind] ?? r.kind, width: 9 },
        { header: '거래처', value: (r) => r.client ?? '', width: 22 },
        { header: '판매번호', value: (r) => r.saleNo ?? r.quoteNumber ?? '', width: 16 },
        { header: '프로젝트', value: (r) => r.projectTitle ?? '', width: 22 },
        // 고객 판매금액(판매건 단위) — 지급금액과 혼동되지 않게 '판매' 표기
        { header: '공급가', value: (r) => amt(r, 'supply'), type: 'number', width: 14 },
        { header: '부가세', value: (r) => amt(r, 'vat'), type: 'number', width: 13 },
        { header: '총액', value: (r) => amt(r, 'total'), type: 'number', width: 14 },
        { header: '통번역사·외주업체', value: (r) => r.payee ?? '', width: 16 },
        { header: '상품·업무', value: (r) => r.productWork ?? '', width: 40 },   // 원문 그대로(요약·생략 없음)
        { header: '언어', value: (r) => r.payeeLanguages ?? '', width: 18 },
        { header: '상세정보', value: (r) => r.payeeDetail ?? '', width: 30 },
        { header: '연락처', value: (r) => excelPhone(r.payeePhone), width: 15 },   // 문자열 셀(앞자리 0 유지)
        { header: '이메일', value: (r) => r.payeeEmail ?? '', width: 24 },
        { header: '주민등록번호', value: (r) => rrn(r), width: 16 },
        { header: '납품일', value: (r) => r.deliveryDate ?? '', width: 11 },
        { header: '지급예정일', value: (r) => r.payoutDate ?? '', width: 11 },
        { header: '세전', value: (r) => indiv(r, 'pretax'), type: 'number', width: 13 },
        { header: '원천세', value: (r) => indiv(r, 'withholding'), type: 'number', width: 13 },
        { header: '세후', value: (r) => indiv(r, 'posttax'), type: 'number', width: 13 },
        { header: '외주 공급가', value: (r) => vend(r, 'supply'), type: 'number', width: 13 },
        { header: '외주 부가세', value: (r) => vend(r, 'vat'), type: 'number', width: 13 },
        { header: '외주 합계', value: (r) => vend(r, 'payTotal'), type: 'number', width: 14 },
        { header: '최종 지급액', value: (r) => (isFx(r) ? '' : (r.payAmount?.payTotal ?? r.posttax)), type: 'number', width: 14 },
        // 지급통화(KRW 기본)·외화 지급금액 — 외화 건은 원화 합계와 별도, 국내 원화 송금파일 제외. 환율 미확정 원화 원가는 확정값 아님.
        { header: '지급통화', value: (r) => r.payCurrency ?? 'KRW', width: 8 },
        { header: '외화 지급금액', value: (r) => (isFx(r) ? (r.foreignAmount ?? '') : ''), type: 'number', width: 13 },
        { header: '지급상태', value: (r) => payLabel(r), width: 13 },
        { header: '계좌', value: (r) => (r.hasAccount ? '등록' : '미등록'), width: 7 },
        { header: '누락·확인필요 사유', value: (r) => reasonText(r), width: 40 },
      ],
      rows: orderBySale(rows),   // 같은 판매건 연속 표시(개인 → 외주업체) — 출력 순서만, 화면 목록 순서 불변
    });
    onToast(`${rows.length}건을 Excel로 내보냈습니다.${full ? ' (주민번호 전체 — 외부 유출 주의)' : ''}`);
  };
  const exportFullExcel = async () => {
    const ids = [...new Set(rows.filter(r => r.vendorId == null && r.masterId != null).map(r => r.masterId as number))];
    if (!ids.length) { exportExcel(new Map()); return; }
    setFullBusy(true);
    try {
      const r = await fetch(api('/api/admin/payout-unified/readiness/resident-numbers'), {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ translatorIds: ids }) });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
      exportExcel(new Map(Object.entries(d?.residentNumbers ?? {}).map(([k, v]) => [Number(k), String(v)])));
    } catch (e) { onToast((e as Error).message || '주민번호 전체 엑셀 출력 실패'); }
    finally { setFullBusy(false); }
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
          {open && data && <button type="button" onClick={() => exportExcel()} data-testid="ready-excel" aria-label="지급 준비 점검 Excel"
            style={{ border: 'none', borderRadius: 7, padding: '5px 10px', background: '#059669', color: '#fff', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>Excel</button>}
          {open && data?.canRevealResidentNumber && <button type="button" onClick={exportFullExcel} disabled={fullBusy} data-testid="ready-excel-full-rrn" aria-label="주민번호 전체 Excel(관리자 전용)"
            title="관리자 전용 — 주민등록번호 전체가 포함됩니다. 외부 유출에 주의하세요."
            style={{ border: '1px solid #b91c1c', borderRadius: 7, padding: '5px 10px', background: '#fff', color: '#b91c1c', fontWeight: 700, fontSize: 12, cursor: fullBusy ? 'wait' : 'pointer' }}>{fullBusy ? '출력 중…' : '전체번호 Excel'}</button>}
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
                  {(data.summary.foreignTotals ?? []).map(f => <span key={f.currency} data-testid={`ready-fx-total-${f.currency}`} style={{ marginLeft: 8, color: '#4338ca', fontWeight: 700 }}>
                    외화 {f.currency} {f.count}건 · {fxAmt(f.currency, f.amount)}{f.missing ? ` (금액 미입력 ${f.missing}건)` : ''} <span style={{ fontWeight: 400, color: '#6b7280' }}>(원화 합계 별도)</span></span>)}
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
                  <thead style={{ position: 'sticky', top: 0 }}><tr>{['상태', '후보', '출처', '거래처', '판매번호·프로젝트', 'CRM행', '통번역사·외주업체', '납품일', '지급예정일', '실제 지급일', '세전·공급가', '원천세·부가세', '세후·지급합계', '지급상태', '회차', '계좌', '누락·확인필요 사유', '필요한 조치'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.sourceKey} data-testid={`ready-row-${r.sourceKey}`} data-state={r.state} data-candidate={r.candidate} style={r.countedInTotals ? undefined : { background: '#fff7ed' }}>
                        <td style={td}><span style={{ fontSize: 11, fontWeight: 700, padding: '1px 7px', borderRadius: 7, background: STATE_STYLE[r.state].bg, color: STATE_STYLE[r.state].c }}>{r.state}</span></td>
                        <td style={{ ...td, fontSize: 11, color: r.candidate === 'base' || r.candidate === 'all' ? '#334155' : '#b45309' }}>{CAND_LABEL[r.candidate] ?? r.candidate}</td>
                        <td style={td}>{KIND_LABEL[r.kind]}</td>
                        <td style={{ ...td, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.client ?? ''}>{r.client ?? '—'}</td>
                        <td style={{ ...td, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.projectTitle ?? ''}>{r.saleNo ?? r.quoteNumber ?? (r.projectId ? `#${r.projectId}` : '—')}{r.projectTitle ? <div style={{ fontSize: 10.5, color: '#94a3b8' }}>{r.projectTitle}</div> : null}</td>
                        <td style={{ ...td, color: '#64748b' }}>{r.crmRowId ?? '—'}</td>
                        <td style={{ ...td, fontWeight: 700 }}>{r.payee ?? '—'}
                          <div data-testid={`ready-payee-type-${r.sourceKey}`} style={{ fontSize: 10.5, fontWeight: 700, color: isVendor(r) ? '#7c3aed' : '#64748b' }}>
                            {isVendor(r) ? `외주업체${r.vendorName && r.vendorName !== r.payee ? ` · ${r.vendorName}` : ''}${r.performerName ? ` · 수행 ${r.performerName}` : ''}` : `개인${r.sourcePayeeName ? ` · 원본명 ${r.sourcePayeeName}` : ''}`}</div></td>
                        <td style={{ ...td, color: r.deliveryDate ? undefined : '#b91c1c' }}>{r.deliveryDate ?? '공란'}
                          {r.dateMismatch && <span title="CRM·플랫폼 날짜 불일치 — 사유 참고" aria-label="날짜 불일치" data-testid={`ready-date-mismatch-${r.sourceKey}`} style={{ marginLeft: 4, color: '#c2410c', fontWeight: 700 }}>⚠</span>}</td>
                        <td style={{ ...td, color: r.payoutDate ? undefined : '#b91c1c' }}>{r.payoutDate ?? '공란'}</td>
                        <td style={td}>{r.actualPaymentDate ?? '—'}</td>
                        <td style={{ ...td, textAlign: 'right' }}>{won(r.pretax)}<div style={{ fontSize: 10, color: '#94a3b8' }}>{isVendor(r) ? '공급가' : '세전'}</div></td>
                        <td style={{ ...td, textAlign: 'right' }} data-testid={`ready-tax-${r.sourceKey}`}>
                          {isVendor(r)
                            ? (r.payAmount?.vat != null ? won(r.payAmount.vat) : '—')
                            : won(r.withholding)}
                          <div style={{ fontSize: 10, color: '#94a3b8' }}>{isVendor(r) ? (r.payAmount?.vat != null ? '부가세' : '부가세 미확정') : '원천세'}</div>
                          {r.taxConflict && <div title={r.taxConflict} style={{ fontSize: 10, color: '#c2410c', fontWeight: 700 }}>⚠ 세금 확인</div>}</td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{isFx(r)
                            ? <span data-testid={`ready-fx-${r.sourceKey}`} style={{ color: '#4338ca' }}>{fxAmt(r.payCurrency!, r.foreignAmount)}<div style={{ fontSize: 10, color: '#b45309', fontWeight: 400 }}>외화 지급 · 원화 미확정</div></span>
                            : won(r.payAmount?.payTotal ?? r.posttax)}{!isFx(r) && <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 400 }}>{isVendor(r) ? '지급합계' : '세후'}</div>}{!r.countedInTotals && <div style={{ fontSize: 10, color: '#c2410c' }}>합계 제외(중복)</div>}</td>
                        <td style={{ ...td, fontWeight: 700, color: PAY_COLOR[r.payDisplay ?? ''] }} data-testid={`ready-pay-${r.sourceKey}`}>{payLabel(r)}</td>
                        <td style={td}>{r.payoutRoundId ? `#${r.payoutRoundId}` : '—'}</td>
                        <td style={{ ...td, color: r.hasAccount ? '#15803d' : '#b91c1c' }}>{r.hasAccount ? '등록' : '미등록'}</td>
                        <td style={{ ...td, whiteSpace: 'normal', minWidth: 260, fontSize: 11.5 }}>
                          {(() => { const t = reasonText(r); return t
                            ? <span data-testid={`ready-reason-${r.sourceKey}`} title={r.blockers.filter(b => b.cat !== 'I').map(b => b.text).join('\n')}>{t}</span> : null; })()}
                        </td>
                        <td style={{ ...td, whiteSpace: 'normal', minWidth: 220, fontSize: 11.5, color: '#334155' }}>{r.actions.length ? r.actions.map((a, i) => <div key={i}>· {a}</div>) : '—'}</td>
                      </tr>
                    ))}
                    {rows.length === 0 && <tr><td colSpan={18} style={{ ...td, textAlign: 'center', color: '#9ca3af', padding: 18 }}>해당 건이 없습니다.</td></tr>}
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
