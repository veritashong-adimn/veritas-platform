/**
 * comparisonQuoteDocument — 비교견적서 A4 문서 렌더러(HTML 문자열).
 *
 *  · 화면 미리보기와 인쇄/PDF 가 "같은 함수의 같은 결과"를 쓰므로 작성 화면 ↔ PDF 내용이 항상 일치한다.
 *  · VERITAS 견적서(QuotePdfPreviewModal / quotePrintHtml)와 완전히 분리된 독립 템플릿.
 *    settings(VERITAS 회사정보)를 절대 참조하지 않는다. 비어 있는 항목은 출력하지 않는다.
 *  · 발행 구분:
 *      vendor_confirmed    실제 업체 견적 — 등록된 로고·직인만 출력(없으면 출력 안 함)
 *      internal_simulation 내부 비교용 — 상단 띠·워터마크·안내문, 로고·직인·서명란 미출력
 *  · 페이지 분할(인쇄): @page 여백 0(브라우저 머리글·바닥글 영역 제거) + 프레임 table 의 thead/tfoot 여백이
 *    모든 페이지에 반복. 품목 행은 잘리지 않고, 품목 머리행은 다음 페이지에 반복된다.
 */
import type { ComparisonQuotePdfData } from './comparisonQuotePdf';
import { COMPARISON_TERM_FIELDS } from './comparisonQuotePdf';

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const escMultiline = (v: unknown) => esc(v).replace(/\r?\n/g, '<br>');
const fmt = (n: number) => (Number(n) || 0).toLocaleString('ko-KR', { maximumFractionDigits: 2 });
const has = (v: unknown) => v != null && String(v).trim() !== '';

