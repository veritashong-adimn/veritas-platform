/**
 * VERITAS 지급명세서 PDF — 통번역사/외주업체에게 전달하는 공식 지급명세서.
 *
 * 조회 전용 유틸(계산 없음). 화면(PayoutStatementModal)이 이미 산출·표시한 값을 그대로 받아
 * A4 인쇄용 HTML 문서를 새 창에 생성하고 브라우저 인쇄(→ PDF 저장) 대화상자를 연다.
 *  · 계산·정산 로직은 서버(payout-rounds) 확정값 그대로 — 여기서 재계산하지 않는다(화면=PDF=Excel 동일).
 *  · A4 세로. 건수가 많으면 thead 반복(table-header-group) + 행 분리 금지로 자연스럽게 다음 장으로 넘어간다.
 *  · 견적서 PDF(QuotePdfPreviewModal)와 동일한 window.open + window.print 방식(외부 라이브러리 없음).
 */

// 천 단위 쉼표 + '원'. 순수 포맷(계산 아님).
const won = (n: unknown) => `${Math.round(Number(n ?? 0)).toLocaleString('ko-KR')}원`;
const esc = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface PayoutStatementPdfRow {
  customer: string;
  product: string;
  detail?: string;      // 상세내역 — 해당 수행 건의 실제 파일명(과거 재현) / 신규 수행정보 파일명. 없으면 '-'.
  service?: string;     // (미표시) '구분' 열 제거로 더 이상 렌더링하지 않음 — 하위호환 위해 optional 유지.
  perfDate?: string;    // (미표시) '수행일' 열 제거로 더 이상 렌더링하지 않음 — 하위호환 위해 optional 유지.
  deliveryDate: string;
  payDate: string;
  workAmount?: string;  // (미표시) '작업량' 열 제거로 더 이상 렌더링하지 않음 — 하위호환 위해 optional 유지.
  unitPrice?: string;   // (미표시) '단가' 열 제거로 더 이상 렌더링하지 않음 — 하위호환 위해 optional 유지.
  base: number;
  expenses: string;     // "항목명 금액 · …"(inlineItems 결과) 그대로
  deductions: string;
  gross: number;
  vatIncluded?: boolean;
}

export interface PayoutStatementPdfData {
  fileName: string;
  issuedDate: string;   // 발행일 YYYY-MM-DD
  payeeName: string;
  email: string;
  phone?: string;       // 연락처(휴대폰) — Master 등록번호 우선, 없으면 원본 CRM 연락처. 없으면 '-'.
  payeeType: string;    // '통번역사' | '외주업체'
  scopeFieldLabel: string;  // '지급회차' | '조회 범위'
  scopeValue: string;
  payDate: string;      // 지급일('-' 가능)
  taxDisplay: string;   // 세금처리 표기(그룹 기준)
  count: number;
  rows: PayoutStatementPdfRow[];
  totals: { base: number; expense: number; deduction: number; gross: number; withholding: number; net: number };
}

