// 과거 지급 재현 → 통번역사별 정식 지급명세서(Excel/PDF) 매핑 — READ-ONLY.
//  · payoutReproduction(/payees) 의 원본값(세전=지급액(세전), 세후=지금액(세후), 원본공제=세전-세후)을
//    기존 정식 명세서 양식(downloadStatementExcel / printPayoutStatementPdf)에 "그대로" 매핑한다.
//  · 계산·재계산 없음(원본값 전달만). DB/원본 변경 없음. 모던 지급회차와 무관(재현 전용).
//  · 거래처는 과거 CRM 원본 '거래처명'을 그대로 표시한다(없으면 '거래처 확인 필요'). 임의 추정/Master 덮어쓰기 없음.
//  · 상세내역 = 해당 수행 건의 과거 진행관리표 '파일명' 원본값(화면 파일명과 동일 행 ID 기준). 없으면 '-'.
//  · '구분'·'수행일' 열은 제거(원본에 분해값 없음). 작업량/단가/기타비용/차감 분해도 없어 '-'/0으로 둔다.
//    (세전=통번역료로 간주, 기타비용·차감=0, 공제=원본 세전-세후, 실지급=세후)
import { downloadStatementExcel, todayStamp, type ExcelCell, type ExcelColumn } from './payoutExcel';
import { printPayoutStatementPdf, type PayoutStatementPdfRow } from './payoutStatementPdf';

export interface ReproStmtRow {
  client: string | null;    // 과거 CRM 원본 거래처명(없으면 '거래처 확인 필요')
  filename: string | null;  // 상세내역 — 과거 진행관리표 원본 파일명(없으면 '-')
  deliveryDate: string | null;
  payoutDate: string | null;
  content: string | null;   // 상품 · 언어
  pretax: number;
  posttax: number;
}
export interface ReproStmtOpts {
  payeeName: string;
  email?: string | null;
  phone?: string | null;    // 연락처(휴대폰) — Master 등록 우선, 없으면 원본 CRM 연락처(§3). 없으면 '-'.
  scopeValue: string;       // 지급회차 라벨(예: "2026-09-15 지급")
  payDate: string;          // 대표 지급일('-' 가능)
  rows: ReproStmtRow[];
}

const num = (n: unknown) => { const v = Number(n); return Number.isFinite(v) ? v : 0; };
const safe = (s: string) => String(s || '지급대상').replace(/[\\/:*?"<>|\s]+/g, '_');
const TAX_DISPLAY = '원천징수 3.3%';

function totals(rows: ReproStmtRow[]) {
  const gross = rows.reduce((a, r) => a + num(r.pretax), 0);
  const net = rows.reduce((a, r) => a + num(r.posttax), 0);
  const withholding = Math.round((gross - net) * 100) / 100;   // 원본 세전−세후(실제 공제)
  return { base: gross, expense: 0, deduction: 0, gross, withholding, net };
}

// 통번역사 1인 명세서 Excel — 정식 양식(14컬럼: '구분'·'수행일'·'작업량'·'단가' 제거, '상세내역'=파일명 추가).
export function exportReproStatementExcel(opts: ReproStmtOpts): void {
  const t = totals(opts.rows);
  const columns: ExcelColumn[] = [
    { header: '거래처', width: 16 }, { header: '상품·업무', width: 26 }, { header: '상세내역', width: 38 },
    { header: '납품일', width: 12 }, { header: '지급일', width: 12 }, { header: '통번역료', type: 'number', width: 12 },
    { header: '기타비용 내역', width: 14 }, { header: '기타비용 금액', type: 'number', width: 13 },
    { header: '차감 내역', width: 12 }, { header: '차감 금액', type: 'number', width: 11 },
    { header: '세전금액', type: 'number', width: 13 }, { header: '세금처리', width: 16 },
    { header: '원천세공제(3.3%)', type: 'number', width: 16 }, { header: '실지급액', type: 'number', width: 16 },
  ];
  const rows: ExcelCell[][] = opts.rows.map((r) => [
    r.client || '거래처 확인 필요', r.content || '-', r.filename || '-', r.deliveryDate || '-', r.payoutDate || '-',
    Math.round(num(r.pretax)),
    '', 0, '', 0,
    Math.round(num(r.pretax)), TAX_DISPLAY,
    Math.round(num(r.pretax) - num(r.posttax)), Math.round(num(r.posttax)),
  ]);
  const totRow: ExcelCell[] = [
    `합계 (${opts.rows.length}건)`, '', '', '', '',
    Math.round(t.base), '', 0, '', 0,
    Math.round(t.gross), '', Math.round(t.withholding), Math.round(t.net),
  ];
  const footerRows: [string, ExcelCell][] = [
    ['통번역료 합계', Math.round(t.base)],
    ['기타비용 합계', 0],
    ['차감 합계', 0],
    ['세전금액 합계', Math.round(t.gross)],
    ['원천세공제(3.3%)', Math.round(t.withholding)],
    ['최종 실지급액', Math.round(t.net)],
  ];
  downloadStatementExcel({
    filename: `지급명세서_${safe(opts.payeeName)}_${safe(opts.scopeValue)}_${todayStamp()}.xlsx`,
    sheetName: '지급명세서',
    title: 'VERITAS 지급명세서',
    info: [
      ['지급대상', opts.payeeName],
      ['이메일', opts.email || '-'],
      ['연락처', opts.phone || '-'],
      ['구분', '통번역사'],
      ['지급일', opts.payDate || '-'],
      ['세금처리', TAX_DISPLAY],
    ],
    columns, rows, totals: totRow, footerRows,
  });
}

// 통번역사 1인 재현 명세서 PDF — 기존 정식 A4 양식 재사용. 팝업 차단 시 false.
export function exportReproStatementPdf(opts: ReproStmtOpts): boolean {
  const t = totals(opts.rows);
  const pdfRows: PayoutStatementPdfRow[] = opts.rows.map((r) => ({
    customer: r.client || '거래처 확인 필요', product: r.content || '-', detail: r.filename || '-',
    deliveryDate: r.deliveryDate || '-', payDate: r.payoutDate || '-',
    base: num(r.pretax), expenses: '', deductions: '', gross: num(r.pretax),
  }));
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  return printPayoutStatementPdf({
    fileName: `지급명세서_${safe(opts.payeeName)}_${safe(opts.scopeValue)}`,
    issuedDate: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`,
    payeeName: opts.payeeName, email: opts.email || '-', phone: opts.phone || '-', payeeType: '통번역사',
    scopeFieldLabel: '지급회차', scopeValue: opts.scopeValue,
    payDate: opts.payDate || '-', taxDisplay: TAX_DISPLAY,
    count: opts.rows.length, rows: pdfRows,
    totals: t,
  });
}
