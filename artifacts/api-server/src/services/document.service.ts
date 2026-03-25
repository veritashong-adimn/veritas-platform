/**
 * document.service.ts — 견적서·거래명세서 HTML 렌더러
 *
 * 구조 분리 원칙
 * ─ PlatformInfo : 발신 기관(플랫폼) 정보  → 환경변수/DB 설정으로 교체 가능
 * ─ BankInfo     : 정산 계좌 정보           → 향후 settings 테이블 연동
 * ─ QuoteDoc     : 견적서 데이터 컨텍스트
 * ─ StatementDoc : 거래명세서 데이터 컨텍스트
 *
 * PDF 출력 방식: print-ready HTML → 브라우저 인쇄 다이얼로그 → PDF 저장
 */

// ── 공통 타입 ────────────────────────────────────────────────────────────────

export type PlatformInfo = {
  name: string;
  representativeName?: string;
  businessNumber?: string;
  address?: string;
  phone?: string;
  email?: string;
  website?: string;
};

export type BankInfo = {
  bankName: string;
  accountNumber: string;
  accountHolder: string;
};

export type CompanyInfo = {
  name: string | null;
  businessNumber?: string | null;
  representativeName?: string | null;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
  industry?: string | null;
} | null;

export type ContactInfo = {
  name: string | null;
  department?: string | null;
  position?: string | null;
  email?: string | null;
  phone?: string | null;
} | null;

/** quote_items 테이블의 한 행 */
export type QuoteItemDoc = {
  id?: number;
  productName: string;
  unit?: string | null;
  quantity: number | string;
  unitPrice: number | string;
  supplyAmount: number | string;
  taxAmount: number | string;
  totalAmount: number | string;
  memo?: string | null;
};

export type QuoteDoc = {
  /** 생성된 문서번호 (doc-number.ts 참조) */
  docNumber: string;
  projectId: number;
  projectTitle: string;
  projectStatus: string;
  issuedAt: string;
  validDays?: number;

  platform: PlatformInfo;
  bank?: BankInfo | null;
  company: CompanyInfo;
  contact: ContactInfo;
  customerEmail?: string | null;

  quoteId?: number | null;
  quoteStatus?: string | null;
  quoteCreatedAt?: string | null;

  /** quote_items 목록 (있으면 품목별 렌더링, 없으면 단일 요약 행) */
  items?: QuoteItemDoc[];
  /** 공급가액 소계 (items 없을 때 사용) */
  supplyAmount?: number | null;
  /** 세액 */
  taxAmount?: number | null;
  /** 견적 총액 */
  totalAmount: number | null;

  notes?: string;
};

export type StatementDoc = {
  docNumber: string;
  projectId: number;
  projectTitle: string;
  projectStatus: string;
  issuedAt: string;

  platform: PlatformInfo;
  bank?: BankInfo | null;
  company: CompanyInfo;
  contact: ContactInfo;
  customerEmail?: string | null;

  paymentAmount?: number | null;
  paymentDate?: string | null;
  paymentStatus?: string | null;

  translatorAmount?: number | null;
  platformFee?: number | null;
  totalAmount?: number | null;

  notes?: string;
};

// ── 상태 한글 맵 ─────────────────────────────────────────────────────────────

const STATUS_KO: Record<string, string> = {
  created: "접수됨", quoted: "견적 발송", approved: "견적 승인됨",
  paid: "결제 완료", matched: "번역사 배정", in_progress: "번역 중",
  completed: "완료", cancelled: "취소됨",
  pending: "대기", sent: "발송", rejected: "거절",
};

// ── 포매터 ───────────────────────────────────────────────────────────────────

const fmt = (n: number | null | undefined): string =>
  n != null ? Number(n).toLocaleString("ko-KR") + "원" : "—";

const fmtDate = (d: string | null | undefined): string =>
  d ? new Date(d).toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" }) : "—";

