// 과거 지급 재현 → 통번역사별 정식 지급명세서(Excel/PDF) 매핑 — READ-ONLY.
//  · payoutReproduction(/payees) 의 원본값(세전=지급액(세전), 세후=지금액(세후), 원본공제=세전-세후)을
//    기존 정식 명세서 양식(downloadStatementExcel / printPayoutStatementPdf)에 "그대로" 매핑한다.
//  · 계산·재계산 없음(원본값 전달만). DB/원본 변경 없음. 모던 지급회차와 무관(재현 전용).
//  · 거래처는 과거 CRM 원본 '거래처명'을 그대로 표시한다(없으면 '거래처 확인 필요'). 임의 추정/Master 덮어쓰기 없음.
//  · 상세내역 = 해당 수행 건의 과거 진행관리표 '파일명' 원본값(화면 파일명과 동일 행 ID 기준). 없으면 '-'.
//  · '구분'·'수행일' 열은 제거(원본에 분해값 없음). 작업량/단가/기타비용/차감 분해도 없어 '-'/0으로 둔다.
//    (세전=통번역료로 간주, 기타비용·차감=0, 공제=원본 세전-세후, 실지급=세후)
import { downloadStatementExcel, todayStamp, type ExcelCell, type ExcelColumn } from './payoutExcel';
import { printPayoutStatementPdf, payeeLanguageLabel, type PayoutStatementPdfRow } from './payoutStatementPdf';

/** 명세서 상단 수행 언어(지급명세서·지급회차관리 공용) — 통번역사 Master 가능언어(확정 연결 건) 우선,
 *  없으면 명세서에 담긴 건들의 원본 수행 언어(Master 대체값 제외). 중복 제거, 없으면 null(이름만 표시). */
export function reproPayeeLanguages(items: { masterLanguages?: string | null; language?: string | null; languageSource?: string | null }[]): string | null {
  const master = items.map(r => r.masterLanguages).find(Boolean) ?? null;
  const performed = items.map(r => (r.languageSource === 'master' ? null : r.language ?? null));
  return payeeLanguageLabel(master, performed);
}

export interface ReproStmtRow {
  client: string | null;    // 과거 CRM 원본 거래처명(없으면 '거래처 확인 필요')
  filename: string | null;  // 상세내역 — 과거 진행관리표 원본 파일명(없으면 '-')
  deliveryDate: string | null;
  payoutDate: string | null;
  content: string | null;   // 상품 · 언어
  pretax: number;
  posttax: number;
  // 외화 지급(2026-11-25) — 지급통화·외화 지급금액(수행정보 값 그대로). 원화 금액과 합산하지 않고 상세내역·합계 안내에 별도 표시.
  payCurrency?: string | null;
  foreignAmount?: number | null;
  // 수행정보 세금처리 유형(표시 전용, 2026-11-25) — withholding_treatment·수동세율. 없으면(CRM 원본만) 기존 표기(원천징수 3.3%).
  withholdingTreatment?: string | null;
  withholdingRate?: number | null;
}
export interface ReproStmtOpts {
  payeeName: string;
  payeeLanguages?: string | null;   // 지급명세서 상단 수행 언어(payeeLanguageLabel 결과). 없으면 이름만.
  email?: string | null;
  phone?: string | null;    // 연락처(휴대폰) — Master 등록 우선, 없으면 원본 CRM 연락처(§3). 없으면 '-'.
  scopeValue: string;       // 지급회차 라벨(예: "2026-09-15 지급")
  payDate: string;          // 대표 지급일('-' 가능)
  rows: ReproStmtRow[];
  // 지급대상 구분(2026-11-23) — 외주업체면 원천징수 대신 부가세(세후−세전 저장값 차액)로 표시. 생략 시 개인(기존과 동일).
  payeeType?: 'individual' | 'vendor';
}

