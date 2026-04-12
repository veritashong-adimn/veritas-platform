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
  /** 서명 이미지 URL (Object Storage) — 설정에서 관리 */
  signatureImageUrl?: string | null;
};

export type BankInfo = {
  bankName: string;
  accountNumber: string;
  accountHolder: string;
};

export type CompanyInfo = {
  name: string | null;
  divisionName?: string | null;
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

  /** 세무/발행 구분 */
  taxDocumentType?: "tax_invoice" | "zero_tax_invoice" | "bill";
  taxCategory?: "normal" | "zero_rated" | "consignment" | "consignment_zero_rated";

  // ── 견적서 유형 ────────────────────────────────────────────────────────────
  /** b2c_prepaid | b2b_standard | prepaid_deduction | accumulated_batch */
  quoteType?: "b2c_prepaid" | "b2b_standard" | "prepaid_deduction" | "accumulated_batch";
  /** postpaid_per_project | prepaid_wallet | monthly_billing */
  billingType?: string;

  // 공통 날짜
  validUntil?: string | null;
  issueDate?: string | null;
  invoiceDueDate?: string | null;
  paymentDueDate?: string | null;

  // 선입금 차감 (prepaid_deduction)
  prepaidBalanceBefore?: number | null;
  prepaidUsageAmount?: number | null;
  prepaidBalanceAfter?: number | null;
  /** 선입금 계정의 모든 거래 내역 (누적 차감 이력) */
  ledgerHistory?: Array<{
    id: number;
    type: "deposit" | "deduction" | "adjustment";
    amount: number;
    balanceAfter: number;
    description?: string | null;
    projectId?: number | null;
    projectTitle?: string | null;
    transactionDate: string | null;
    createdAt: string | null;
  }>;

  // 누적 견적 (accumulated_batch)
  batchPeriodStart?: string | null;
  batchPeriodEnd?: string | null;
  batchItemCount?: number | null;
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

  /* ── 상단 액션 바 ────────────────────────── */
  .action-bar{position:fixed;top:0;left:0;right:0;height:48px;background:#1e293b;display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:0 24px;z-index:200;box-shadow:0 2px 8px rgba(0,0,0,.25)}
  .action-bar-title{flex:1;font-size:13px;font-weight:600;color:#cbd5e1;letter-spacing:.2px}
  .btn-pdf{background:#2563eb;color:#fff;border:none;border-radius:7px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:5px}
  .btn-close{background:transparent;color:#94a3b8;border:1px solid #475569;border-radius:7px;padding:8px 14px;font-size:12px;font-weight:600;cursor:pointer}
  .btn-pdf:hover{background:#1d4ed8}
  .btn-close:hover{background:#334155;color:#e2e8f0}
  body{padding-top:56px}

  @media print{
    html,body{background:#fff;padding-top:0}
    .action-bar{display:none}
    .a4{width:100%;margin:0;padding:12mm 14mm 10mm;box-shadow:none}
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
<div class="action-bar">
  <span class="action-bar-title">📄 ${esc(title)}</span>
  <button class="btn-pdf" onclick="window.print()">🖨 PDF 출력</button>
  <button class="btn-close" onclick="window.close()">✕ 닫기</button>
</div>
<div class="a4">
${body}
</div>
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

/** 파일명 슬러그: "회사명_브랜드" 형식 (언더바, showDivision=false 시 회사명만) */
function companyFileSlug(co: CompanyInfo, showDivision = true): string {
  if (!co?.name) return "";
  const base = co.name.replace(/\s+/g, "");
  if (showDivision && co.divisionName) return `${base}_${co.divisionName.replace(/\s+/g, "")}`;
  return base;
}

function renderReceiver(co: CompanyInfo, ct: ContactInfo, showDivision = true): string {
  if (!co) return `<div class="party-box receiver"><h3>공급받는자 (수신)</h3><p style="color:#9ca3af;font-size:12px">거래처 정보 없음</p></div>`;
  const displayName = showDivision && co.name && co.divisionName
    ? `${co.name}(${co.divisionName})`
    : (co.name ?? "");
  return `
  <div class="party-box receiver">
    <h3>공급받는자 (수신)</h3>
    <div class="f"><span class="fl">상호</span><span class="fv"><strong>${esc(displayName)}</strong></span></div>
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

// ── 견적서 공통 라벨/헬퍼 ────────────────────────────────────────────────────

const TAX_DOC_LABEL: Record<string, string> = {
  tax_invoice: "세금계산서",
  zero_tax_invoice: "세금계산서(영세율)",
  bill: "계산서",
};
const TAX_CAT_LABEL: Record<string, string> = {
  normal: "일반",
  zero_rated: "영세율",
  consignment: "위수탁",
  consignment_zero_rated: "위수탁영세율",
};
const QUOTE_TYPE_LABEL: Record<string, string> = {
  b2c_prepaid: "B2C 선입금",
  b2b_standard: "B2B 일반",
  prepaid_deduction: "선입금 차감",
  accumulated_batch: "누적 견적",
};
const BILLING_TYPE_LABEL: Record<string, string> = {
  postpaid_per_project: "건별 후불",
  prepaid_wallet: "선입금",
  monthly_billing: "월 청구",
};

/** quote_items 테이블 or 단일 요약 행 렌더 → { itemRows, supply, tax, total } */
function calcItemData(doc: QuoteDoc) {
  const hasItems = !!(doc.items && doc.items.length > 0);
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

  return { itemRows, supply, tax, total };
}

/** 품목표 HTML 블록 */
function renderItemTable(itemRows: string, supply: number, tax: number, total: number): string {
  return `
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
  </div>`;
}

/** 서명+푸터 공통 */
function renderSignatureAndFooter(platform: PlatformInfo): string {
  const sigContent = platform.signatureImageUrl
    ? `<img src="${esc(platform.signatureImageUrl)}" alt="서명" style="max-height:48px;max-width:140px;object-fit:contain;display:block;margin:0 auto 2px" />`
    : `<div class="sig-line">(인)</div>`;
  return `
  <div class="sig-area no-break">
    <div class="sig-box">
      <p>${esc(platform.name)}</p>
      ${sigContent}
    </div>
  </div>
  <div class="doc-footer">
    <p>${esc(platform.name)} · ${esc(platform.address ?? "")} · ${esc(platform.phone ?? "")} · ${esc(platform.email ?? "")}</p>
  </div>`;
}

/** 공통 문서 헤더 */
function renderDocHeader(doc: QuoteDoc, h1: string, sub: string, extraBadges = ""): string {
  const taxDocType = doc.taxDocumentType ?? "tax_invoice";
  const taxCat = doc.taxCategory ?? "normal";
  const isBill = taxDocType === "bill";
  const isZeroRated = taxCat === "zero_rated";
  const isConsignment = taxCat === "consignment" || taxCat === "consignment_zero_rated";

  const taxBadge = `
    <span style="display:inline-block;padding:2px 9px;border-radius:4px;font-size:11px;font-weight:800;background:${isBill ? "#fef3c7" : "#eff6ff"};color:${isBill ? "#92400e" : "#1d4ed8"};border:1px solid ${isBill ? "#fde68a" : "#bfdbfe"}">
      ${esc(TAX_DOC_LABEL[taxDocType] ?? taxDocType)}
    </span>
    <span style="display:inline-block;padding:2px 9px;border-radius:4px;font-size:11px;font-weight:700;background:${isConsignment ? "#fdf4ff" : isZeroRated ? "#f0fdf4" : "#f8fafc"};color:${isConsignment ? "#7c3aed" : isZeroRated ? "#166534" : "#374151"};border:1px solid ${isConsignment ? "#d8b4fe" : isZeroRated ? "#bbf7d0" : "#e2e8f0"}">
      ${esc(TAX_CAT_LABEL[taxCat] ?? taxCat)}
    </span>`;

  return `
  <div class="doc-header">
    <div class="doc-title-block">
      <h1>${h1}</h1>
      <p>${sub}</p>
      <div style="display:flex;gap:5px;margin-top:6px;flex-wrap:wrap;">
        ${taxBadge}
        ${extraBadges}
      </div>
    </div>
    <div class="doc-meta">
      <div><span class="label">문서번호</span><strong>${esc(doc.docNumber)}</strong></div>
      <div><span class="label">발행일</span><strong>${fmtDate(doc.issuedAt)}</strong></div>
      <div><span class="label">프로젝트</span><strong>#${doc.projectId}</strong></div>
      ${doc.quoteId ? `<div><span class="label">견적ID</span><strong>Q-${String(doc.quoteId).padStart(5, "0")}</strong></div>` : ""}
      <div><span class="badge">${esc(STATUS_KO[doc.projectStatus] ?? doc.projectStatus)}</span></div>
    </div>
  </div>`;
}

/** 공통 프로젝트 정보 바 */
function renderProjectBar(doc: QuoteDoc): string {
  return `
  <div style="font-size:12px;color:#374151;margin-bottom:12px;padding:8px 12px;background:#f8fafc;border-radius:6px;border-left:3px solid #1e3a8a">
    <strong>프로젝트:</strong> ${esc(doc.projectTitle)}
    ${doc.customerEmail ? ` &nbsp;|&nbsp; <strong>담당자:</strong> ${esc(doc.customerEmail)}` : ""}
    ${doc.quoteCreatedAt ? ` &nbsp;|&nbsp; <strong>견적일:</strong> ${fmtDate(doc.quoteCreatedAt)}` : ""}
    ${doc.quoteStatus ? ` &nbsp;|&nbsp; <strong>견적상태:</strong> ${esc(STATUS_KO[doc.quoteStatus] ?? doc.quoteStatus)}` : ""}
  </div>`;
}

// ── 세무 분기별 금액 요약 & 안내문 ───────────────────────────────────────────

function renderTaxAmountSummary(doc: QuoteDoc, supply: number, tax: number, total: number, totalLabel = "견적 총액"): string {
  const taxDocType = doc.taxDocumentType ?? "tax_invoice";
  const taxCat = doc.taxCategory ?? "normal";
  const isBill = taxDocType === "bill";
  const isZeroTaxInvoice = taxDocType === "zero_tax_invoice";
  const isZeroRated = isZeroTaxInvoice || taxCat === "zero_rated";
  const isConsignment = !isZeroTaxInvoice && (taxCat === "consignment" || taxCat === "consignment_zero_rated");
  const isConsignmentZero = !isZeroTaxInvoice && taxCat === "consignment_zero_rated";

  const taxRow = isBill
    ? `<div class="amt-row"><span class="a-label" style="color:#92400e">세액 없음 (계산서)</span><span class="a-value" style="color:#9ca3af">—</span></div>`
    : isZeroRated
      ? `<div class="amt-row"><span class="a-label">세액 <span style="font-size:10px;background:#dcfce7;color:#166534;padding:1px 5px;border-radius:3px">영세율</span></span><span class="a-value">0원</span></div>`
      : isConsignment
        ? `<div class="amt-row"><span class="a-label">부가세 (VAT) <span style="font-size:10px;background:#fdf4ff;color:#7c3aed;padding:1px 5px;border-radius:3px">${isConsignmentZero ? "위수탁영세율" : "위수탁"}</span></span><span class="a-value">${isConsignmentZero ? "0원" : fmt(tax)}</span></div>`
        : `<div class="amt-row"><span class="a-label">부가세 (VAT 10%)</span><span class="a-value">${fmt(tax)}</span></div>`;

  const consignmentNote = isConsignment ? `
  <div style="margin-top:8px;padding:8px 12px;background:#fdf4ff;border:1px solid #d8b4fe;border-radius:6px;font-size:11px;color:#7c3aed">
    ※ 위수탁 거래: 본 견적서는 위수탁 계약에 따른 공급가액으로 작성되었습니다.${isConsignmentZero ? " 영세율이 적용됩니다." : ""}
  </div>` : "";

  return `
  <div class="amount-summary no-break">
    <div class="amount-rows">
      <div class="amt-row"><span class="a-label">공급가액</span><span class="a-value">${fmt(supply)}</span></div>
      ${taxRow}
      <div class="amt-row total-row"><span class="a-label">${esc(totalLabel)}</span><span class="a-value">${fmt(total)}</span></div>
    </div>
  </div>
  ${consignmentNote}`;
}

function renderTaxGuideText(doc: QuoteDoc): string {
  const taxDocType = doc.taxDocumentType ?? "tax_invoice";
  const taxCat = doc.taxCategory ?? "normal";
  const isBill = taxDocType === "bill";
  const isZeroTaxInvoice = taxDocType === "zero_tax_invoice";
  const isZeroRated = isZeroTaxInvoice || taxCat === "zero_rated";
  const isConsignment = !isZeroTaxInvoice && (taxCat === "consignment" || taxCat === "consignment_zero_rated");
  if (isBill) return "· 본 계산서는 부가세가 포함되지 않습니다.";
  if (isZeroTaxInvoice) return "· 세금계산서(영세율) — 영세율이 적용되어 세액은 0원입니다.";
  if (isZeroRated) return "· 영세율이 적용되어 세액은 0원입니다.";
  if (isConsignment) return "· 위수탁 거래 기준으로 작성되었습니다.";
  return "· 견적 금액에는 부가세(VAT 10%)가 포함됩니다.";
}

// ══════════════════════════════════════════════════════════════════════════════
// ── 견적서 유형별 빌더 ────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

/** B2C 선입금 견적서 */
export function buildB2CPrepaidQuoteHtml(doc: QuoteDoc): string {
  const { itemRows, supply, tax, total } = calcItemData(doc);

  const body = `
  ${renderDocHeader(doc, "견 적 서", "B2C PREPAID QUOTATION",
    `<span style="display:inline-block;padding:2px 9px;border-radius:4px;font-size:11px;font-weight:700;background:#fef3c7;color:#92400e;border:1px solid #fde68a">B2C 선입금</span>`
  )}

  <div class="party-grid no-break">
    ${renderSender(doc.platform)}
    ${renderReceiver(doc.company, doc.contact, true)}
  </div>

  ${renderProjectBar(doc)}

  <!-- 유효기간 / 결제 안내 -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
    <div style="border:1px solid #fde68a;border-radius:6px;padding:10px 12px;background:#fffbeb;font-size:12px">
      <div style="font-size:10px;font-weight:800;color:#92400e;margin-bottom:6px;text-transform:uppercase">견적 유효기간</div>
      <div style="color:#374151">
        ${doc.validUntil
          ? `<strong>${fmtDate(doc.validUntil)}</strong>까지`
          : `-`}
      </div>
    </div>
    <div style="border:1px solid #bbf7d0;border-radius:6px;padding:10px 12px;background:#f0fdf4;font-size:12px">
      <div style="font-size:10px;font-weight:800;color:#166534;margin-bottom:6px;text-transform:uppercase">결제 안내</div>
      <div style="color:#374151">선입금 완납 후 작업 시작</div>
    </div>
  </div>

  ${renderItemTable(itemRows, supply, tax, total)}
  ${renderTaxAmountSummary(doc, supply, tax, total, "견적 총액 (선입금)")}

  <div class="info-grid no-break">
    ${renderBankInfo(doc.bank)}
    <div class="info-box guide">
      <h4>안내 사항</h4>
      <p>· 본 견적서는 B2C 선입금 방식으로 발행되었습니다.<br/>
         ${renderTaxGuideText(doc)}<br/>
         · 선입금 확인 후 즉시 작업이 시작됩니다.<br/>
         · 입금 후 환불은 착수 전까지만 가능합니다.<br/>
         · 문의: ${esc(doc.platform.email ?? doc.platform.phone ?? "담당자에게 연락바랍니다")}</p>
    </div>
  </div>

  ${doc.notes ? `<div class="notes-box no-break"><h4>비고</h4><p>${esc(doc.notes)}</p></div>` : ""}
  ${renderSignatureAndFooter(doc.platform)}`;

  const slug = companyFileSlug(doc.company, true);
  return baseHtml(`${slug ? slug + "_" : ""}B2C선입금견적서_${doc.docNumber}`, body);
}

/** B2B 일반 견적서 */
export function buildB2BStandardQuoteHtml(doc: QuoteDoc): string {
  const { itemRows, supply, tax, total } = calcItemData(doc);
  const taxDocType = doc.taxDocumentType ?? "tax_invoice";
  const taxCat = doc.taxCategory ?? "normal";
  // 세금계산서(tax_invoice, zero_tax_invoice)는 법적 문서 — division 미포함
  const showDivision = taxDocType !== "tax_invoice" && taxDocType !== "zero_tax_invoice";

  const body = `
  ${renderDocHeader(doc, "견 적 서", "B2B STANDARD QUOTATION",
    `<span style="display:inline-block;padding:2px 9px;border-radius:4px;font-size:11px;font-weight:700;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe">B2B 일반</span>`
  )}

  <div class="party-grid no-break">
    ${renderSender(doc.platform)}
    ${renderReceiver(doc.company, doc.contact, showDivision)}
  </div>

  ${renderProjectBar(doc)}

  <!-- 발행 일정 정보 -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
    <div style="border:1px solid #e2e8f0;border-radius:6px;padding:8px 10px;background:#f8fafc;font-size:11px">
      <div style="font-size:9px;font-weight:800;color:#6b7280;margin-bottom:4px;text-transform:uppercase">세금계산서 구분</div>
      <strong>${esc(TAX_DOC_LABEL[taxDocType] ?? taxDocType)} / ${esc(TAX_CAT_LABEL[taxCat] ?? taxCat)}</strong>
    </div>
    <div style="border:1px solid #bfdbfe;border-radius:6px;padding:8px 10px;background:#eff6ff;font-size:11px">
      <div style="font-size:9px;font-weight:800;color:#1d4ed8;margin-bottom:4px;text-transform:uppercase">견적유효기간</div>
      <strong>${doc.validUntil ? fmtDate(doc.validUntil) : `-`}</strong>
    </div>
  </div>

  ${renderItemTable(itemRows, supply, tax, total)}
  ${renderTaxAmountSummary(doc, supply, tax, total)}

  <div class="info-grid no-break">
    ${renderBankInfo(doc.bank)}
    <div class="info-box guide">
      <h4>안내 사항</h4>
      <p>· 발행 구분: <strong>${esc(TAX_DOC_LABEL[taxDocType] ?? taxDocType)}</strong> / <strong>${esc(TAX_CAT_LABEL[taxCat] ?? taxCat)}</strong><br/>
         ${renderTaxGuideText(doc)}<br/>
         · 계약 체결 후 착수금 선납 시 작업이 시작됩니다.<br/>
         · 문의: ${esc(doc.platform.email ?? doc.platform.phone ?? "담당자에게 연락바랍니다")}</p>
    </div>
  </div>

  ${doc.notes ? `<div class="notes-box no-break"><h4>비고</h4><p>${esc(doc.notes)}</p></div>` : ""}
  ${renderSignatureAndFooter(doc.platform)}`;

  const slug = companyFileSlug(doc.company, showDivision);
  return baseHtml(`${slug ? slug + "_" : ""}B2B견적서_${doc.docNumber}`, body);
}

/** 선입금 차감 견적서 */
export function buildPrepaidDeductionQuoteHtml(doc: QuoteDoc): string {
  const { itemRows, supply, tax, total } = calcItemData(doc);

  const before = doc.prepaidBalanceBefore ?? 0;
  const usage = doc.prepaidUsageAmount ?? total;
  const after = doc.prepaidBalanceAfter ?? (before - usage);

  // 거래 유형 한글 레이블
  const txTypeLabel = (t: string) => t === "deposit" ? "입금" : t === "deduction" ? "차감" : "조정";
  const txTypeColor = (t: string) => t === "deposit" ? "#166534" : t === "deduction" ? "#7c3aed" : "#374151";

  // 누적 차감 내역 테이블 렌더링
  const ledgerTableHtml = (doc.ledgerHistory && doc.ledgerHistory.length > 0) ? `
  <div style="margin-bottom:12px;border:1px solid #d8b4fe;border-radius:8px;overflow:hidden">
    <div style="background:#6d28d9;color:#fff;padding:6px 14px;font-size:10px;font-weight:800;letter-spacing:.6px;text-transform:uppercase">선입금 거래 내역 (누적)</div>
    <table style="width:100%;border-collapse:collapse;font-size:10px">
      <thead>
        <tr style="background:#f5f3ff">
          <th style="padding:5px 8px;text-align:center;border-bottom:1px solid #e2e8f0;font-weight:700;color:#4b5563;width:80px">날짜</th>
          <th style="padding:5px 8px;text-align:center;border-bottom:1px solid #e2e8f0;font-weight:700;color:#4b5563;width:48px">구분</th>
          <th style="padding:5px 8px;text-align:left;border-bottom:1px solid #e2e8f0;font-weight:700;color:#4b5563">내용 / 프로젝트</th>
          <th style="padding:5px 8px;text-align:right;border-bottom:1px solid #e2e8f0;font-weight:700;color:#4b5563;width:90px">금액</th>
          <th style="padding:5px 8px;text-align:right;border-bottom:1px solid #e2e8f0;font-weight:700;color:#4b5563;width:90px">잔액</th>
        </tr>
      </thead>
      <tbody>
        ${doc.ledgerHistory.map((tx, idx) => {
          const dateStr = tx.transactionDate ? tx.transactionDate.slice(0, 10) : (tx.createdAt ? tx.createdAt.slice(0, 10) : "-");
          const desc = tx.projectTitle ? `${tx.projectTitle}${tx.description ? " · " + tx.description : ""}` : (tx.description || "-");
          const amtSign = tx.type === "deposit" ? "+" : tx.type === "deduction" ? "-" : "±";
          const rowBg = idx % 2 === 0 ? "#fff" : "#faf5ff";
          return `<tr style="background:${rowBg}">
            <td style="padding:5px 8px;text-align:center;border-bottom:1px solid #f0e7ff;color:#6b7280">${esc(dateStr)}</td>
            <td style="padding:5px 8px;text-align:center;border-bottom:1px solid #f0e7ff;font-weight:700;color:${txTypeColor(tx.type)}">${txTypeLabel(tx.type)}</td>
            <td style="padding:5px 8px;text-align:left;border-bottom:1px solid #f0e7ff;color:#374151">${esc(desc)}</td>
            <td style="padding:5px 8px;text-align:right;border-bottom:1px solid #f0e7ff;font-weight:700;color:${txTypeColor(tx.type)}">${amtSign}${fmt(tx.amount)}</td>
            <td style="padding:5px 8px;text-align:right;border-bottom:1px solid #f0e7ff;color:${tx.balanceAfter < 0 ? "#dc2626" : "#374151"}">${fmt(tx.balanceAfter)}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  </div>` : "";

  const body = `
  ${renderDocHeader(doc, "선입금 차감 견적서", "PREPAID DEDUCTION QUOTATION",
    `<span style="display:inline-block;padding:2px 9px;border-radius:4px;font-size:11px;font-weight:700;background:#fdf4ff;color:#7c3aed;border:1px solid #d8b4fe">선입금 차감</span>`
  )}

  <div class="party-grid no-break">
    ${renderSender(doc.platform)}
    ${renderReceiver(doc.company, doc.contact, true)}
  </div>

  ${renderProjectBar(doc)}

  <!-- 선입금 잔액 현황 (이번 거래 요약) -->
  <div style="margin-bottom:12px;border:1px solid #d8b4fe;border-radius:8px;overflow:hidden">
    <div style="background:#7c3aed;color:#fff;padding:6px 14px;font-size:10px;font-weight:800;letter-spacing:.6px;text-transform:uppercase">이번 차감 내역</div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;text-align:center;font-size:12px">
      <div style="padding:12px;border-right:1px solid #e2e8f0">
        <div style="font-size:9px;color:#6b7280;margin-bottom:4px">차감 전 잔액</div>
        <strong style="font-size:14px;color:#374151">${fmt(before)}</strong>
      </div>
      <div style="padding:12px;border-right:1px solid #e2e8f0;background:#fdf4ff">
        <div style="font-size:9px;color:#7c3aed;margin-bottom:4px">이번 사용 예정금액</div>
        <strong style="font-size:14px;color:#7c3aed">- ${fmt(usage)}</strong>
      </div>
      <div style="padding:12px;background:#f5f3ff">
        <div style="font-size:9px;color:#6b7280;margin-bottom:4px">차감 후 잔액</div>
        <strong style="font-size:14px;color:${after < 0 ? "#dc2626" : "#166534"}">${fmt(after)}</strong>
      </div>
    </div>
  </div>

  <!-- 누적 차감 거래 내역 테이블 -->
  ${ledgerTableHtml}

  ${renderItemTable(itemRows, supply, tax, total)}
  ${renderTaxAmountSummary(doc, supply, tax, total, "차감 금액")}

  ${after < 0 ? `
  <div style="margin-top:8px;padding:8px 12px;background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;font-size:11px;color:#dc2626">
    ⚠ 잔액 부족: 차감 후 잔액이 음수(-${fmt(Math.abs(after))})입니다. 선입금 충전 또는 별도 결제가 필요합니다.
  </div>` : ""}

  <div class="info-grid no-break">
    ${renderBankInfo(doc.bank)}
    <div class="info-box guide">
      <h4>안내 사항</h4>
      <p>· 본 견적서는 고객 선입금 잔액에서 차감하는 방식으로 처리됩니다.<br/>
         ${renderTaxGuideText(doc)}<br/>
         · 선입금 잔액 부족 시 별도 입금이 필요합니다.<br/>
         · 잔액 충전 문의: ${esc(doc.platform.email ?? doc.platform.phone ?? "담당자에게 연락바랍니다")}</p>
    </div>
  </div>

  ${doc.notes ? `<div class="notes-box no-break"><h4>비고</h4><p>${esc(doc.notes)}</p></div>` : ""}
  ${renderSignatureAndFooter(doc.platform)}`;

  const slug = companyFileSlug(doc.company, true);
  return baseHtml(`${slug ? slug + "_" : ""}선입금차감견적서_${doc.docNumber}`, body);
}

/** 누적 견적서 */
export function buildAccumulatedBatchQuoteHtml(doc: QuoteDoc): string {
  const { itemRows, supply, tax, total } = calcItemData(doc);

  const body = `
  ${renderDocHeader(doc, "누 적 견 적 서", "ACCUMULATED BATCH QUOTATION",
    `<span style="display:inline-block;padding:2px 9px;border-radius:4px;font-size:11px;font-weight:700;background:#ecfdf5;color:#065f46;border:1px solid #6ee7b7">누적 견적</span>`
  )}

  <div class="party-grid no-break">
    ${renderSender(doc.platform)}
    ${renderReceiver(doc.company, doc.contact, true)}
  </div>

  ${renderProjectBar(doc)}

  <!-- 대상 기간 / 건수 -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
    <div style="border:1px solid #6ee7b7;border-radius:6px;padding:10px 12px;background:#ecfdf5;font-size:11px">
      <div style="font-size:9px;font-weight:800;color:#065f46;margin-bottom:5px;text-transform:uppercase">청구 대상 기간</div>
      <strong>
        ${doc.batchPeriodStart ? fmtDate(doc.batchPeriodStart) : "—"}
        ~ ${doc.batchPeriodEnd ? fmtDate(doc.batchPeriodEnd) : "—"}
      </strong>
    </div>
    <div style="border:1px solid #6ee7b7;border-radius:6px;padding:10px 12px;background:#ecfdf5;font-size:11px">
      <div style="font-size:9px;font-weight:800;color:#065f46;margin-bottom:5px;text-transform:uppercase">누적 건수</div>
      <strong>${doc.batchItemCount != null ? `${doc.batchItemCount.toLocaleString("ko-KR")}건` : "—"}</strong>
    </div>
  </div>

  ${renderItemTable(itemRows, supply, tax, total)}
  ${renderTaxAmountSummary(doc, supply, tax, total, "합계 청구금액")}

  <div class="info-grid no-break">
    ${renderBankInfo(doc.bank)}
    <div class="info-box guide">
      <h4>안내 사항</h4>
      <p>· 본 견적서는 ${doc.batchPeriodStart ? fmtDate(doc.batchPeriodStart) : ""} ~ ${doc.batchPeriodEnd ? fmtDate(doc.batchPeriodEnd) : ""} 기간의 누적 의뢰 건을 일괄 청구합니다.<br/>
         ${renderTaxGuideText(doc)}<br/>
         · 세금계산서는 별도 일정에 따라 발행됩니다.<br/>
         · 문의: ${esc(doc.platform.email ?? doc.platform.phone ?? "담당자에게 연락바랍니다")}</p>
    </div>
  </div>

  ${doc.notes ? `<div class="notes-box no-break"><h4>비고</h4><p>${esc(doc.notes)}</p></div>` : ""}
  ${renderSignatureAndFooter(doc.platform)}`;

  const slug = companyFileSlug(doc.company, true);
  return baseHtml(`${slug ? slug + "_" : ""}누적견적서_${doc.docNumber}`, body);
}

// ── 견적서 진입점 (유형별 분기) ───────────────────────────────────────────────

export function buildQuoteHtml(doc: QuoteDoc): string {
  const qt = doc.quoteType ?? "b2b_standard";
  if (qt === "b2c_prepaid")       return buildB2CPrepaidQuoteHtml(doc);
  if (qt === "prepaid_deduction") return buildPrepaidDeductionQuoteHtml(doc);
  if (qt === "accumulated_batch") return buildAccumulatedBatchQuoteHtml(doc);
  return buildB2BStandardQuoteHtml(doc);   // b2b_standard (기본값)
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
    ${renderReceiver(doc.company, doc.contact, true)}
  </div>

  <!-- 프로젝트 정보 -->
  <div style="font-size:12px;color:#374151;margin-bottom:12px;padding:8px 12px;background:#f8fafc;border-radius:6px;border-left:3px solid #1e3a8a">
    <strong>프로젝트:</strong> ${esc(doc.projectTitle)}
    ${doc.customerEmail ? ` &nbsp;|&nbsp; <strong>담당자:</strong> ${esc(doc.customerEmail)}` : ""}
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

  const slug = companyFileSlug(doc.company, true);
  return baseHtml(`${slug ? slug + "_" : ""}거래명세서_${doc.docNumber}`, body);
}