const esc = (s: string | null | undefined): string =>
  (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── 공통 CSS ─────────────────────────────────────────────────────────────────

const COMMON_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{font-family:'Apple SD Gothic Neo','Malgun Gothic','맑은 고딕',AppleGothic,sans-serif;color:#111;background:#f5f5f5}
  .a4{background:#fff;width:210mm;min-height:297mm;margin:12mm auto;padding:18mm 20mm 16mm;box-shadow:0 2px 20px rgba(0,0,0,.12)}

  /* ── 문서 상단 헤더 ─────────────────────── */
  .doc-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px;padding-bottom:14px;border-bottom:3px solid #1e3a8a}
  .doc-title-block h1{font-size:30px;font-weight:900;color:#1e3a8a;letter-spacing:-1px}
  .doc-title-block p{font-size:12px;color:#6b7280;margin-top:2px;letter-spacing:.5px}
  .doc-meta{text-align:right;font-size:12px;color:#374151;line-height:2}
  .doc-meta .label{color:#9ca3af;margin-right:4px}
  .doc-meta strong{color:#111;font-size:13px}
  .doc-meta .badge{display:inline-block;margin-top:4px;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe}

  /* ── 발신·수신 그리드 ───────────────────── */
  .party-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px}
  .party-box{border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;background:#fafafa}
  .party-box.receiver{background:#eff6ff;border-color:#bfdbfe}
  .party-box h3{font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px;padding-bottom:5px;border-bottom:1px solid #e2e8f0}
  .party-box.receiver h3{color:#1d4ed8;border-color:#bfdbfe}
  .f{display:flex;gap:4px;font-size:12px;line-height:1.7}
  .fl{color:#9ca3af;min-width:64px;flex-shrink:0;font-size:11px}
  .fv{color:#111;font-weight:500;word-break:break-all}

  /* ── 섹션 제목 ──────────────────────────── */
  .sec-title{font-size:10px;font-weight:800;color:#1e3a8a;text-transform:uppercase;letter-spacing:.8px;padding-bottom:5px;border-bottom:1.5px solid #bfdbfe;margin-bottom:10px}

  /* ── 품목 테이블 ────────────────────────── */
  .item-table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:0}
  .item-table th{background:#1e3a8a;color:#fff;padding:7px 10px;text-align:center;font-size:11px;font-weight:700}
  .item-table th:first-child{text-align:left;border-radius:4px 0 0 0}
  .item-table th:last-child{border-radius:0 4px 0 0}
  .item-table td{padding:7px 10px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
  .item-table tr:last-child td{border-bottom:none}
  .item-table tr:nth-child(even) td{background:#f8fafc}
  .item-table .num{text-align:right}
  .item-table .ctr{text-align:center}
  .item-table tfoot td{border-top:2px solid #1e3a8a;font-weight:700}

  /* ── 금액 요약 박스 ─────────────────────── */
  .amount-summary{margin-top:10px;display:flex;flex-direction:column;align-items:flex-end}
  .amount-rows{width:260px;font-size:12px}
  .amt-row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px dashed #e2e8f0}
  .amt-row:last-child{border-bottom:none;margin-top:4px;padding-top:8px}
  .amt-row .a-label{color:#6b7280}
  .amt-row .a-value{font-weight:700;color:#374151}
  .amt-row.total-row{background:#eff6ff;border-radius:6px;padding:10px 12px;margin-top:6px}
  .amt-row.total-row .a-label{font-size:14px;font-weight:800;color:#1e3a8a}
  .amt-row.total-row .a-value{font-size:18px;font-weight:900;color:#1e3a8a}

  /* ── 계좌·안내 영역 ─────────────────────── */
  .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
  .info-box{border:1px solid #e2e8f0;border-radius:8px;padding:11px 13px;font-size:12px}
  .info-box h4{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:#6b7280;margin-bottom:7px}
  .info-box p{line-height:1.7;color:#374151}
  .info-box.bank{background:#f0fdf4;border-color:#bbf7d0}
  .info-box.bank h4{color:#166534}
  .info-box.guide{background:#fffbeb;border-color:#fde68a}
  .info-box.guide h4{color:#92400e}

  /* ── 비고 ───────────────────────────────── */
  .notes-box{margin-top:12px;border:1px solid #e2e8f0;border-radius:8px;padding:11px 13px;background:#f8fafc}
  .notes-box h4{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:#6b7280;margin-bottom:6px}
  .notes-box p{font-size:12px;color:#374151;line-height:1.7;white-space:pre-wrap}

  /* ── 서명란 ─────────────────────────────── */
  .sig-area{margin-top:20px;display:flex;justify-content:flex-end}
  .sig-box{width:180px;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;text-align:center;font-size:12px}
  .sig-box p{color:#374151;margin-bottom:24px}
  .sig-box .sig-line{border-top:1px solid #9ca3af;padding-top:6px;color:#9ca3af;font-size:11px}

  /* ── 푸터 ───────────────────────────────── */
  .doc-footer{margin-top:18px;padding-top:10px;border-top:1px solid #e2e8f0;text-align:center;font-size:10px;color:#9ca3af;line-height:1.9}

  /* ── 인쇄 버튼 ──────────────────────────── */
  .print-btn{position:fixed;bottom:20px;right:20px;background:#1e3a8a;color:#fff;border:none;border-radius:10px;padding:11px 20px;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 4px 14px rgba(30,58,138,.4);z-index:100;display:flex;align-items:center;gap:6px}
  .print-badge{background:#fff;color:#1e3a8a;border-radius:4px;padding:1px 6px;font-size:11px}

  @media print{
    html,body{background:#fff}
    .a4{width:100%;margin:0;padding:12mm 14mm 10mm;box-shadow:none}
    .print-btn{display:none}
    @page{size:A4 portrait;margin:8mm 10mm}
    .no-break{page-break-inside:avoid}
  }
`;

// ── 베이스 HTML 래퍼 ──────────────────────────────────────────────────────────

function baseHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<style>${COMMON_CSS}</style>
</head>
<body>
<div class="a4">
${body}
</div>
<button class="print-btn" onclick="window.print()">
  🖨 인쇄 / PDF 저장 <span class="print-badge">Ctrl+P</span>
</button>
<script>
(function(){
  if(window.location.hash==='#noprint') return;
  var t=setTimeout(function(){window.print();},700);
  window.addEventListener('beforeprint',function(){clearTimeout(t);},{once:true});
})();
</script>
</body>
</html>`;
}

// ── 발신·수신처 공통 렌더러 ──────────────────────────────────────────────────

function renderSender(p: PlatformInfo): string {
  return `
  <div class="party-box">
    <h3>공급자 (발신)</h3>
    <div class="f"><span class="fl">상호</span><span class="fv">${esc(p.name)}</span></div>
    ${p.businessNumber ? `<div class="f"><span class="fl">사업자번호</span><span class="fv">${esc(p.businessNumber)}</span></div>` : ""}
    ${p.representativeName ? `<div class="f"><span class="fl">대표자</span><span class="fv">${esc(p.representativeName)}</span></div>` : ""}
    ${p.address ? `<div class="f"><span class="fl">주소</span><span class="fv">${esc(p.address)}</span></div>` : ""}
    ${p.phone ? `<div class="f"><span class="fl">전화</span><span class="fv">${esc(p.phone)}</span></div>` : ""}
    ${p.email ? `<div class="f"><span class="fl">이메일</span><span class="fv">${esc(p.email)}</span></div>` : ""}
  </div>`;
}

function renderReceiver(co: CompanyInfo, ct: ContactInfo): string {
  if (!co) return `<div class="party-box receiver"><h3>공급받는자 (수신)</h3><p style="color:#9ca3af;font-size:12px">거래처 정보 없음</p></div>`;
  return `
  <div class="party-box receiver">
    <h3>공급받는자 (수신)</h3>
    <div class="f"><span class="fl">상호</span><span class="fv"><strong>${esc(co.name)}</strong></span></div>
    ${co.businessNumber ? `<div class="f"><span class="fl">사업자번호</span><span class="fv">${esc(co.businessNumber)}</span></div>` : ""}
    ${co.representativeName ? `<div class="f"><span class="fl">대표자</span><span class="fv">${esc(co.representativeName)}</span></div>` : ""}
    ${co.industry ? `<div class="f"><span class="fl">업종</span><span class="fv">${esc(co.industry)}</span></div>` : ""}
    ${co.address ? `<div class="f"><span class="fl">주소</span><span class="fv">${esc(co.address)}</span></div>` : ""}
    ${co.phone ? `<div class="f"><span class="fl">전화</span><span class="fv">${esc(co.phone)}</span></div>` : ""}
    ${co.email ? `<div class="f"><span class="fl">이메일</span><span class="fv">${esc(co.email)}</span></div>` : ""}
    ${ct?.name ? `<div class="f" style="margin-top:4px;padding-top:4px;border-top:1px dashed #bfdbfe"><span class="fl">담당자</span><span class="fv">${esc(ct.name)}${ct.position ? " · " + esc(ct.position) : ""}${ct.department ? " / " + esc(ct.department) : ""}</span></div>` : ""}
    ${ct?.phone ? `<div class="f"><span class="fl">담당 전화</span><span class="fv">${esc(ct.phone)}</span></div>` : ""}
    ${ct?.email ? `<div class="f"><span class="fl">담당 이메일</span><span class="fv">${esc(ct.email)}</span></div>` : ""}
  </div>`;
}

function renderBankInfo(bank?: BankInfo | null): string {
  if (!bank) {
    return `<div class="info-box bank">
      <h4>입금 계좌</h4>
      <p style="color:#9ca3af">계좌 정보 미등록<br/>(설정에서 추가 가능)</p>
    </div>`;
  }
  return `<div class="info-box bank">
    <h4>입금 계좌</h4>
    <p><strong>${esc(bank.bankName)}</strong><br/>
    ${esc(bank.accountNumber)}<br/>
    예금주: ${esc(bank.accountHolder)}</p>
  </div>`;
}

// ── 견적서 HTML 빌더 ─────────────────────────────────────────────────────────

export function buildQuoteHtml(doc: QuoteDoc): string {
  const validDays = doc.validDays ?? 30;

  /* 품목 테이블 행 — quote_items 배열 or 단일 요약 행 폴백 */
  const hasItems = doc.items && doc.items.length > 0;
  const itemRows = hasItems
    ? doc.items!.map((item, i) => `
      <tr>
        <td class="ctr">${i + 1}</td>
        <td>${esc(item.productName)}${item.memo ? `<br/><span style="font-size:10px;color:#6b7280">${esc(item.memo)}</span>` : ""}</td>
        <td class="ctr">${esc(String(item.unit ?? "건"))}</td>
        <td class="num">${Number(item.quantity).toLocaleString("ko-KR")}</td>
        <td class="num">${Number(item.unitPrice).toLocaleString("ko-KR")}원</td>
        <td class="num">${Number(item.supplyAmount).toLocaleString("ko-KR")}원</td>
        <td class="num">${Number(item.taxAmount).toLocaleString("ko-KR")}원</td>
        <td class="num">${Number(item.totalAmount).toLocaleString("ko-KR")}원</td>
      </tr>`).join("")
    : `<tr>
        <td class="ctr">1</td>
        <td>${esc(doc.projectTitle)} 번역 서비스</td>
        <td class="ctr">건</td>
        <td class="num">1</td>
        <td class="num">—</td>
        <td class="num">${fmt(doc.supplyAmount ?? doc.totalAmount)}</td>
        <td class="num">${fmt(doc.taxAmount ?? 0)}</td>
        <td class="num">${fmt(doc.totalAmount)}</td>
      </tr>`;

  const supply = hasItems
    ? doc.items!.reduce((s, it) => s + Number(it.supplyAmount), 0)
    : (doc.supplyAmount ?? doc.totalAmount ?? 0);
  const tax = hasItems
    ? doc.items!.reduce((s, it) => s + Number(it.taxAmount), 0)
    : (doc.taxAmount ?? 0);
  const total = hasItems
    ? doc.items!.reduce((s, it) => s + Number(it.totalAmount), 0)
    : (doc.totalAmount ?? (supply + tax));

  const body = `
  <!-- 문서 헤더 -->
  <div class="doc-header">
    <div class="doc-title-block">
      <h1>견 적 서</h1>
      <p>QUOTATION</p>
    </div>
    <div class="doc-meta">
      <div><span class="label">문서번호</span><strong>${esc(doc.docNumber)}</strong></div>
      <div><span class="label">발행일</span><strong>${fmtDate(doc.issuedAt)}</strong></div>
      <div><span class="label">유효기간</span><strong>발행일로부터 ${validDays}일</strong></div>
      <div><span class="label">프로젝트</span><strong>#${doc.projectId}</strong></div>
      ${doc.quoteId ? `<div><span class="label">견적ID</span><strong>Q-${String(doc.quoteId).padStart(5, "0")}</strong></div>` : ""}
      <div><span class="badge">${esc(STATUS_KO[doc.projectStatus] ?? doc.projectStatus)}</span></div>
    </div>
  </div>

  <!-- 발신·수신 -->
  <div class="party-grid no-break">
    ${renderSender(doc.platform)}
    ${renderReceiver(doc.company, doc.contact)}
  </div>

  <!-- 프로젝트 정보 한 줄 -->
  <div style="font-size:12px;color:#374151;margin-bottom:12px;padding:8px 12px;background:#f8fafc;border-radius:6px;border-left:3px solid #1e3a8a">
    <strong>프로젝트:</strong> ${esc(doc.projectTitle)}
    ${doc.customerEmail ? ` &nbsp;|&nbsp; <strong>고객:</strong> ${esc(doc.customerEmail)}` : ""}
    ${doc.quoteCreatedAt ? ` &nbsp;|&nbsp; <strong>견적일:</strong> ${fmtDate(doc.quoteCreatedAt)}` : ""}
    ${doc.quoteStatus ? ` &nbsp;|&nbsp; <strong>견적상태:</strong> ${esc(STATUS_KO[doc.quoteStatus] ?? doc.quoteStatus)}` : ""}
  </div>

  <!-- 품목 테이블 -->
  <div style="margin-bottom:0" class="no-break">
    <p class="sec-title">공급 내역</p>
    <table class="item-table">
      <thead>
        <tr>
          <th style="width:28px">No.</th>
          <th>품목명</th>
          <th style="width:36px">단위</th>
          <th style="width:44px">수량</th>
          <th style="width:82px">단가</th>
          <th style="width:86px">공급가액</th>
          <th style="width:72px">세액</th>
          <th style="width:86px">합계</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
      <tfoot>
        <tr>
          <td colspan="5" style="text-align:right;color:#6b7280;font-size:11px">소 계</td>
          <td class="num">${fmt(supply)}</td>
          <td class="num">${fmt(tax)}</td>
          <td class="num">${fmt(total)}</td>
        </tr>
      </tfoot>
    </table>
  </div>

  <!-- 금액 요약 -->
  <div class="amount-summary no-break">
    <div class="amount-rows">
      <div class="amt-row"><span class="a-label">공급가액</span><span class="a-value">${fmt(supply)}</span></div>
      <div class="amt-row"><span class="a-label">부가세 (VAT)</span><span class="a-value">${fmt(tax)}</span></div>
      <div class="amt-row total-row"><span class="a-label">견적 총액</span><span class="a-value">${fmt(total)}</span></div>
    </div>
  </div>

  <!-- 계좌 & 안내 -->
  <div class="info-grid no-break">
    ${renderBankInfo(doc.bank)}
    <div class="info-box guide">
      <h4>안내 사항</h4>
      <p>· 본 견적서는 발행일로부터 <strong>${validDays}일</strong>간 유효합니다.<br/>
         · 견적 금액에는 부가세(VAT)가 포함되어 있습니다.<br/>
         · 계약 체결 후 착수금 선납 시 작업이 시작됩니다.<br/>
         · 문의: ${esc(doc.platform.email ?? doc.platform.phone ?? "담당자에게 연락바랍니다")}</p>
    </div>
  </div>

  ${doc.notes ? `<div class="notes-box no-break"><h4>비고</h4><p>${esc(doc.notes)}</p></div>` : ""}

  <!-- 서명란 -->
  <div class="sig-area no-break">
    <div class="sig-box">
      <p>${esc(doc.platform.name)}</p>
      <div class="sig-line">(인)</div>
    </div>
  </div>

  <div class="doc-footer">
    <p>${esc(doc.platform.name)} · ${esc(doc.platform.address ?? "")} · ${esc(doc.platform.phone ?? "")} · ${esc(doc.platform.email ?? "")}</p>
  </div>`;

  return baseHtml(`견적서 ${doc.docNumber} — ${doc.projectTitle}`, body);
}

// ── 거래명세서 HTML 빌더 ──────────────────────────────────────────────────────

export function buildStatementHtml(doc: StatementDoc): string {
  const paid = doc.paymentAmount ?? doc.totalAmount ?? 0;
  const translatorAmt = doc.translatorAmount;
  const platformFee = doc.platformFee;
  const total = doc.totalAmount ?? paid;

  const body = `
  <!-- 문서 헤더 -->
  <div class="doc-header">
    <div class="doc-title-block">
      <h1>거 래 명 세 서</h1>
      <p>TRANSACTION STATEMENT</p>
    </div>
    <div class="doc-meta">
      <div><span class="label">문서번호</span><strong>${esc(doc.docNumber)}</strong></div>
      <div><span class="label">발행일</span><strong>${fmtDate(doc.issuedAt)}</strong></div>
      ${doc.paymentDate ? `<div><span class="label">결제일</span><strong>${fmtDate(doc.paymentDate)}</strong></div>` : ""}
      <div><span class="label">프로젝트</span><strong>#${doc.projectId}</strong></div>
      <div><span class="badge">${esc(STATUS_KO[doc.projectStatus] ?? doc.projectStatus)}</span></div>
    </div>
  </div>

  <!-- 발신·수신 -->
  <div class="party-grid no-break">
    ${renderSender(doc.platform)}
    ${renderReceiver(doc.company, doc.contact)}
  </div>

  <!-- 프로젝트 정보 -->
  <div style="font-size:12px;color:#374151;margin-bottom:12px;padding:8px 12px;background:#f8fafc;border-radius:6px;border-left:3px solid #1e3a8a">
    <strong>프로젝트:</strong> ${esc(doc.projectTitle)}
    ${doc.customerEmail ? ` &nbsp;|&nbsp; <strong>고객:</strong> ${esc(doc.customerEmail)}` : ""}
    ${doc.paymentStatus ? ` &nbsp;|&nbsp; <strong>결제상태:</strong> ${esc(STATUS_KO[doc.paymentStatus] ?? doc.paymentStatus)}` : ""}
  </div>

  <!-- 거래 내역 테이블 -->
  <div class="no-break" style="margin-bottom:0">
    <p class="sec-title">거래 내역</p>
    <table class="item-table">
      <thead>
        <tr>
          <th style="width:30px">No.</th>
          <th>항목</th>
          <th style="width:40px">수량</th>
          <th style="width:100px">단가</th>
          <th style="width:110px">공급가액</th>
          <th style="width:80px">세액</th>
          <th style="width:110px">합계</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>1</td>
          <td>${esc(doc.projectTitle)} 번역 용역</td>
          <td class="ctr">1</td>
          <td class="num">—</td>
          <td class="num">${fmt(paid)}</td>
          <td class="num">0원</td>
          <td class="num">${fmt(paid)}</td>
        </tr>
      </tbody>
      <tfoot>
        <tr>
          <td colspan="4" style="text-align:right;color:#6b7280;font-size:11px">소 계</td>
          <td class="num">${fmt(paid)}</td>
          <td class="num">0원</td>
          <td class="num">${fmt(paid)}</td>
        </tr>
      </tfoot>
    </table>
  </div>

  <!-- 금액 요약 -->
  <div class="amount-summary no-break">
    <div class="amount-rows">
      <div class="amt-row"><span class="a-label">결제 금액</span><span class="a-value">${fmt(paid)}</span></div>
      ${translatorAmt != null ? `<div class="amt-row"><span class="a-label">번역사 지급액</span><span class="a-value">${fmt(translatorAmt)}</span></div>` : ""}
      ${platformFee != null && Number(platformFee) > 0 ? `<div class="amt-row"><span class="a-label">플랫폼 수수료</span><span class="a-value">${fmt(platformFee)}</span></div>` : ""}
      <div class="amt-row total-row"><span class="a-label">거래 합계</span><span class="a-value">${fmt(total)}</span></div>
    </div>
  </div>

  <!-- 계좌 & 안내 -->
  <div class="info-grid no-break">
    ${renderBankInfo(doc.bank)}
    <div class="info-box guide">
      <h4>안내 사항</h4>
      <p>· 위 금액을 정히 영수합니다.<br/>
         · 세금계산서는 별도 발행됩니다.<br/>
         · 이미 결제된 건에 대해 정정이 필요한 경우 담당자에게 문의해 주세요.<br/>
         · 문의: ${esc(doc.platform.email ?? doc.platform.phone ?? "담당자에게 연락바랍니다")}</p>
    </div>
  </div>

  ${doc.notes ? `<div class="notes-box no-break"><h4>비고</h4><p>${esc(doc.notes)}</p></div>` : ""}

  <!-- 서명란 -->
  <div class="sig-area no-break">
    <div class="sig-box">
      <p>${esc(doc.platform.name)}</p>
      <div class="sig-line">(인)</div>
    </div>
  </div>

  <div class="doc-footer">
    <p>${esc(doc.platform.name)} · ${esc(doc.platform.address ?? "")} · ${esc(doc.platform.phone ?? "")} · ${esc(doc.platform.email ?? "")}</p>
  </div>`;

  return baseHtml(`거래명세서 ${doc.docNumber} — ${doc.projectTitle}`, body);
}
