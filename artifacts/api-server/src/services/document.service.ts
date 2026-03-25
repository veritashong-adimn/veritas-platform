type CompanyInfo = {
  name: string | null;
  businessNumber?: string | null;
  representativeName?: string | null;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
  industry?: string | null;
} | null;

type ContactInfo = {
  name: string | null;
  department?: string | null;
  position?: string | null;
  email?: string | null;
  phone?: string | null;
} | null;

type QuoteDoc = {
  projectId: number;
  projectTitle: string;
  projectStatus: string;
  issuedAt: string;
  company: CompanyInfo;
  contact: ContactInfo;
  customerEmail?: string | null;
  quoteId?: number | null;
  quoteAmount?: number | null;
  quoteStatus?: string | null;
  quoteCreatedAt?: string | null;
  notes?: string;
};

type StatementDoc = {
  projectId: number;
  projectTitle: string;
  projectStatus: string;
  issuedAt: string;
  company: CompanyInfo;
  contact: ContactInfo;
  customerEmail?: string | null;
  paymentAmount?: number | null;
  paymentDate?: string | null;
  paymentStatus?: string | null;
  totalAmount?: number | null;
  translatorAmount?: number | null;
  platformFee?: number | null;
  notes?: string;
};

const STATUS_KO: Record<string, string> = {
  created: "접수됨", quoted: "견적 발송", approved: "견적 승인됨",
  paid: "결제 완료", matched: "번역사 배정", in_progress: "번역 중",
  completed: "완료", cancelled: "취소됨",
  pending: "대기", sent: "발송", rejected: "거절",
};

const fmt = (n: number | null | undefined) =>
  n != null ? Number(n).toLocaleString("ko-KR") + "원" : "—";

const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" }) : "—";