/** 지급명세서를 새 창에 A4 HTML로 렌더 후 인쇄(→PDF). 팝업 차단 시 false 반환. */
export function printPayoutStatementPdf(data: PayoutStatementPdfData): boolean {
  const win = window.open('', '_blank', 'width=980,height=760');
  if (!win) return false;

  // 상단 정보 — '지급회차'는 지급일과 동일 날짜 중복이라 명세서 출력에서 제외(§2). 지급일만 표시.
  const infoRows: [string, string][] = [
    ['지급대상자', data.payeeName],
    ['이메일', data.email || '-'],
    ['연락처', data.phone || '-'],
    ['구분', data.payeeType],
    ['지급일', data.payDate || '-'],
    ['세금처리', data.taxDisplay],
  ];

  const detailRows = data.rows.map((r) => `
    <tr>
      <td class="name">${esc(r.customer)}</td>
      <td class="name">${esc(r.product)}</td>
      <td class="detail">${esc(r.detail || '-')}</td>
      <td class="date">${esc(r.deliveryDate)}</td>
      <td class="date">${esc(r.payDate)}</td>
      <td class="num">${won(r.base)}</td>
      <td class="detail">${esc(r.expenses)}</td>
      <td class="detail">${esc(r.deductions)}</td>
      <td class="num strong">${won(r.gross)}${r.vatIncluded ? '<span class="vat">(VAT별도)</span>' : ''}</td>
    </tr>`).join('');

  const summaryRows: [string, string, boolean?][] = [
    ['통번역료 합계', won(data.totals.base)],
    ['기타비용 합계', won(data.totals.expense)],
    ['차감 합계', won(data.totals.deduction)],
    ['세전금액 합계', won(data.totals.gross)],
    ['원천세공제(3.3%)', won(data.totals.withholding), true],
  ];

  win.document.write(`<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>${esc(data.fileName)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  /* @page margin 0 → 브라우저 기본 인쇄 머리글/바닥글(날짜·파일명·about:blank·페이지번호) 제거.
     실제 여백은 .doc 패딩으로 준다(외부 전달용 공식 문서). */
  @page { size: A4 landscape; margin: 0; }
  html, body { background: #fff; }
  body { font-family: "Apple SD Gothic Neo", "Malgun Gothic", "맑은 고딕", "NanumGothic", sans-serif; font-size: 11px; color: #1a1a2e; line-height: 1.5; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  /* 여백·행높이를 다소 조여 수행이력 소량(≈13건)이면 A4 한 장에 표+합계가 함께 들어가도록 한다(§5).
     글자 크기는 줄이지 않는다(가독성 유지) — 압축이 아니라 불필요한 상하 여백만 축소. */
  .doc { padding: 8mm 12mm; }
  .header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 8px; }
  .brand { font-size: 21px; font-weight: 900; color: #1e3a5f; letter-spacing: -0.5px; }
  .brand .tag { display: block; font-size: 9px; font-weight: 500; color: #6b7280; letter-spacing: 0.5px; margin-top: 2px; }
  .doc-title { text-align: right; }
  .doc-title h1 { font-size: 23px; font-weight: 900; color: #1e3a5f; letter-spacing: 5px; }
  .doc-title .issued { font-size: 10px; color: #6b7280; margin-top: 4px; }
  .divider { height: 2px; background: #1e3a5f; margin-bottom: 9px; }
  .info-box { border: 1px solid #d1d5db; border-radius: 6px; padding: 8px 14px; margin-bottom: 10px; }
  .info-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px 24px; }
  .info-row { display: flex; align-items: baseline; }
  .info-key { font-size: 10px; color: #6b7280; font-weight: 600; min-width: 66px; flex-shrink: 0; }
  .info-val { font-size: 11px; color: #111827; font-weight: 600; word-break: break-word; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; table-layout: fixed; }
  /* 열 헤더(thead)는 페이지마다 반복(§6③). 행·합계·요약은 페이지 중간 분리 금지(§6④⑤⑥). */
  thead { display: table-header-group; }
  tfoot { display: table-row-group; }
  tr { page-break-inside: avoid; }
  tfoot tr { page-break-inside: avoid; }
  th { background: #1e3a5f; color: #fff; font-size: 10px; font-weight: 700; padding: 5px 6px; text-align: center; white-space: nowrap; }
  td { font-size: 10px; padding: 3px 6px; border-bottom: 1px solid #eef2f7; vertical-align: top; line-height: 1.4; }
  td.center { text-align: center; }
  td.date { text-align: center; white-space: nowrap; padding-left: 9px; padding-right: 9px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.num.strong { font-weight: 700; }
  td.name { font-weight: 600; word-break: keep-all; overflow-wrap: anywhere; }
  td.detail { font-size: 9.5px; color: #374151; word-break: keep-all; overflow-wrap: anywhere; }
  td .vat { display: block; font-size: 8px; color: #6b7280; font-weight: 400; }
  tbody tr:nth-child(even) td { background: #f9fafb; }
  tfoot td { background: #eff6ff; font-weight: 800; border-top: 1.5px solid #1e3a5f; white-space: nowrap; }
  /* 합계 영역: 세전·원천세공제·실지급이 서로 다른 페이지로 쪼개지지 않도록 하나의 블록으로 유지(§6⑤⑥⑦). */
  /* 합계 블록은 쪼개지지 않게(avoid inside) + 바로 앞에서 페이지가 끊기지 않게(avoid before) →
     표가 한 페이지를 꽉 채우면 마지막 행 일부를 합계와 함께 다음 장으로 넘겨, 합계만 단독 출력되는 것을 줄인다(§6⑨). */
  .summary { margin-left: auto; width: 320px; margin-top: 4px; page-break-inside: avoid; break-inside: avoid; page-break-before: avoid; break-before: avoid; }
  .summary-row { display: flex; justify-content: space-between; padding: 3px 4px; font-size: 11px; border-bottom: 1px solid #eef2f7; }
  .summary-row .sk { color: #6b7280; font-weight: 600; }
  .summary-row .sv { color: #111827; font-weight: 700; font-variant-numeric: tabular-nums; }
  .summary-row.deduct .sv { color: #dc2626; }
  .summary-total { display: flex; justify-content: space-between; align-items: center; padding: 9px 16px; background: #1e3a5f; border-radius: 6px; margin-top: 6px; }
  .summary-total .sk { color: #bfdbfe; font-size: 12px; font-weight: 700; }
  .summary-total .sv { color: #fff; font-size: 18px; font-weight: 900; font-variant-numeric: tabular-nums; }
  .note { margin-top: 9px; font-size: 9px; color: #9ca3af; line-height: 1.45; border-top: 1px solid #e5e7eb; padding-top: 7px; }
</style>
</head>
<body>
<div class="doc">
  <div class="header">
    <div class="brand">VERITAS<span class="tag">Translation &amp; Interpretation Platform</span></div>
    <div class="doc-title"><h1>지급명세서</h1><div class="issued">발행일 ${esc(data.issuedDate)}</div></div>
  </div>
  <div class="divider"></div>
  <div class="info-box"><div class="info-grid">
    ${infoRows.map(([k, v]) => `<div class="info-row"><span class="info-key">${esc(k)}</span><span class="info-val">${esc(v)}</span></div>`).join('')}
  </div></div>
  <table>
    <colgroup>
      <col style="width:13%"><col style="width:16%"><col style="width:24%">
      <col style="width:8%"><col style="width:8%"><col style="width:9%">
      <col style="width:8%"><col style="width:6%"><col style="width:8%">
    </colgroup>
    <thead>
      <tr>
        <th>거래처</th><th>상품·업무</th><th>상세내역</th>
        <th>납품일</th><th>지급일</th><th>통번역료</th>
        <th>기타비용 내역</th><th>차감</th><th>세전금액</th>
      </tr>
    </thead>
    <tbody>${detailRows || '<tr><td colspan="9" class="center" style="padding:16px;color:#9ca3af">상세내역이 없습니다.</td></tr>'}</tbody>
    <tfoot><tr>
      <td colspan="5" class="num">합계 (${data.count}건)</td>
      <td class="num">${won(data.totals.base)}</td>
      <td class="num">${won(data.totals.expense)}</td>
      <td class="num">${won(data.totals.deduction)}</td>
      <td class="num">${won(data.totals.gross)}</td>
    </tr></tfoot>
  </table>
  <div class="summary">
    ${summaryRows.map(([k, v, deduct]) => `<div class="summary-row${deduct ? ' deduct' : ''}"><span class="sk">${esc(k)}</span><span class="sv">${esc(v)}</span></div>`).join('')}
    <div class="summary-total"><span class="sk">최종 실지급액</span><span class="sv">${won(data.totals.net)}</span></div>
  </div>
  <div class="note">본 지급명세서는 VERITAS 정산 확정 데이터를 기준으로 발행되었습니다. 기재된 금액은 세전금액 = 통번역료 + 기타비용 − 차감이며, 최종 실지급액 = 세전금액 − 원천세공제(3.3%)입니다.</div>
</div>
  <script>window.onload = function () { window.print(); };<\/script>
</body>
</html>`);
  win.document.close();
  return true;
}