const num = (n: unknown) => { const v = Number(n); return Number.isFinite(v) ? v : 0; };
const safe = (s: string) => String(s || '지급대상').replace(/[\\/:*?"<>|\s]+/g, '_');
// 수행정보 세금처리 미등록(CRM 원본만 있는 과거 재현 건) 기본 표기 — 기존과 같음
const TAX_DISPLAY = '원천징수 3.3%';
const rateTxt = (n: number | null | undefined) => (n != null && Number.isFinite(Number(n)) ? `${Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}%` : '세율 미확정');
// 개인 세금처리 표기 — 수행정보에 등록된 실제 세금처리 유형(표시만, 세금 계산·금액은 원본값 그대로)
function treatmentLabel(r: ReproStmtRow): string {
  switch (r.withholdingTreatment) {
    case 'domestic_3_3': return '원천징수 3.3%';
    case 'domestic_2_2': return '원천징수 2.2%';
    case 'exempt': return '원천징수 제외';
    case 'nonresident_custom': return `비거주자 원천징수 ${rateTxt(r.withholdingRate)}`;
    case 'treaty_reduction_or_exemption': return `조세조약 감면·면제 ${rateTxt(r.withholdingRate)}`;
    case 'tax_review_required': return '세무 확인 필요';
    default: return TAX_DISPLAY;
  }
}
// 명세서 머리 세금처리 — 행들의 유형이 하나면 그 표기, 여러 개면 함께 표시
const headTaxLabel = (rows: ReproStmtRow[]) => { const s = [...new Set(rows.map(treatmentLabel))]; return s.length ? s.join(' · ') : TAX_DISPLAY; };
const isFx = (r: ReproStmtRow) => !!r.payCurrency && r.payCurrency !== 'KRW';
const fxText = (cur: string, amt: number | null | undefined) => `${cur} ${amt != null ? amt.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '금액 미입력'}`;
// 행 상세내역 — 외화 지급 건은 '외화 지급 USD 1,500' 을 함께 표시
const detailOf = (r: ReproStmtRow) => isFx(r) ? `${r.filename || '-'} · 외화 지급 ${fxText(r.payCurrency!, r.foreignAmount)}` : (r.filename || '-');
// 외화 지급 합계(통화별) — 원화 합계와 별도. 없으면 null
function fxSummary(rows: ReproStmtRow[]): string | null {
  const m = new Map<string, { amt: number; missing: number }>();
  for (const r of rows) if (isFx(r)) { const g = m.get(r.payCurrency!) ?? { amt: 0, missing: 0 }; if (r.foreignAmount != null) g.amt = Math.round((g.amt + r.foreignAmount) * 100) / 100; else g.missing++; m.set(r.payCurrency!, g); }
  if (!m.size) return null;
  return [...m.entries()].map(([c, g]) => `${fxText(c, g.amt)}${g.missing ? ` (금액 미입력 ${g.missing}건)` : ''}`).join(' · ') + ' — 원화 합계 제외(별도 해외송금)';
}

function totals(rows: ReproStmtRow[], vendor = false) {
  const gross = rows.reduce((a, r) => a + num(r.pretax), 0);
  const net = rows.reduce((a, r) => a + num(r.posttax), 0);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  // 개인: 원본 세전−세후(실제 공제) / 외주업체: 원천징수 없음. 부가세 = 행별 세후−세전(가산분)만 합산.
  //   외주업체인데 CRM 기록에 공제(세후<세전)가 있으면 음수 부가세로 만들지 않고 'CRM 공제 기록'으로 그대로 표시(확인 필요, lib/payoutAmount 와 같은 기준).
  const withholding = vendor ? r2(rows.reduce((a, r) => a + Math.max(0, num(r.pretax) - num(r.posttax)), 0)) : r2(gross - net);
  const vat = vendor ? r2(rows.reduce((a, r) => a + Math.max(0, num(r.posttax) - num(r.pretax)), 0)) : 0;
  return { base: gross, expense: 0, deduction: 0, gross, withholding, net, vat };
}
// ── 외화 포함 지급명세서(2026-11) — 외화 행이 하나라도 있을 때만 사용(원화만 있는 명세서는 위 기존 계산·양식 그대로) ──
//  · '통번역료' 열 → '지급금액'. 외화 행 금액 = 저장된 외화 지급금액(수행정보 contract_amount_foreign) 그대로, 통화 표기. 미입력 = '미입력'.
//  · 외화 기타비용·차감 = '—'(외화 분해 저장값 없음 — 상품명·비고에서 금액 추출 안 함).
//  · 원천징수 제외(외주업체 포함) 외화: 세전금액 = 실지급액 = 외화 지급금액. 그 외 세금처리는 계산하지 않고 '세금 확인 필요'.
//  · 합계·최종 실지급액은 통화별로 구분(원화와 합산·원화 환산 없음). 미입력 건은 입력된 금액만 합계하고 '미확정' 안내.
const FX_MISSING = '미입력';
const TAX_UNKNOWN = '세금 확인 필요';
const DASH = '—';
const CUR_NO_DECIMAL = new Set(['JPY', 'KRW']);
const fxAmt = (cur: string, n: number) => { const d = CUR_NO_DECIMAL.has(cur) ? 0 : 2; return `${cur} ${n.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d })}`; };
const wonTxt = (n: number) => `${Math.round(n).toLocaleString('ko-KR')}원`;
const fxNoTax = (r: ReproStmtRow, vendor: boolean) => vendor || r.withholdingTreatment === 'exempt';
type FxGroup = { cur: string; count: number; amount: number; missing: number; taxUnknown: number };
type FxCells = { base: string; expense: string; deduction: string; gross: string; tax: string; net: string };
function fxStatement(rows: ReproStmtRow[], vendor: boolean) {
  const krw = rows.filter(r => !isFx(r));
  const hasKrw = krw.length > 0;
  const tK = totals(krw, vendor);
  const gm = new Map<string, FxGroup>();
  for (const r of rows) {
    if (!isFx(r)) continue;
    const g = gm.get(r.payCurrency!) ?? { cur: r.payCurrency!, count: 0, amount: 0, missing: 0, taxUnknown: 0 };
    g.count++;
    if (r.foreignAmount != null) g.amount = Math.round((g.amount + r.foreignAmount) * 100) / 100; else g.missing++;
    if (!fxNoTax(r, vendor)) g.taxUnknown++;
    gm.set(g.cur, g);
  }
  const groups = [...gm.values()];
  // 외화 행 표시값(원화 행은 null → 기존 원화 값)
  const cellsOf = (r: ReproStmtRow): FxCells | null => {
    if (!isFx(r)) return null;
    const amt = r.foreignAmount != null ? fxAmt(r.payCurrency!, r.foreignAmount) : FX_MISSING;
    const noTax = fxNoTax(r, vendor);
    return { base: amt, expense: DASH, deduction: DASH, gross: amt,
      tax: noTax ? fxAmt(r.payCurrency!, 0) : TAX_UNKNOWN, net: r.foreignAmount == null ? FX_MISSING : (noTax ? amt : TAX_UNKNOWN) };
  };
  const gAmt = (g: FxGroup) => `${fxAmt(g.cur, g.amount)}${g.missing ? ` (${FX_MISSING} ${g.missing}건)` : ''}`;
  const join = (krwPart: string | null, fxParts: string[]) => [...(krwPart != null ? [krwPart] : []), ...fxParts].join(' · ');
  const totalsText = {
    base: join(hasKrw ? wonTxt(tK.base) : null, groups.map(gAmt)),
    expense: join(hasKrw ? wonTxt(tK.expense) : null, groups.map(() => DASH)),
    deduction: join(hasKrw ? wonTxt(tK.deduction) : null, groups.map(() => DASH)),
    gross: join(hasKrw ? wonTxt(tK.gross) : null, groups.map(gAmt)),
  };
  // 합계 요약 — 원화(있으면, 기존 항목 그대로) + 통화별 항목
  const sfx = (cur: string) => ` (${cur})`;
  const summaryRows: [string, string, boolean?][] = [];
  if (hasKrw) {
    summaryRows.push(['지급금액 합계 (원화)', wonTxt(tK.base)], ['기타비용 합계 (원화)', wonTxt(tK.expense)], ['차감 합계 (원화)', wonTxt(tK.deduction)]);
    if (vendor) {
      summaryRows.push(['공급가 합계 (원화)', wonTxt(tK.gross)], ['부가세 (원화)', wonTxt(tK.vat)]);
      if (tK.withholding > 0) summaryRows.push(['CRM 공제 기록(세금 확인 필요)', wonTxt(tK.withholding), true]);
    } else summaryRows.push(['세전금액 합계 (원화)', wonTxt(tK.gross)], ['원천세공제 (원화)', `${tK.withholding.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원`, true]);
  }
  for (const g of groups) {
    summaryRows.push([`지급금액 합계${sfx(g.cur)}`, gAmt(g)], [`기타비용 합계${sfx(g.cur)}`, DASH], [`차감 합계${sfx(g.cur)}`, DASH],
      [`${vendor ? '공급가 합계' : '세전금액 합계'}${sfx(g.cur)}`, gAmt(g)],
      [`${vendor ? '부가세' : '원천세공제'}${sfx(g.cur)}`, g.taxUnknown ? TAX_UNKNOWN : fxAmt(g.cur, 0), true]);
    if (g.missing) summaryRows.push([`${g.cur} 금액 ${FX_MISSING}`, `${g.missing}건 — 입력된 금액만 합계, 최종 지급액 미확정`]);
  }
  const fxFinal = (g: FxGroup) => g.taxUnknown ? `${g.cur} ${TAX_UNKNOWN}` : `${fxAmt(g.cur, g.amount)}${g.missing ? ' (미확정)' : ''}`;
  const finalText = join(hasKrw ? wonTxt(tK.net) : null, groups.map(fxFinal));
  const pending = groups.filter(g => g.missing).map(g => `${g.cur} 금액 미입력 ${g.missing}건`);
  const note = `외화 지급은 지급통화 금액 그대로 표시하며 원화와 합산하거나 원화로 환산하지 않습니다.${pending.length ? ` ${pending.join(', ')} — 입력된 금액만 합계했으며 최종 지급액은 미확정입니다.` : ''}`;
  return { hasKrw, tK, groups, cellsOf, totalsText, summaryRows, finalText, note };
}

const taxDisplayOf = (vendor: boolean, vat: number, crmDeduct = 0, rows: ReproStmtRow[] = []) => (!vendor ? headTaxLabel(rows)
  : `외주업체 — 원천징수 없음${vat > 0 ? `, 부가세 ${Math.round(vat).toLocaleString()}원 포함` : ''}${crmDeduct > 0 ? ` · CRM 공제 기록 ${Math.round(crmDeduct).toLocaleString()}원(세금 확인 필요)` : ''}`);

// 통번역사 1인 명세서 Excel — 정식 양식(14컬럼: '구분'·'수행일'·'작업량'·'단가' 제거, '상세내역'=파일명 추가).
export function exportReproStatementExcel(opts: ReproStmtOpts): void {
  const vendor = opts.payeeType === 'vendor';
  const t = totals(opts.rows, vendor);
  const taxCol = vendor ? '부가세' : '원천세공제';
  const fx = opts.rows.some(isFx) ? fxStatement(opts.rows, vendor) : null;   // 외화 포함 명세서만(원화만 = 기존 그대로)
  const columns: ExcelColumn[] = [
    { header: '거래처', width: 16 }, { header: '상품·업무', width: 26 }, { header: '상세내역', width: 38 },
    { header: '납품일', width: 12 }, { header: '지급일', width: 12 }, { header: fx ? '지급금액' : '통번역료', type: 'number', width: fx ? 16 : 12 },
    { header: '기타비용 내역', width: 14 }, { header: '기타비용 금액', type: 'number', width: 13 },
    { header: '차감 내역', width: 12 }, { header: '차감 금액', type: 'number', width: 11 },
    { header: '세전금액', type: 'number', width: 13 }, { header: '세금처리', width: 16 },
    { header: taxCol, type: 'number', width: 16 }, { header: vendor ? '지급합계' : '실지급액', type: 'number', width: 16 },
  ];
  const rows: ExcelCell[][] = opts.rows.map((r) => {
    const c = fx?.cellsOf(r);
    if (c) return [r.client || '거래처 확인 필요', r.content || '-', detailOf(r), r.deliveryDate || '-', r.payoutDate || '-',
      c.base, DASH, c.expense, DASH, c.deduction, c.gross, vendor ? '외주업체' : treatmentLabel(r), c.tax, c.net];
    return [
    r.client || '거래처 확인 필요', r.content || '-', detailOf(r), r.deliveryDate || '-', r.payoutDate || '-',
    Math.round(num(r.pretax)),
    '', 0, '', 0,
    Math.round(num(r.pretax)), vendor ? '외주업체' : treatmentLabel(r),
    Math.round(vendor ? Math.max(0, num(r.posttax) - num(r.pretax)) : num(r.pretax) - num(r.posttax)), Math.round(num(r.posttax)),
  ]; });
  const totRow: ExcelCell[] = fx ? [
    `합계 (${opts.rows.length}건)`, '', '', '', '',
    fx.totalsText.base, '', fx.totalsText.expense, '', fx.totalsText.deduction, fx.totalsText.gross, '', '', fx.finalText,
  ] : [
    `합계 (${opts.rows.length}건)`, '', '', '', '',
    Math.round(t.base), '', 0, '', 0,
    Math.round(t.gross), '', Math.round(vendor ? t.vat : t.withholding), Math.round(t.net),
  ];
  const footerRows: [string, ExcelCell][] = fx ? [
    ...fx.summaryRows.map(([k, v]) => [k, v] as [string, ExcelCell]),
    ['안내', fx.note],
    [vendor ? '지급합계' : '최종 실지급액', fx.finalText],
  ] : [
    ['통번역료 합계', Math.round(t.base)],
    ['기타비용 합계', 0],
    ['차감 합계', 0],
    [vendor ? '공급가 합계' : '세전금액 합계', Math.round(t.gross)],
    [taxCol, Math.round(vendor ? t.vat : t.withholding)],
    ...(vendor && t.withholding > 0 ? [['CRM 공제 기록(세금 확인 필요)', Math.round(t.withholding)] as [string, ExcelCell]] : []),
    [vendor ? '지급합계' : '최종 실지급액', Math.round(t.net)],
    ...(fxSummary(opts.rows) ? [['외화 지급 합계', fxSummary(opts.rows)!] as [string, ExcelCell]] : []),
  ];
  downloadStatementExcel({
    filename: `지급명세서_${safe(opts.payeeName)}_${safe(opts.scopeValue)}_${todayStamp()}.xlsx`,
    sheetName: '지급명세서',
    title: 'VERITAS 지급명세서',
    info: [
      ['지급대상', opts.payeeName],
      ['이메일', opts.email || '-'],
      ['연락처', opts.phone || '-'],
      ['구분', vendor ? '외주업체' : '통번역사'],
      ['지급일', opts.payDate || '-'],
      ['세금처리', taxDisplayOf(vendor, t.vat, vendor ? t.withholding : 0, opts.rows)],
      ...(fxSummary(opts.rows) ? [['외화 지급', fxSummary(opts.rows)!] as [string, string]] : []),
    ],
    columns, rows, totals: totRow, footerRows,
  });
}

// 통번역사 1인 재현 명세서 PDF — 기존 정식 A4 양식 재사용. 팝업 차단 시 false.
export function exportReproStatementPdf(opts: ReproStmtOpts): boolean {
  const vendor = opts.payeeType === 'vendor';
  const t = totals(opts.rows, vendor);
  const fx = opts.rows.some(isFx) ? fxStatement(opts.rows, vendor) : null;   // 외화 포함 명세서만(원화만 = 기존 그대로)
  const pdfRows: PayoutStatementPdfRow[] = opts.rows.map((r) => {
    const c = fx?.cellsOf(r);
    return {
      customer: r.client || '거래처 확인 필요', product: r.content || '-', detail: detailOf(r),
      deliveryDate: r.deliveryDate || '-', payDate: r.payoutDate || '-',
      base: num(r.pretax), expenses: c ? c.expense : '', deductions: c ? c.deduction : '', gross: num(r.pretax),
      ...(c ? { baseText: c.base, grossText: c.gross } : {}),
    };
  });
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  return printPayoutStatementPdf({
    fileName: `지급명세서_${safe(opts.payeeName)}_${safe(opts.scopeValue)}`,
    issuedDate: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`,
    payeeName: opts.payeeName, payeeLanguages: opts.payeeLanguages ?? null, email: opts.email || '-', phone: opts.phone || '-', payeeType: vendor ? '외주업체' : '통번역사',
    scopeFieldLabel: '지급회차', scopeValue: opts.scopeValue,
    payDate: opts.payDate || '-', taxDisplay: taxDisplayOf(vendor, t.vat, vendor ? t.withholding : 0, opts.rows) + (fxSummary(opts.rows) ? ` · 외화 지급 ${fxSummary(opts.rows)}` : ''),
    count: opts.rows.length, rows: pdfRows,
    totals: t,
    ...(fx ? { fx: { baseHeader: '지급금액', totalsText: fx.totalsText, summaryRows: fx.summaryRows, finalText: fx.finalText, note: fx.note } } : {}),
  });
}