// 이미지 src 는 실제 등록 이미지(data URI) 또는 레거시 http(s) URL 만 허용.
const safeImg = (v: string | null | undefined): string | null => {
  if (!v) return null;
  if (/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(v)) return v;
  if (/^https?:\/\/[^\s"'<>]+$/.test(v)) return v;
  return null;
};

const hexToRgba = (hex: string, a: number) => {
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return `rgba(15,118,110,${a})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
};

/** 하단 발행일 표기 — 'YYYY-MM-DD' → 'YYYY년 M월 D일'(형식이 다르면 원문 그대로). */
const issueDateText = (v: string | null | undefined): string => {
  const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[1]}년 ${Number(m[2])}월 ${Number(m[3])}일` : String(v ?? '');
};

/** 금액 한글 표기 — 3,300,000 → "삼백삼십만" (일금 …원정 표기용). */
export function koreanAmount(n: number): string {
  let v = Math.round(Math.abs(Number(n) || 0));
  if (v === 0) return '영';
  const digits = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
  const small = ['', '십', '백', '천'];
  const big = ['', '만', '억', '조', '경'];
  const out: string[] = [];
  let bi = 0;
  while (v > 0 && bi < big.length) {
    const chunk = v % 10000;
    if (chunk > 0) {
      let s = '';
      const ds = String(chunk).padStart(4, '0').split('').map(Number);
      ds.forEach((d, i) => {
        if (!d) return;
        const pos = 3 - i;
        s += (d === 1 && pos > 0 ? '' : digits[d]) + small[pos];
      });
      out.unshift(s + big[bi]);
    }
    v = Math.floor(v / 10000);
    bi += 1;
  }
  return out.join('');
}

/** 문서 CSS — 화면/인쇄 공통(.cqd 범위). 인쇄 전용 규칙은 buildComparisonQuotePrintHtml 에서 추가. */
export const COMPARISON_DOC_CSS = `
.cqd { position: relative; font-family: "Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", "맑은 고딕", "NanumGothic", sans-serif;
  font-size: 12px; color: #1f2937; line-height: 1.55; word-break: keep-all; overflow-wrap: break-word; }
.cqd * { box-sizing: border-box; }
.cqd-simband { display: flex; align-items: center; gap: 8px; background: #fef3c7; border: 1px solid #f59e0b; color: #92400e;
  border-radius: 4px; padding: 6px 12px; font-size: 11px; font-weight: 700; margin-bottom: 14px; }
.cqd-simband b { background: #b45309; color: #fff; border-radius: 3px; padding: 1px 7px; font-size: 10.5px; letter-spacing: .5px; }
.cqd-wm { position: absolute; top: 380px; left: 50%; transform: translate(-50%, 0) rotate(-28deg); font-size: 78px; font-weight: 900;
  color: rgba(180, 83, 9, .065); letter-spacing: 10px; white-space: nowrap; pointer-events: none; z-index: 5; }
.cqd-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 18px; position: relative; z-index: 1; }
.cqd-brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.cqd-logo { max-height: 46px; max-width: 150px; object-fit: contain; display: block; }
.cqd-brand-name { font-size: 21px; font-weight: 800; color: #111827; letter-spacing: -.3px; line-height: 1.25; }
.cqd-brand-sub { font-size: 11px; color: #6b7280; margin-top: 2px; }
.cqd-titlebox { text-align: right; flex-shrink: 0; }
.cqd-title { font-size: 30px; font-weight: 900; color: var(--ac); letter-spacing: 9px; line-height: 1.1; margin-right: -9px; }
.cqd-title-en { font-size: 10px; font-weight: 700; color: #9ca3af; letter-spacing: 4px; margin: 4px 0 8px; }
.cqd-meta { border-collapse: collapse; margin-left: auto; }
.cqd-meta th { font-size: 11px; color: #6b7280; font-weight: 600; text-align: left; padding: 1px 10px 1px 0; white-space: nowrap; }
.cqd-meta td { font-size: 12px; color: #111827; font-weight: 600; text-align: right; padding: 1px 0; font-variant-numeric: tabular-nums; }
.cqd-rule { height: 3px; background: var(--ac); margin: 14px 0 18px; border-radius: 1px; position: relative; z-index: 1; }
.cqd-parties { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 16px; position: relative; z-index: 1; }
.cqd-party { border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px 15px; background: #fff; }
.cqd-party-label { font-size: 10px; font-weight: 800; color: var(--ac); letter-spacing: 1.5px; padding-bottom: 5px; margin-bottom: 6px; border-bottom: 1px solid var(--ac-line); }
.cqd-party-name { font-size: 15px; font-weight: 800; color: #111827; margin-bottom: 5px; }
.cqd-party-name small { font-size: 11px; font-weight: 500; color: #6b7280; margin-left: 3px; }
.cqd-row { display: flex; align-items: baseline; gap: 8px; margin: 2px 0; }
.cqd-row span:first-child { font-size: 10.5px; color: #6b7280; font-weight: 600; width: 84px; flex-shrink: 0; }
.cqd-row.nw span:last-child { white-space: nowrap; }          /* 연락처·이메일 — 줄바꿈 없이 한 줄 */
.cqd-row span:last-child { font-size: 11.5px; color: #111827; min-width: 0; }
.cqd-party-empty { font-size: 11px; color: #9ca3af; }
.cqd-amount { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--ac-soft); border: 1px solid var(--ac-line);
  border-radius: 6px; padding: 11px 16px; margin-bottom: 4px; position: relative; z-index: 1; }
.cqd-amount-label { font-size: 11.5px; font-weight: 700; color: #374151; }
.cqd-amount-words { font-size: 14px; font-weight: 800; color: #111827; }
.cqd-amount-num { font-size: 17px; font-weight: 900; color: var(--ac); font-variant-numeric: tabular-nums; white-space: nowrap; }
.cqd-greet { font-size: 11.5px; color: #4b5563; margin: 12px 0 8px; }
.cqd-items { width: 100%; border-collapse: collapse; table-layout: fixed; position: relative; z-index: 1; }
.cqd-items-cont { margin-bottom: 12px; }
.cqd-items th { background: var(--ac); color: #fff; font-size: 11px; font-weight: 700; padding: 8px 8px; white-space: nowrap; }
.cqd-items td { font-size: 11.5px; padding: 8px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; font-variant-numeric: tabular-nums; }
.cqd-items tr.z td { background: #fafafa; }
.cqd-items .c { text-align: center; } .cqd-items .r { text-align: right; } .cqd-items .l { text-align: left; }
.cqd-items .no { color: #9ca3af; width: 34px; }
.cqd-item-name { font-weight: 700; color: #111827; font-size: 12px; }
.cqd-item-lang { display: inline-block; font-size: 10px; font-weight: 700; color: var(--ac); background: var(--ac-soft); border-radius: 3px; padding: 0 5px; margin-left: 6px; vertical-align: 1px; }
.cqd-item-note { font-size: 10.5px; color: #6b7280; margin-top: 2px; white-space: normal; }
.cqd-items .amt { font-weight: 700; color: #111827; }
.cqd-items tfoot td { border-bottom: 0; }
.cqd-tail { display: flex; justify-content: flex-end; position: relative; z-index: 1; }
.cqd-totals { width: 310px; border-collapse: collapse; }
.cqd-totals th { text-align: left; font-size: 11.5px; color: #6b7280; font-weight: 600; padding: 6px 4px; border-bottom: 1px solid #f1f5f9; }
.cqd-totals td { text-align: right; font-size: 12.5px; color: #111827; font-weight: 600; padding: 6px 4px; border-bottom: 1px solid #f1f5f9; font-variant-numeric: tabular-nums; }
.cqd-totals tr.grand th, .cqd-totals tr.grand td { border-top: 2px solid var(--ac); border-bottom: 0; padding-top: 8px; }
.cqd-totals tr.grand th { color: #111827; font-weight: 800; font-size: 12.5px; }
.cqd-totals tr.grand td { color: var(--ac); font-weight: 900; font-size: 17px; }
.cqd-sec { margin-top: 16px; position: relative; z-index: 1; }
.cqd-sec-title { font-size: 12px; font-weight: 800; color: #111827; padding-left: 8px; border-left: 3px solid var(--ac); margin-bottom: 6px; line-height: 1.3; }
.cqd-terms { width: 100%; border-collapse: collapse; border-top: 1px solid #d1d5db; }
.cqd-terms th { width: 160px; text-align: left; vertical-align: top; font-size: 11px; color: #374151; font-weight: 700; background: #f9fafb; padding: 6px 10px; border-bottom: 1px solid #e5e7eb; }
.cqd-terms td { font-size: 11.5px; color: #1f2937; padding: 6px 10px; border-bottom: 1px solid #e5e7eb; }
.cqd-memo { border: 1px solid #e5e7eb; border-radius: 6px; padding: 9px 13px; font-size: 11.5px; color: #374151; }
/* 하단 발행정보 — 합계금액과 분리된 별도 영역.
   합계 바로 아래면 32mm(실측 약 29mm), 견적 조건·비고가 사이에 있으면 그 아래 14mm(합계와의 거리는 이미 25mm 이상). */
.cqd-issue { margin-top: 32mm; position: relative; z-index: 1; }
.cqd-sec + .cqd-issue { margin-top: 14mm; }
.cqd-issue-date { text-align: center; font-size: 11.5pt; font-weight: 600; color: #1f2937; letter-spacing: .5px; margin-bottom: 7mm; }
.cqd-issue-party { display: flex; justify-content: flex-end; align-items: center; gap: 5mm; padding-right: 2mm; }
.cqd-issue-text { text-align: left; }
.cqd-issue-name { font-size: 14.5pt; font-weight: 800; color: #111827; line-height: 1.3; letter-spacing: -.2px; }
.cqd-issue-rep { font-size: 11.5pt; color: #374151; margin-top: 1.5mm; line-height: 1.3; }
.cqd-issue-rep span { color: #6b7280; margin-right: 3mm; }
/* 직인 영역 — 업체명 오른쪽. 실제 등록 이미지가 있을 때만 이미지 출력(없으면 '(인)' 표시만) */
.cqd-seal { position: relative; width: 22mm; height: 22mm; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.cqd-seal-mark { font-size: 11pt; color: #9ca3af; }
.cqd-seal img { position: absolute; inset: 0; width: 22mm; height: 22mm; object-fit: contain; mix-blend-mode: multiply; }
.cqd-simnote { margin-top: 14mm; border: 1px dashed #f59e0b; background: #fffbeb; border-radius: 6px; padding: 10px 13px; font-size: 11.5px; color: #92400e; position: relative; z-index: 1; }
`;

/** 문서 본문 HTML(.cqd). 화면 미리보기·인쇄 공용. */
export function renderComparisonQuoteBody(d: ComparisonQuotePdfData): string {
  const sim = d.issueType === 'internal_simulation';
  const ac = d.design.accentColor;
  const c = d.company;
  const logo = sim ? null : safeImg(d.logoDataUrl);   // 내부 비교용은 업체 발행 문서처럼 보이지 않도록 로고 미출력
  const stamp = sim ? null : safeImg(d.stampDataUrl);  // 직인은 실제 업체 견적 + 실제 등록 이미지일 때만

  const row = (k: string, v: unknown, nowrap = false) =>
    (has(v) ? `<div class="cqd-row${nowrap && String(v).trim().length <= 32 ? ' nw' : ''}"><span>${esc(k)}</span><span>${esc(v)}</span></div>` : '');

  const cust = d.customer;
  const custRows = [row('대표자', cust.representativeName), row('담당자', cust.contactName), row('연락처', cust.phone, true), row('이메일', cust.email, true)].join('');
  const customerBox = `<div class="cqd-party">
      <div class="cqd-party-label">수신 · TO</div>
      ${has(cust.companyName) ? `<div class="cqd-party-name">${esc(cust.companyName)}<small>귀중</small></div>` : ''}
      ${custRows}
      ${!has(cust.companyName) && !custRows ? '<div class="cqd-party-empty">수신처 정보 없음</div>' : ''}
    </div>`;

  const supplierBox = `<div class="cqd-party">
      <div class="cqd-party-label">${sim ? '비교 대상 업체 · 내부 비교용' : '공급자 · FROM'}</div>
      <div class="cqd-party-name">${esc(c.name)}</div>
      ${row('대표자', c.representativeName)}${row('사업자등록번호', c.businessNumber)}${row('연락처', c.phone, true)}${row('이메일', c.email, true)}
      ${row('주소', c.address)}${row('홈페이지', c.website)}${row('담당자', c.contactName)}
    </div>`;

  const meta = [
    has(d.displayNumber) ? `<tr><th>견적번호</th><td>${esc(d.displayNumber)}</td></tr>` : '',
    has(d.issueDate) ? `<tr><th>발행일</th><td>${esc(d.issueDate)}</td></tr>` : '',
  ].join('');

  const subline = [c.phone, c.website].filter(has).map(esc).join(' · ');

  // 품목 행 — 마지막 2행은 합계·발행정보 블록(.cqd-final) 안의 이어지는 표로 렌더(인쇄 시 함께 이동).
  const rowHtml = (it: ComparisonQuotePdfData['items'][number], i: number) => `<tr${i % 2 === 1 ? ' class="z"' : ''}>
        <td class="c no">${i + 1}</td>
        <td class="l"><div class="cqd-item-name">${esc(it.description)}${it.languageLabel ? `<span class="cqd-item-lang">${esc(it.languageLabel)}</span>` : ''}</div>${it.note ? `<div class="cqd-item-note">${escMultiline(it.note)}</div>` : ''}</td>
        <td class="r">${fmt(it.quantity)}</td>
        <td class="c">${esc(it.unit)}</td>
        <td class="r">${fmt(it.unitPrice)}</td>
        <td class="r amt">${fmt(it.amount)}</td>
      </tr>`;
  const TAIL_ROWS = 2;
  const split = Math.max(0, d.items.length - TAIL_ROWS);
  const headRows = d.items.slice(0, split).map((it, i) => rowHtml(it, i)).join('');
  const tailRows = d.items.length
    ? d.items.slice(split).map((it, i) => rowHtml(it, split + i)).join('')
    : `<tr><td colspan="6" class="c" style="color:#9ca3af;padding:14px">품목 없음</td></tr>`;
  // 두 표의 열 너비를 동일하게(table-layout: fixed) — 1페이지에서는 한 표처럼 보인다.
  const cols = `<colgroup><col style="width:36px"><col><col style="width:60px"><col style="width:50px"><col style="width:88px"><col style="width:100px"></colgroup>`;
  const thead = `<thead><tr>
      <th class="c">No</th><th class="l">품목 및 내역</th><th class="r">수량</th>
      <th class="c">단위</th><th class="r">단가</th><th class="r">금액</th>
    </tr></thead>`;

  const termRows = COMPARISON_TERM_FIELDS.filter((f) => has(d.terms[f.key]))
    .map((f) => `<tr class="cqd-keep"><th>${esc(f.label)}</th><td>${escMultiline(d.terms[f.key])}</td></tr>`).join('');

  const vatLabel = d.vatMode === 'none' ? '부가세 (해당 없음)' : '부가세 (10%)';
  const totalLabel = d.vatMode === 'none' ? '합계금액' : '합계금액 (부가세 포함)';

  const closing = sim
    ? `<div class="cqd-simnote cqd-keep"><b>내부 비교용 시뮬레이션</b> — 본 문서는 내부 가격 비교·검토 목적으로 작성되었으며, 해당 업체가 발행하거나 확인한 견적서가 아닙니다. 외부 제출용으로 사용할 수 없습니다.</div>`
    : `<div class="cqd-issue cqd-keep">
        ${has(d.issueDate) ? `<div class="cqd-issue-date">${esc(issueDateText(d.issueDate))}</div>` : ''}
        <div class="cqd-issue-party">
          <div class="cqd-issue-text">
            <div class="cqd-issue-name">${esc(c.name)}</div>
            ${has(c.representativeName) ? `<div class="cqd-issue-rep"><span>대표자</span>${esc(c.representativeName)}</div>` : ''}
          </div>
          <div class="cqd-seal"><span class="cqd-seal-mark">(인)</span>${stamp ? `<img src="${esc(stamp)}" alt="직인">` : ''}</div>
        </div>
      </div>`;

  return `<div class="cqd" style="--ac:${esc(ac)};--ac-soft:${hexToRgba(ac, 0.07)};--ac-line:${hexToRgba(ac, 0.28)}">
  ${sim ? `<div class="cqd-wm">내부 비교용</div><div class="cqd-simband"><b>INTERNAL</b>내부 비교용 시뮬레이션 · 실제 업체가 발행한 견적서가 아닙니다</div>` : ''}
  <div class="cqd-keep">
    <div class="cqd-head">
      <div class="cqd-brand">
        ${logo ? `<img class="cqd-logo" src="${esc(logo)}" alt="로고">` : ''}
        <div><div class="cqd-brand-name">${esc(c.name)}</div>${subline ? `<div class="cqd-brand-sub">${subline}</div>` : ''}</div>
      </div>
      <div class="cqd-titlebox">
        <div class="cqd-title">${esc(sim ? '비교 견적' : d.design.docTitle)}</div>
        <div class="cqd-title-en">${sim ? 'INTERNAL COMPARISON' : 'QUOTATION'}</div>
        ${meta ? `<table class="cqd-meta">${meta}</table>` : ''}
      </div>
    </div>
    <div class="cqd-rule"></div>
    <div class="cqd-parties">${customerBox}${supplierBox}</div>
    <div class="cqd-amount">
      <span class="cqd-amount-label">${esc(totalLabel)}</span>
      <span class="cqd-amount-words">일금 ${koreanAmount(d.totals.total)}원정</span>
      <span class="cqd-amount-num">₩ ${fmt(d.totals.total)}</span>
    </div>
    <div class="cqd-greet">${sim ? '아래는 내부 가격 비교를 위한 견적 시뮬레이션입니다.' : '아래와 같이 견적합니다.'}</div>
  </div>
  ${headRows ? `<table class="cqd-items">${cols}${thead}<tbody>${headRows}</tbody></table>` : ''}
  <div class="cqd-final">
  <table class="cqd-items cqd-items-cont">${cols}${headRows ? '' : thead}<tbody>${tailRows}</tbody></table>
  <div class="cqd-tail">
    <table class="cqd-totals">
      <tr><th>공급가액</th><td>${fmt(d.totals.supply)}</td></tr>
      <tr><th>${esc(vatLabel)}</th><td>${fmt(d.totals.tax)}</td></tr>
      <tr class="grand"><th>${esc(totalLabel)}</th><td>${fmt(d.totals.total)} 원</td></tr>
    </table>
  </div>
  ${termRows ? `<div class="cqd-sec cqd-terms-sec"><div class="cqd-sec-title cqd-heading">견적 조건</div><table class="cqd-terms">${termRows}</table></div>` : ''}
  ${has(d.memo) ? `<div class="cqd-sec cqd-keep"><div class="cqd-sec-title">비고</div><div class="cqd-memo">${escMultiline(d.memo)}</div></div>` : ''}
  ${closing}
  </div>
</div>`;
}

/** 인쇄창 HTML — @page 여백 0 + 프레임 반복 여백으로 브라우저 머리글·바닥글(URL/날짜/페이지) 영역 제거. */
export function buildComparisonQuotePrintHtml(fileName: string, d: ComparisonQuotePdfData, opts: { autoPrint?: boolean } = {}): string {
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><title>${esc(fileName)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #fff; }
  @page { size: A4 portrait; margin: 0; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  ${COMPARISON_DOC_CSS}
  /* 용지 여백 프레임 — thead/tfoot 는 매 페이지 반복되어 모든 페이지에 상·하 여백을 만든다 */
  table.cqd-frame { width: 100%; border-collapse: collapse; }
  table.cqd-frame > thead > tr > td, table.cqd-frame > tfoot > tr > td, table.cqd-frame > tbody > tr > td { padding: 0 15mm; border: 0; vertical-align: top; }
  .cqd-space { height: 12mm; }
  /* 페이지 분할 — 품목 행·블록은 중간에서 자르지 않고, 품목 머리행은 다음 페이지에 반복 */
  .cqd-keep, .cqd-items tbody tr, .cqd-terms tr { break-inside: avoid; page-break-inside: avoid; }
  .cqd-items thead { display: table-header-group; }
  .cqd-heading { break-after: avoid; page-break-after: avoid; }
  /* 마지막 블록(합계·견적 조건·비고·발행정보)은 한 페이지에 함께 — 1페이지를 넘는 긴 비고일 때만 자연 분할.
     마지막 품목 2행도 이 블록 안(이어지는 표)에 있어, 다음 페이지가 합계만으로 시작하지 않는다. */
  .cqd-final { break-inside: avoid; page-break-inside: avoid; }
  /* 내부 비교용 워터마크 — 인쇄 시 모든 페이지 중앙에 반복 */
  .cqd-wm { position: fixed; top: 46%; }
</style></head>
<body><table class="cqd-frame">
<thead><tr><td><div class="cqd-space"></div></td></tr></thead>
<tfoot><tr><td><div class="cqd-space"></div></td></tr></tfoot>
<tbody><tr><td>${renderComparisonQuoteBody(d)}</td></tr></tbody>
</table>${opts.autoPrint ? '<script>window.onload=function(){setTimeout(function(){window.print();},150);};<\/script>' : ''}</body></html>`;
}