function baseHtml(title: string, bodyContent: string): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${title}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Apple SD Gothic Neo','Malgun Gothic','맑은 고딕',sans-serif;color:#111;background:#fff;padding:0}
  .page{max-width:780px;margin:0 auto;padding:40px 48px}
  .header{border-bottom:3px solid #1e3a8a;padding-bottom:18px;margin-bottom:28px;display:flex;justify-content:space-between;align-items:flex-end}
  .header-left h1{font-size:28px;font-weight:900;color:#1e3a8a;letter-spacing:-0.5px}
  .header-left p{font-size:13px;color:#6b7280;margin-top:4px}
  .header-right{text-align:right;font-size:12px;color:#6b7280;line-height:1.8}
  .header-right strong{color:#111;font-size:13px}
  .section{margin-bottom:24px}
  .section-title{font-size:12px;font-weight:700;color:#1e3a8a;text-transform:uppercase;letter-spacing:0.8px;padding-bottom:6px;border-bottom:1px solid #e5e7eb;margin-bottom:12px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:6px 32px}
  .field{display:flex;gap:6px;font-size:13px;line-height:1.6;align-items:baseline}
  .field-label{color:#9ca3af;min-width:72px;flex-shrink:0;font-size:12px}
  .field-value{color:#111;font-weight:500}
  .amount-box{background:#f0f7ff;border:1px solid #bfdbfe;border-radius:10px;padding:20px 24px;margin-bottom:24px}
  .amount-box h3{font-size:13px;color:#1e40af;font-weight:700;margin-bottom:10px}
  .amount-row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px dashed #dbeafe}
  .amount-row:last-child{border-bottom:none;padding-top:12px;margin-top:6px}
  .amount-row .label{font-size:13px;color:#374151}
  .amount-row .value{font-size:13px;font-weight:700;color:#1e3a8a}
  .amount-row.total .label{font-size:16px;font-weight:800;color:#111}
  .amount-row.total .value{font-size:20px;font-weight:900;color:#1e3a8a}
  .status-badge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe}
  .notes-box{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:14px 16px;margin-bottom:20px}
  .notes-box p{font-size:13px;color:#78350f;line-height:1.7}
  .footer{margin-top:32px;padding-top:18px;border-top:1px solid #e5e7eb;text-align:center;font-size:11px;color:#9ca3af;line-height:1.8}
  .print-btn{position:fixed;bottom:24px;right:24px;background:#1e3a8a;color:#fff;border:none;border-radius:10px;padding:12px 24px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 14px rgba(30,58,138,0.4);z-index:100}
  @media print{
    .print-btn{display:none}
    body{padding:0}
    .page{padding:20px 28px}
    @page{margin:10mm 12mm;size:A4}
  }
</style>
</head>
<body>
<div class="page">
${bodyContent}
</div>
<button class="print-btn" onclick="window.print()">🖨 인쇄 / PDF 저장</button>
<script>
  setTimeout(()=>{
    if(window.location.hash !== '#noprint') window.print();
  }, 600);
</script>
</body>
</html>`;
}

export function buildQuoteHtml(doc: QuoteDoc): string {
  const issued = fmtDate(doc.issuedAt);
  const co = doc.company;
  const ct = doc.contact;

  const companyBlock = co
    ? `<div class="grid2">
        <div class="field"><span class="field-label">회사명</span><span class="field-value">${co.name ?? "—"}</span></div>
        <div class="field"><span class="field-label">사업자번호</span><span class="field-value">${co.businessNumber ?? "—"}</span></div>
        <div class="field"><span class="field-label">대표자</span><span class="field-value">${co.representativeName ?? "—"}</span></div>
        <div class="field"><span class="field-label">업종</span><span class="field-value">${co.industry ?? "—"}</span></div>
        <div class="field"><span class="field-label">이메일</span><span class="field-value">${co.email ?? "—"}</span></div>
        <div class="field"><span class="field-label">전화</span><span class="field-value">${co.phone ?? "—"}</span></div>
        ${co.address ? `<div class="field" style="grid-column:span 2"><span class="field-label">주소</span><span class="field-value">${co.address}</span></div>` : ""}
      </div>`
    : `<p style="color:#9ca3af;font-size:13px">거래처 정보 없음</p>`;

  const contactBlock = ct
    ? `<div class="grid2">
        <div class="field"><span class="field-label">담당자</span><span class="field-value">${ct.name ?? "—"}</span></div>
        <div class="field"><span class="field-label">부서/직책</span><span class="field-value">${[ct.department, ct.position].filter(Boolean).join(" / ") || "—"}</span></div>
        <div class="field"><span class="field-label">이메일</span><span class="field-value">${ct.email ?? "—"}</span></div>
        <div class="field"><span class="field-label">전화</span><span class="field-value">${ct.phone ?? "—"}</span></div>
      </div>`
    : `<p style="color:#9ca3af;font-size:13px">담당자 정보 없음</p>`;

  const body = `
  <div class="header">
    <div class="header-left">
      <h1>견 적 서</h1>
      <p>QUOTATION</p>
    </div>
    <div class="header-right">
      <div><span class="field-label">발행일</span> <strong>${issued}</strong></div>
      <div><span class="field-label">프로젝트</span> <strong>#${doc.projectId}</strong></div>
      ${doc.quoteId ? `<div><span class="field-label">견적번호</span> <strong>Q-${String(doc.quoteId).padStart(5, "0")}</strong></div>` : ""}
      <div style="margin-top:6px"><span class="status-badge">${STATUS_KO[doc.projectStatus] ?? doc.projectStatus}</span></div>
    </div>
  </div>

  <div class="section">
    <p class="section-title">프로젝트 정보</p>
    <div class="grid2">
      <div class="field"><span class="field-label">프로젝트명</span><span class="field-value">${doc.projectTitle}</span></div>
      <div class="field"><span class="field-label">상태</span><span class="field-value">${STATUS_KO[doc.projectStatus] ?? doc.projectStatus}</span></div>
      ${doc.customerEmail ? `<div class="field"><span class="field-label">고객</span><span class="field-value">${doc.customerEmail}</span></div>` : ""}
    </div>
  </div>

  <div class="section">
    <p class="section-title">수신처 (거래처)</p>
    ${companyBlock}
  </div>

  ${ct ? `<div class="section"><p class="section-title">담당자</p>${contactBlock}</div>` : ""}

  <div class="amount-box">
    <h3>견적 금액</h3>
    ${doc.quoteCreatedAt ? `<div class="amount-row"><span class="label">견적 생성일</span><span class="value">${fmtDate(doc.quoteCreatedAt)}</span></div>` : ""}
    ${doc.quoteStatus ? `<div class="amount-row"><span class="label">견적 상태</span><span class="value">${STATUS_KO[doc.quoteStatus] ?? doc.quoteStatus}</span></div>` : ""}
    <div class="amount-row total">
      <span class="label">견적 총액</span>
      <span class="value">${fmt(doc.quoteAmount)}</span>
    </div>
  </div>

  ${doc.notes ? `<div class="notes-box"><p class="section-title" style="margin-bottom:8px">비고</p><p>${doc.notes}</p></div>` : ""}

  <div class="footer">
    <p>본 견적서는 발행일로부터 30일간 유효합니다.</p>
    <p>문의 사항이 있으시면 담당자에게 연락하시기 바랍니다.</p>
  </div>`;

  return baseHtml(`견적서 — ${doc.projectTitle}`, body);
}

export function buildStatementHtml(doc: StatementDoc): string {
  const issued = fmtDate(doc.issuedAt);
  const co = doc.company;
  const ct = doc.contact;

  const companyBlock = co
    ? `<div class="grid2">
        <div class="field"><span class="field-label">회사명</span><span class="field-value">${co.name ?? "—"}</span></div>
        <div class="field"><span class="field-label">사업자번호</span><span class="field-value">${co.businessNumber ?? "—"}</span></div>
        <div class="field"><span class="field-label">대표자</span><span class="field-value">${co.representativeName ?? "—"}</span></div>
        <div class="field"><span class="field-label">이메일</span><span class="field-value">${co.email ?? "—"}</span></div>
        <div class="field"><span class="field-label">전화</span><span class="field-value">${co.phone ?? "—"}</span></div>
        ${co.address ? `<div class="field" style="grid-column:span 2"><span class="field-label">주소</span><span class="field-value">${co.address}</span></div>` : ""}
      </div>`
    : `<p style="color:#9ca3af;font-size:13px">거래처 정보 없음</p>`;

  const contactBlock = ct
    ? `<div class="grid2">
        <div class="field"><span class="field-label">담당자</span><span class="field-value">${ct.name ?? "—"}</span></div>
        <div class="field"><span class="field-label">부서/직책</span><span class="field-value">${[ct.department, ct.position].filter(Boolean).join(" / ") || "—"}</span></div>
        <div class="field"><span class="field-label">이메일</span><span class="field-value">${ct.email ?? "—"}</span></div>
        <div class="field"><span class="field-label">전화</span><span class="field-value">${ct.phone ?? "—"}</span></div>
      </div>`
    : "";

  const hasPlatformFee = doc.platformFee != null && Number(doc.platformFee) > 0;

  const body = `
  <div class="header">
    <div class="header-left">
      <h1>거 래 명 세 서</h1>
      <p>TRANSACTION STATEMENT</p>
    </div>
    <div class="header-right">
      <div><span class="field-label">발행일</span> <strong>${issued}</strong></div>
      <div><span class="field-label">프로젝트</span> <strong>#${doc.projectId}</strong></div>
      ${doc.paymentDate ? `<div><span class="field-label">결제일</span> <strong>${fmtDate(doc.paymentDate)}</strong></div>` : ""}
      <div style="margin-top:6px"><span class="status-badge">${STATUS_KO[doc.projectStatus] ?? doc.projectStatus}</span></div>
    </div>
  </div>

  <div class="section">
    <p class="section-title">프로젝트 정보</p>
    <div class="grid2">
      <div class="field"><span class="field-label">프로젝트명</span><span class="field-value">${doc.projectTitle}</span></div>
      <div class="field"><span class="field-label">상태</span><span class="field-value">${STATUS_KO[doc.projectStatus] ?? doc.projectStatus}</span></div>
      ${doc.customerEmail ? `<div class="field"><span class="field-label">고객</span><span class="field-value">${doc.customerEmail}</span></div>` : ""}
    </div>
  </div>

  <div class="section">
    <p class="section-title">수신처 (거래처)</p>
    ${companyBlock}
  </div>

  ${ct ? `<div class="section"><p class="section-title">담당자</p>${contactBlock}</div>` : ""}

  <div class="amount-box">
    <h3>거래 금액 내역</h3>
    ${doc.paymentAmount != null ? `<div class="amount-row"><span class="label">결제 금액</span><span class="value">${fmt(doc.paymentAmount)}</span></div>` : ""}
    ${doc.paymentStatus ? `<div class="amount-row"><span class="label">결제 상태</span><span class="value">${STATUS_KO[doc.paymentStatus] ?? doc.paymentStatus}</span></div>` : ""}
    ${doc.translatorAmount != null ? `<div class="amount-row"><span class="label">번역사 지급액</span><span class="value">${fmt(doc.translatorAmount)}</span></div>` : ""}
    ${hasPlatformFee ? `<div class="amount-row"><span class="label">플랫폼 수수료</span><span class="value">${fmt(doc.platformFee)}</span></div>` : ""}
    <div class="amount-row total">
      <span class="label">합계</span>
      <span class="value">${fmt(doc.totalAmount ?? doc.paymentAmount)}</span>
    </div>
  </div>

  ${doc.notes ? `<div class="notes-box"><p class="section-title" style="margin-bottom:8px">비고</p><p>${doc.notes}</p></div>` : ""}

  <div class="footer">
    <p>위 금액을 정히 영수합니다.</p>
    <p>문의 사항이 있으시면 담당자에게 연락하시기 바랍니다.</p>
  </div>`;

  return baseHtml(`거래명세서 — ${doc.projectTitle}`, body);
}
