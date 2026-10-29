/**
 * 견적서 인쇄창 HTML — QuotePdfPreviewModal 의 "인쇄 / PDF 저장"이 새 창에 쓰는 문서.
 * 화면 미리보기(모달)와 분리된 인쇄 전용 CSS 만 여기서 관리한다.
 */
import { escapeHtmlTitle } from './quoteTitle';

/** @param fileName PDF 기본 파일명(<title>) · @param bodyHtml 미리보기 견적서 본문(#quote-pdf-content 의 innerHTML) */
export function buildQuotePrintHtml(fileName: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>${escapeHtmlTitle(fileName)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "Apple SD Gothic Neo", "Malgun Gothic", "맑은 고딕", "NanumGothic", sans-serif;
    font-size: 12px;
    color: #1a1a2e;
    line-height: 1.6;
    background: #fff;
  }
  /* 브라우저 머리글·바닥글(출력 일시·문서 제목·about:blank·페이지 번호)은 @page 여백 영역에 찍힌다.
     여백을 0으로 두어 그 영역을 없애고, 용지 여백은 아래 .qp-frame 이 페이지마다 대신 만든다. */
  @page {
    size: A4 portrait;
    margin: 0;
  }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
  /* 용지 여백 프레임 — thead/tfoot 는 페이지가 넘어갈 때마다 반복되므로 모든 페이지에 상·하 여백이 생긴다.
     좌우 52px·상하 10mm 는 화면 미리보기(A4 794px, 좌우 패딩 52px)와 같은 폭이 되도록 맞춘 값. */
  table.qp-frame { width: 100%; border-collapse: collapse; margin: 0; }
  table.qp-frame > thead > tr > td, table.qp-frame > tfoot > tr > td,
  table.qp-frame > tbody > tr > td.qp-body { padding: 0 52px; border: 0; background: none; font-size: 12px; vertical-align: top; }
  .qp-space { height: 10mm; }
  /* 페이지 분리 — 품목 행·정보 블록은 중간에서 자르지 않는다. 입금 계좌·견적 조건은 한 블록으로 유지. */
  .qp-body .qp-keep, .qp-body .qp-items tr { break-inside: avoid; page-break-inside: avoid; }
  .qp-body .qp-items thead { display: table-header-group; }
  .qp-body .qp-heading { break-after: avoid; page-break-after: avoid; }
  /* 안내말씀 상자가 페이지를 넘어가면 테두리·안쪽 여백을 페이지마다 다시 그린다(열린 테두리 방지) */
  .qp-body .qp-notice { box-decoration-break: clone; -webkit-box-decoration-break: clone; }
  /* 비고 — 길면 줄 단위로 이어서 출력(제목은 첫 줄들과 함께, 페이지 양쪽에 최소 3줄) */
  .qp-body .qp-note { box-decoration-break: clone; -webkit-box-decoration-break: clone; orphans: 3; widows: 3; }
  .qp-body .qp-note > div:first-child { break-after: avoid; page-break-after: avoid; }
  /* 1페이지 수용 — 글자 크기는 그대로 두고 블록 사이 간격만 소폭 줄인다(화면 미리보기는 변경 없음). */
  .qp-body .qp-head { margin-bottom: 12px !important; }
  .qp-body .qp-rule { margin-bottom: 12px !important; }
  .qp-body .qp-gap { margin-bottom: 8px !important; }
  .qp-body .qp-items { margin-bottom: 8px !important; }
  .qp-body .qp-note > div:last-child { line-height: 1.5; }
  .qp-body .qp-footer { margin-bottom: 0 !important; }
  .page {
    width: 100%;
    padding: 0;
    background: #fff;
  }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; }
  .company-logo { font-size: 22px; font-weight: 900; color: #1e3a5f; letter-spacing: -0.5px; }
  .doc-title { text-align: right; }
  .doc-title h1 { font-size: 26px; font-weight: 900; color: #1e3a5f; letter-spacing: 6px; margin-bottom: 4px; }
  .doc-title .quote-num { font-size: 11px; color: #6b7280; font-family: monospace; }
  .divider { height: 2px; background: #1e3a5f; margin-bottom: 20px; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 14px; }
  .info-box { border: 1px solid #d1d5db; border-radius: 6px; padding: 12px 14px; }
  .info-box-title { font-size: 10px; font-weight: 800; color: #1e3a5f; letter-spacing: 1px; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1.5px solid #e8edf5; }
  .info-row { display: flex; align-items: baseline; margin-bottom: 3px; }
  .info-key { font-size: 10px; color: #6b7280; font-weight: 600; min-width: 76px; flex-shrink: 0; }
  .info-val { font-size: 11px; color: #111827; font-weight: 500; min-width: 0; white-space: normal; word-break: keep-all; overflow-wrap: break-word; }
  .quote-info-box { border: 1px solid #d1d5db; border-radius: 6px; padding: 10px 14px; margin-bottom: 14px; }
  .quote-info-inner { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 16px; }
  .total-box { background: #e8edf5; border-radius: 6px; padding: 10px 16px; margin-bottom: 20px; display: flex; justify-content: flex-end; align-items: center; }
  .total-box-right { font-size: 18px; font-weight: 900; color: #1e3a5f; }
  .total-box-right .label { font-size: 10px; font-weight: 600; color: #6b7280; display: block; text-align: right; margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th { background: #1e3a5f; color: #fff; font-size: 10px; font-weight: 700; padding: 7px 6px; text-align: center; white-space: nowrap; }
  th.left { text-align: left; }
  td { font-size: 10px; padding: 6px 6px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  td.center { text-align: center; }
  td.right { text-align: right; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.detail { white-space: pre-line; word-break: break-word; max-width: 200px; }
  td.name { word-break: break-word; max-width: 120px; font-weight: 600; }
  tr:nth-child(even) td { background: #f9fafb; }
  .summary { margin-left: auto; width: 260px; }
  .summary-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 11px; border-bottom: 1px solid #f1f5f9; }
  .summary-row .sk { color: #6b7280; font-weight: 600; }
  .summary-row .sv { color: #111827; font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
  .summary-total { display: flex; justify-content: space-between; padding: 8px 12px; background: #1e3a5f; border-radius: 6px; margin-top: 6px; }
  .summary-total .sk { color: #bfdbfe; font-size: 11px; font-weight: 700; }
  .summary-total .sv { color: #fff; font-size: 14px; font-weight: 900; font-variant-numeric: tabular-nums; }
  .footer { margin-top: 28px; display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .footer-box { border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px 14px; }
  .footer-box-title { font-size: 10px; font-weight: 800; color: #1e3a5f; letter-spacing: 0.5px; margin-bottom: 8px; }
  .footer-note { font-size: 10px; color: #374151; white-space: pre-line; line-height: 1.7; }
  .signature-area { display: flex; justify-content: flex-end; margin-top: 24px; }
  .signature-box { text-align: center; min-width: 100px; }
  .signature-label { font-size: 10px; color: #6b7280; margin-bottom: 4px; }
  .signature-img { width: 80px; height: 80px; object-fit: contain; }
  .signature-placeholder { width: 80px; height: 80px; border: 1px dashed #d1d5db; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; color: #9ca3af; border-radius: 4px; }
</style>
</head>
<body>
<table class="qp-frame">
<thead><tr><td><div class="qp-space"></div></td></tr></thead>
<tfoot><tr><td><div class="qp-space"></div></td></tr></tfoot>
<tbody><tr><td class="qp-body"><div class="page">
  ${bodyHtml}
</div></td></tr></tbody>
</table>
<script>window.onload = function() { window.print(); }<\/script>
</body>
</html>`;
}
