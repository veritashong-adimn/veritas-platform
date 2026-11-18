// ─────────────────────────────────────────────────────────────────────────────
// 과거 CRM 차감견적서 AI 불러오기 — 기존 차감견적서·선입금 원장 구조 재사용(신규 테이블 없음).
//  1) POST /admin/quotes/legacy-deduction/analyze — PDF 업로드 → 전체 페이지 AI 분석 → 편집 화면 채울 값 반환.
//     원본 PDF는 기존 R2 저장소(legacy-deduction/<sha256>.pdf)에 보관. DB 는 쓰지 않는다(저장 전 미반영).
//  2) POST /admin/quotes/:id/legacy-restore — 견적 저장 후 호출. 분석·원본 정보를 견적 이력(logs)에 기록하고
//     이 견적의 예약 선입/차감을 확정(기존 confirmApprovedQuoteReservations + 중복 검사). 중복 의심이면 409 로 사용자 선택.
//  3) GET  /admin/quotes/:id/legacy-restore(/file) — 재조회 시 원본·분석 내용 표시 / 원본 PDF 열람.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import multer from "multer";
import { createHash } from "node:crypto";
import { db, logsTable, prepaidLedgerTable, quotesTable } from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { requireAuth, requireRole, requireStaffPermission } from "../middlewares/auth";
import { extractText } from "../lib/textExtractor";
import { uploadToR2, getR2ObjectBuffer, isR2Configured } from "../lib/r2";
import { logEvent } from "../lib/logEvent";
import { confirmApprovedQuoteReservations, isPrepaidDeductionQuoteType } from "../services/prepaidDeductionQuote";

const router = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const LOG_ACTION = "legacy_deduction_restore";

type AiDeposit = {
  date: string | null;            // 실제 입금일 — PDF에 '입금일'로 명시된 경우만(발행일과 구분)
  invoiceDate?: string | null;    // 세금계산서 등 발행일(보존용, 입금일로 쓰지 않음)
  amount: number;                 // 입금액(부가세 포함) — 선입금 원장 반영 금액
  supplyAmount?: number | null;   // PDF 표에 인쇄된 공급가액(원본 대조용)
  grossSource?: "note" | "printed" | "estimated";   // 입금액 근거: 비고의 '부가세포함 N원' / 인쇄값 / 공급가×1.1 추정(확인 필요)
  note?: string | null; page?: number | null;
};
type AiItem = {
  date: string | null; fileName?: string | null; service: string; serviceType?: string | null;
  quantity?: number | null; unit?: string | null; unitPrice?: number | null; amount: number; note?: string | null; page?: number | null;
  productId?: number | null; productName?: string | null;   // 언어쌍으로 연결한 기존 상품(확인 가능한 경우만)
};
export type LegacyAnalysis = {
  companyName: string | null; contactName: string | null; quoteDate: string | null; title?: string | null;
  vatMode: "excluded" | "included" | "unknown";
  deposits: AiDeposit[]; items: AiItem[];
  totals: { supply: number | null; vat: number | null; total: number | null; remainingBalance: number | null };
  warnings: string[];
};

const n = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const x = Number(String(v).replace(/[,원\s￦₩]/g, ""));
  return Number.isFinite(x) ? x : null;
};
const isoDate = (v: unknown): string | null => {
  const m = String(v ?? "").match(/(\d{4})[.\-/년\s]+(\d{1,2})[.\-/월\s]+(\d{1,2})/);
  if (!m) return null;
  const d = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return Number.isNaN(Date.parse(d)) ? null : d;
};
const normName = (s: string) => s.replace(/\(주\)|㈜|주식회사|\s|\(|\)/g, "").toLowerCase();
// 비고의 '부가세포함 1900만원' / '부가세 포함 19,000,000원' → 19000000
function grossFromNote(note?: string | null): number | null {
  const m = String(note ?? "").replace(/\s/g, "").match(/부가세포함([\d,.]+)(만)?원?/);
  if (!m) return null;
  const v = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(v) && v > 0 ? Math.round(m[2] ? v * 10000 : v) : null;
}
const PER_PAGE_NOTE = /1\s*장\s*(250\s*단어|700\s*자)/;   // 1장 250단어 / 700자 기준 산정 → 단위 '장'
const DEPOSIT_ROW = /선입금|선수금|예치금/;

function normalizeAnalysis(raw: any): LegacyAnalysis {
  const vm = String(raw?.vatMode ?? "").toLowerCase();
  const items: AiItem[] = (Array.isArray(raw?.items) ? raw.items : []).map((it: any) => ({
    date: isoDate(it?.date), fileName: it?.fileName ?? null, service: String(it?.service ?? "").trim() || "차감 항목",
    serviceType: it?.serviceType ?? null, quantity: n(it?.quantity), unit: it?.unit ?? null, unitPrice: n(it?.unitPrice),
    amount: n(it?.amount) ?? 0, note: it?.note ?? null, page: n(it?.page),
  }));
  const rawDeps: any[] = Array.isArray(raw?.deposits) ? raw.deposits : [];
  // 표 안의 선입금 행이 차감 항목으로 들어온 경우 선입금으로 분리(차감과 중복 계산 방지)
  for (const it of items.filter(x => DEPOSIT_ROW.test(`${x.service} ${x.fileName ?? ""}`))) {
    rawDeps.push({ date: it.date, amount: it.amount, note: it.note, page: it.page });
  }
  const deposits: AiDeposit[] = rawDeps.map((d: any) => {
    const printed = Math.abs(n(d?.amount) ?? 0);
    const g = n(d?.grossAmount) ?? grossFromNote(d?.note);
    const vatInc = d?.vatIncluded === true;
    const amount = g ?? (vatInc ? printed : Math.round(printed * 1.1));
    const noteStr = String(d?.note ?? "");
    const invoiceDate = isoDate(d?.issueDate) ?? (/발행/.test(noteStr) ? isoDate(noteStr) : null);
    const paid = isoDate(d?.paidDate) ?? (/입금/.test(noteStr) && !/발행/.test(noteStr) ? isoDate(noteStr) : null);
    return {
      date: paid && paid !== invoiceDate ? paid : null, invoiceDate, amount, supplyAmount: g != null || !vatInc ? printed : null,
      grossSource: g != null ? "note" : vatInc ? "printed" : "estimated", note: d?.note ?? null, page: n(d?.page),
    } as AiDeposit;
  }).filter((d: AiDeposit) => d.amount > 0);
  return {
    companyName: raw?.companyName ? String(raw.companyName).trim() : null,
    contactName: raw?.contactName ? String(raw.contactName).trim() : null,
    quoteDate: isoDate(raw?.quoteDate),
    title: raw?.title ? String(raw.title).trim() : null,
    vatMode: vm === "excluded" || vm === "included" ? vm : "unknown",
    deposits,
    // 단위: PDF 비고가 '1장 250단어/700자 기준'이면 '장'. 그 외 PDF에 없는 단위는 비움.
    items: items.filter(x => !DEPOSIT_ROW.test(`${x.service} ${x.fileName ?? ""}`))
      .map(x => ({ ...x, unit: x.unit || (PER_PAGE_NOTE.test(`${x.note ?? ""}`) ? "장" : null) })),
    totals: {
      supply: n(raw?.totals?.supply), vat: n(raw?.totals?.vat), total: n(raw?.totals?.total), remainingBalance: n(raw?.totals?.remainingBalance),
    },
    warnings: (Array.isArray(raw?.warnings) ? raw.warnings : []).map(String).filter(Boolean),
  };
}

// 언어쌍(영한·한영·불한·일한·독한·중한 …) → 기존 번역 상품 연결. 서비스명·비고에서 한 가지 언어쌍만 확인될 때만.
const LANG: Record<string, string> = { 한: "ko", 영: "en", 불: "fr", 일: "ja", 독: "de", 중: "zh", 러: "ru", 서: "es", 베: "vi", 태: "th", 몽: "mn" };
export async function linkProducts(a: LegacyAnalysis): Promise<void> {
  const prods = (await db.execute(sql`SELECT id, name, source_language AS s, target_language AS t, unit FROM products
    WHERE product_type = 'translation' AND active = true AND source_language IS NOT NULL AND target_language IS NOT NULL`)).rows as any[];
  const pick = (s: string, t: string) => {
    const c = prods.filter(p => p.s === s || (s === "zh" && String(p.s).startsWith("zh"))).filter(p => p.t === t || (t === "zh" && String(p.t).startsWith("zh")));
    const pages = c.filter(p => p.unit === "페이지");
    return pages.length === 1 ? pages[0] : c.length === 1 ? c[0] : null;
  };
  for (const it of a.items) {
    const pairs = new Set([...`${it.service} ${it.note ?? ""}`.matchAll(/([한영불일독중러서베태몽])([한영불일독중러서베태몽])\s*(?:전문)?번역/g)].map(m => `${LANG[m[1]]}>${LANG[m[2]]}`));
    if (pairs.size !== 1) continue;
    const [s, t] = [...pairs][0].split(">");
    const p = pick(s, t);
    if (p) { it.productId = p.id; it.productName = p.name; }
  }
}

// ─── 기존 차감견적서 구조로 변환(반영안) ─────────────────────────────────────
//  원본 행(analysis)은 그대로 보존하고, 플랫폼 구조(선입금 = 입금 / 차감 사용내역 = 양수 사용액)에 맞춘 반영안을 따로 만든다.
//  · usage   : PDF 합계 = 항목 합계(사용액이 양수인 일반 차감견적서) → 항목 그대로.
//  · balance : PDF 합계 = 선입금 + 항목 합계(양수=충전, 음수=사용인 잔액형 명세) →
//              양수 행(+ 바로 뒤 절사 행)은 입금 1건(부가세 포함), 음수 행은 사용액(부호만 플랫폼 기준으로 반전).
//  금액 계산·원장 규칙은 기존 그대로(예외 없음). PDF 합계를 잔액으로 확정하지 않는다(원장이 입금 − 차감으로 계산).
export type PlanDeposit = { amount: number; supplyAmount: number | null; date: string | null; invoiceDate: string | null; estimated: boolean; note: string };
export type PlanItem = AiItem & { memo: string };
export type RestorePlan = { convention: "usage" | "balance" | "unknown"; deposits: PlanDeposit[]; items: PlanItem[] };
const fmt = (x: number) => Math.round(x * 100) / 100 === Math.round(x) ? Math.round(x).toLocaleString("ko-KR") : x.toLocaleString("ko-KR");
const origText = (it: AiItem) => it.quantity != null && it.unitPrice != null ? `${it.service} ${fmt(it.quantity)} × ${fmt(it.unitPrice)} = ${fmt(it.amount)}` : `${it.service} ${fmt(it.amount)}`;
export function buildRestorePlan(a: LegacyAnalysis): RestorePlan {
  const c = calcAnalysisTotals(a);
  const t = a.totals.total;
  const convention: RestorePlan["convention"] =
    t == null ? "unknown" : Math.abs(t - c.itemTotal) < 1 ? "usage" : Math.abs(t - c.total) < 1 ? "balance" : "unknown";
  const depFromAi = (d: AiDeposit): PlanDeposit => ({
    amount: d.amount, supplyAmount: d.supplyAmount ?? null, date: d.date, invoiceDate: d.invoiceDate ?? null, estimated: d.grossSource === "estimated",
    note: [`원본: 선입금 ${fmt(d.supplyAmount ?? d.amount)}`, d.invoiceDate ? `발행일 ${d.invoiceDate}` : "", d.note ?? ""].filter(Boolean).join(" · "),
  });
  const itemMemo = (it: AiItem, orig: boolean) => [orig ? `원본: ${origText(it)}` : "", it.date ? `차감일 ${it.date}` : "", it.note ?? ""].filter(Boolean).join(" · ");
  if (convention !== "balance") {
    return { convention, deposits: a.deposits.map(depFromAi), items: a.items.map(it => ({ ...it, memo: itemMemo(it, false) })) };
  }
  const deposits: PlanDeposit[] = [];
  const items: PlanItem[] = [];
  let cur: AiItem[] | null = null;
  const flush = () => {
    if (!cur) return;
    const supply = Math.round(cur.reduce((s, it) => s + (it.quantity != null && it.unitPrice != null ? it.quantity * it.unitPrice : it.amount), 0));
    const g = cur.map(it => grossFromNote(it.note)).find(v => v != null) ?? null;
    deposits.push({ amount: g ?? Math.round(supply * 1.1), supplyAmount: supply, date: null, invoiceDate: null, estimated: g == null,
      note: [`원본: ${cur.map(origText).join(" / ")}`, ...cur.map(it => it.note ?? "")].filter(Boolean).join(" · ") });
    cur = null;
  };
  for (const it of a.items) {
    if (it.amount > 0) { flush(); cur = [it]; continue; }
    if (cur && /절사/.test(it.service)) { cur.push(it); continue; }   // 충전 행 바로 뒤 절사는 그 입금에 포함
    flush();
    items.push({ ...it, unitPrice: it.unitPrice != null ? Math.abs(it.unitPrice) : null, amount: Math.abs(it.amount),
      quantity: it.quantity != null ? Math.abs(it.quantity) : null, memo: itemMemo(it, true) });
  }
  flush();
  return { convention, deposits: [...deposits, ...a.deposits.map(depFromAi)], items };
}

// 원본 대조 — 차감내역(항목별 수량×단가, 항목별 부가세 10% 반올림 = 플랫폼 계산과 동일) + 선입금(공급가·부가세) = PDF 공급가액·부가세·합계
export function calcAnalysisTotals(a: LegacyAnalysis) {
  let itemSupply = 0, itemVat = 0;
  for (const it of a.items) {
    const s = Math.round(it.quantity != null && it.unitPrice != null ? it.quantity * it.unitPrice : it.amount);
    itemSupply += s; itemVat += Math.round(s * 0.1);
  }
  const depositTotal = a.deposits.reduce((s, d) => s + d.amount, 0);
  const depositSupply = a.deposits.reduce((s, d) => s + (d.supplyAmount ?? Math.round(d.amount / 1.1)), 0);
  return {
    itemSupply, itemVat, itemTotal: itemSupply + itemVat, depositTotal, depositSupply, depositVat: depositTotal - depositSupply,
    supply: itemSupply + depositSupply, vat: itemVat + depositTotal - depositSupply, total: itemSupply + itemVat + depositTotal,
  };
}
export function checkAnalysis(a: LegacyAnalysis): string[] {
  const flags: string[] = [];
  const won = (x: number) => `${Math.round(x).toLocaleString("ko-KR")}원`;
  const near = (x: number, y: number) => Math.abs(x - y) < 1;
  if (!a.companyName) flags.push("거래처를 PDF에서 확인하지 못했습니다.");
  if (!a.quoteDate) flags.push("견적일을 PDF에서 확인하지 못했습니다.");
  a.deposits.forEach((d, i) => {
    if (d.grossSource === "estimated") flags.push(`선입금 ${i + 1}: PDF에 부가세 포함 입금액이 없어 공급가×1.1(${won(d.amount)})로 추정했습니다 — 실제 입금액을 확인하세요.`);
  });
  a.items.forEach((it, i) => {
    if (it.quantity == null || it.unitPrice == null) flags.push(`차감 ${i + 1}행(${it.service}): PDF에 수량·단가가 없어 1 × 금액으로 입력합니다.`);
    else if (!near(it.quantity * it.unitPrice, it.amount)) flags.push(`차감 ${i + 1}행(${it.service}): 수량×단가(${won(it.quantity * it.unitPrice)})와 금액(${won(it.amount)})이 다릅니다.`);
  });
  const c = calcAnalysisTotals(a);
  const { supply, vat, total } = a.totals;
  const dep = c.depositTotal ? ` = 차감내역 ${won(c.itemTotal)} + 선입금 ${won(c.depositTotal)}` : "";
  if (supply != null && !near(c.supply, supply)) flags.push(`공급가액: PDF ${won(supply)} · 분석 ${won(c.supply)}`);
  if (vat != null && !near(c.vat, vat)) flags.push(`부가세: PDF ${won(vat)} · 분석 ${won(c.vat)}`);
  if (total != null && !near(c.total, total)) flags.push(`합계: PDF ${won(total)} · 분석 ${won(c.total)}${dep}`);
  return [...a.warnings, ...flags];
}

export async function analyzeWithAi(text: string, images: string[]): Promise<LegacyAnalysis> {
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!apiKey) throw new Error("AI 설정(OPENAI)이 없습니다.");
  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI({ apiKey, baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL });
  const system = `당신은 한국 번역·통역 회사의 과거 '차감견적서'(선입금 차감 내역서) PDF를 표 그대로 옮기는 분석가입니다.
규칙:
1. 모든 페이지의 선입금(입금)·차감(서비스 사용)·절사/할인/조정 행을 하나도 빠짐없이 순서대로 옮긴다. 추측·요약·합치기 금지.
2. 날짜는 PDF에 적힌 날짜만 YYYY-MM-DD 로. 없으면 null(절대 만들지 말 것).
3. 수량·단가·금액·부호는 PDF에 인쇄된 그대로 옮긴다(재계산·부가세 환산·부호 변경 금지). 예: 단가가 -35,000 이면 unitPrice=-35000, 금액 -927,500 이면 amount=-927500.
   PDF에 없는 수량·단가·단위·파일명·비고는 null(만들지 말 것). 서비스명(service)과 파일명(fileName)은 각각의 열 값 그대로.
   선입금(입금) 행은 items 가 아니라 deposits 에: amount=표에 인쇄된 금액, grossAmount=비고 등에 적힌 부가세 포함 입금액(없으면 null),
   vatIncluded=인쇄 금액이 부가세 포함이면 true, paidDate=실제 입금일(PDF에 '입금'으로 명시된 경우만, 없으면 null),
   issueDate=세금계산서·청구서 발행일(예: '2025년 9월 19일 발행', 없으면 null), note=비고 원문.
   차감·절사·일반 번역 행은 items 에 PDF 순서·부호 그대로. 서비스 유형 열 값(예: 한영번역, 차감, 절사)은 service 에.
4. vatMode: 차감 항목 금액이 공급가액(부가세 별도)이면 "excluded", 부가세 포함 금액이면 "included", 불명확하면 "unknown"(기록용 — 금액은 바꾸지 않음).
5. totals 는 PDF에 적힌 공급가액·부가세·합계 그대로(없으면 null). remainingBalance 는 PDF에 '잔액'으로 명시된 값만(합계를 잔액으로 쓰지 말 것, 없으면 null).
6. 읽기 어렵거나 불명확한 값은 warnings 에 페이지와 함께 적는다.
7. serviceType: translation|interpretation|equipment|expense|adjustment 중 하나.
JSON 만 반환:
{"companyName":str|null,"contactName":str|null,"quoteDate":str|null,"title":str|null,"vatMode":"excluded"|"included"|"unknown",
 "deposits":[{"paidDate":str|null,"issueDate":str|null,"amount":num,"grossAmount":num|null,"vatIncluded":bool,"note":str|null,"page":num|null}],
 "items":[{"date":str|null,"fileName":str|null,"service":str,"serviceType":str,"quantity":num|null,"unit":str|null,"unitPrice":num|null,"amount":num,"note":str|null,"page":num|null}],
 "totals":{"supply":num|null,"vat":num|null,"total":num|null,"remainingBalance":num|null},
 "warnings":[str]}`;
  const content: any[] = [{ type: "text", text: `PDF 추출 텍스트(표 구조가 깨졌을 수 있음 — 페이지 이미지를 기준으로 확인):\n${text.slice(0, 40000) || "(텍스트 없음)"}` }];
  images.forEach((url, i) => { content.push({ type: "text", text: `[페이지 ${i + 1}]` }); content.push({ type: "image_url", image_url: { url, detail: "high" } }); });
  const r = await openai.chat.completions.create({
    model: "gpt-4o", temperature: 0, response_format: { type: "json_object" },
    messages: [{ role: "system", content: system }, { role: "user", content }],
  });
  return normalizeAnalysis(JSON.parse(r.choices[0]?.message?.content ?? "{}"));
}

// ─── 1) 분석 ─────────────────────────────────────────────────────────────────
router.post("/admin/quotes/legacy-deduction/analyze", ...adminGuard, upload.single("file"), async (req, res) => {
  const f = req.file;
  if (!f) { res.status(400).json({ error: "PDF 파일을 첨부하세요." }); return; }
  if (!/\.pdf$/i.test(f.originalname) && f.mimetype !== "application/pdf") { res.status(400).json({ error: "PDF 파일만 분석할 수 있습니다." }); return; }
  const fileName = Buffer.from(f.originalname, "latin1").toString("utf8");
  try {
    const sha256 = createHash("sha256").update(f.buffer).digest("hex");
    // 같은 PDF로 이미 복원된 견적(이력) — 중복 복원 방지 안내
    const prior = (await db.execute(sql`SELECT DISTINCT l.entity_id AS quote_id, q.quote_number FROM logs l LEFT JOIN quotes q ON q.id = l.entity_id
      WHERE l.entity_type = 'quote' AND l.action = ${LOG_ACTION} AND l.metadata::jsonb ->> 'sha256' = ${sha256} AND q.deleted_at IS NULL`)).rows as any[];

    const stats = await extractText(f.buffer, "source.pdf", process.env.AI_INTEGRATIONS_OPENAI_API_KEY, process.env.AI_INTEGRATIONS_OPENAI_BASE_URL);
    let images: string[] = [];
    try {
      const { renderPdfPagesAsPng, buildImageDataUrl } = await import("../lib/documentOcr");
      images = (await renderPdfPagesAsPng(f.buffer)).map(b => buildImageDataUrl(b, ".png"));
    } catch (err) { req.log.warn({ err }, "legacy deduction: page render failed — text only"); }
    if (!stats.text.trim() && images.length === 0) { res.status(422).json({ error: "PDF에서 내용을 읽지 못했습니다." }); return; }
    const analysis = await analyzeWithAi(stats.text, images);
    await linkProducts(analysis);
    const flags = checkAnalysis(analysis);
    const plan = buildRestorePlan(analysis);
    if (plan.convention === "balance") flags.push("PDF가 잔액형 명세(양수 = 충전, 음수 = 사용)입니다 — 충전 행은 선입금으로, 음수 행은 차감 사용내역(양수)으로 변환했습니다. 원본 값은 각 행 비고에 보존됩니다.");
    if (plan.convention === "unknown") flags.push("PDF 합계가 차감내역 합계와도, 선입금 + 차감내역과도 맞지 않습니다 — 입금·차감 구분을 확인하세요.");
    plan.deposits.forEach((d, i) => { if (d.estimated) flags.push(`입금 ${i + 1}: 부가세 포함 금액이 PDF에 없어 공급가×1.1(${Math.round(d.amount).toLocaleString("ko-KR")}원)로 추정했습니다 — 실제 입금액을 확인하세요.`); });
    plan.deposits.forEach((d, i) => { if (!d.date) flags.push(`입금 ${i + 1}(${Math.round(d.amount).toLocaleString("ko-KR")}원): 실제 입금일이 PDF에 없습니다${d.invoiceDate ? ` — 발행일 ${d.invoiceDate}는 입금일로 쓰지 않고 비고에 보존` : ""}. 확인된 입금일을 입력해야 원장에 반영됩니다.`); });

    // 거래처·담당자 매칭(이름 정규화 일치 · 별칭 포함) — 1건일 때만 자동 선택, 나머지는 사용자가 선택
    let company: { id: number; name: string } | null = null; let contact: { id: number; name: string } | null = null;
    if (analysis.companyName) {
      const key = normName(analysis.companyName);
      const rows = (await db.execute(sql`SELECT DISTINCT c.id, c.name FROM companies c LEFT JOIN company_aliases a ON a.company_id = c.id
        WHERE lower(regexp_replace(c.name, '\\(주\\)|㈜|주식회사|\\s|\\(|\\)', '', 'g')) = ${key}
           OR lower(regexp_replace(a.alias_name, '\\(주\\)|㈜|주식회사|\\s|\\(|\\)', '', 'g')) = ${key} LIMIT 3`)).rows as any[];
      if (rows.length === 1) company = { id: rows[0].id, name: rows[0].name };
      else if (rows.length > 1) flags.push(`거래처 '${analysis.companyName}' 후보가 여러 개입니다 — 직접 선택하세요.`);
      else flags.push(`거래처 '${analysis.companyName}'가 플랫폼에 없습니다 — 직접 선택하세요.`);
    }
    if (company && analysis.contactName) {
      const rows = (await db.execute(sql`SELECT id, name FROM contacts WHERE company_id = ${company.id} AND replace(name, ' ', '') = ${analysis.contactName.replace(/\s/g, "")} LIMIT 2`)).rows as any[];
      if (rows.length === 1) contact = { id: rows[0].id, name: rows[0].name };
    }

    // 기존 원장과 중복 의심(같은 거래처 · 같은 금액 · 같은 날짜의 확정/예약 선입금) — 표시용. 최종 판단은 저장 시 확정 단계에서 다시 검사.
    const depositMatches: Array<{ index: number; ledgerId: number; status: string; date: string | null; quoteId: number | null }> = [];
    if (company) {
      for (let i = 0; i < analysis.deposits.length; i++) {
        const d = analysis.deposits[i];
        const rows = (await db.execute(sql`SELECT l.id, l.status, l.transaction_date::text AS d, l.quote_id FROM prepaid_ledger l JOIN prepaid_accounts a ON a.id = l.account_id
          WHERE a.company_id = ${company.id} AND l.type IN ('deposit','carryover') AND l.status IN ('confirmed','reserved') AND l.amount = ${String(d.amount)}::numeric
            AND (${d.date}::date IS NULL OR l.transaction_date IS NULL OR abs(l.transaction_date - ${d.date}::date) <= 7)`)).rows as any[];
        for (const r of rows) depositMatches.push({ index: i, ledgerId: r.id, status: r.status, date: r.d, quoteId: r.quote_id });
      }
    }

    let fileKey: string | null = null;
    if (isR2Configured()) {
      fileKey = `legacy-deduction/${sha256}.pdf`;
      await uploadToR2(fileKey, f.buffer, "application/pdf");   // 같은 PDF는 같은 키(중복 보관 없음)
    } else flags.push("파일 저장소(R2)가 설정되지 않아 원본 PDF를 보관하지 못합니다.");

    res.json({
      analysis, plan, flags, company, contact, depositMatches,
      priorRestores: prior.map(p => ({ quoteId: p.quote_id, quoteNumber: p.quote_number })),
      source: { fileKey, fileName, sha256, pages: images.length || null },
    });
  } catch (err: any) {
    req.log.error({ err }, "legacy deduction analyze failed");
    res.status(500).json({ error: `AI 분석 실패: ${err?.message ?? "알 수 없는 오류"}` });
  }
});

// ─── 2) 복원 확정 ────────────────────────────────────────────────────────────
//  body: { source:{fileKey,fileName,sha256}, analysis, flags, useExisting?: boolean, allowDuplicate?: boolean }
//   useExisting=true : 중복 의심 선입금은 기존 원장 기록을 사용 — 이 견적의 해당 예약 선입금 행을 제외하고 차감만 확정
//   allowDuplicate=true : 사용자가 중복 아님(신규 복원)을 확인
router.post("/admin/quotes/:id/legacy-restore", ...adminGuard, requireStaffPermission("prepaid.manage"), async (req, res) => {
  const quoteId = Number(req.params.id);
  if (!Number.isInteger(quoteId) || quoteId <= 0) { res.status(400).json({ error: "유효하지 않은 견적 ID" }); return; }
  const body = (req.body ?? {}) as { source?: any; analysis?: any; flags?: string[]; useExisting?: boolean; allowDuplicate?: boolean };
  const user = (req as any).user as { id: number; email: string; role: string } | undefined;
  const [q] = await db.select({ id: quotesTable.id, quoteType: quotesTable.quoteType, price: quotesTable.price }).from(quotesTable).where(eq(quotesTable.id, quoteId));
  if (!q) { res.status(404).json({ error: "견적을 찾을 수 없습니다." }); return; }
  if (!isPrepaidDeductionQuoteType(q.quoteType)) { res.status(409).json({ error: "차감 견적서가 아닙니다." }); return; }
  // 차감내역 합계가 음수면 기존 원장 규칙(차감액 = max(0, 견적금액))으로는 잔액이 틀어진다 → 반영 규칙 확정 전에는 원장에 반영하지 않음.
  if (Number(q.price) < 0) {
    res.status(409).json({ code: "NEGATIVE_TOTAL", error: `차감내역 합계가 음수(${Math.round(Number(q.price)).toLocaleString("ko-KR")}원)라 선입금 원장에 반영하지 않았습니다(견적은 저장됨). 원장 반영 방식 확정 후 다시 저장하세요.` });
    return;
  }
  try {
    const out = await db.transaction(async tx => {
      let excluded: number[] = [];
      if (body.useExisting) {
        // 중복 의심 선입금 → 이 견적의 같은 금액 예약 선입금 행만 제외(기존 원장 기록 사용). 다른 견적·확정 기록은 건드리지 않는다.
        const own = await tx.select().from(prepaidLedgerTable).where(and(eq(prepaidLedgerTable.quoteId, quoteId), eq(prepaidLedgerTable.status, "reserved"), inArray(prepaidLedgerTable.type, ["deposit", "carryover"])));
        for (const r of own) {
          const dup = (await tx.execute(sql`SELECT 1 FROM prepaid_ledger WHERE account_id = ${r.accountId} AND id <> ${r.id} AND quote_id IS DISTINCT FROM ${quoteId}
            AND type IN ('deposit','carryover') AND status IN ('confirmed','reserved') AND amount = ${String(r.amount)}::numeric
            AND (${r.transactionDate}::date IS NULL OR transaction_date IS NULL OR abs(transaction_date - ${r.transactionDate}::date) <= 7) LIMIT 1`)).rows;
          if (dup.length) excluded.push(r.id);
        }
        if (excluded.length) await tx.delete(prepaidLedgerTable).where(inArray(prepaidLedgerTable.id, excluded));
      }
      const r = await confirmApprovedQuoteReservations(tx, quoteId, { allowDuplicate: body.allowDuplicate === true || body.useExisting === true, actorId: user?.id ?? null, legacyRestore: true });
      if (r.result === "duplicate" || r.result === "link_required" || r.result === "not_allowed") {
        if (excluded.length) throw Object.assign(new Error("rollback"), { rollback: r });   // 제외 삭제 되돌림
        return { r, excluded: [] as number[] };
      }
      return { r, excluded };
    }).catch(e => { if (e?.rollback) return { r: e.rollback, excluded: [] as number[] }; throw e; });

    const r = out.r as Awaited<ReturnType<typeof confirmApprovedQuoteReservations>>;
    if (r.result === "not_allowed") { res.status(409).json({ error: r.reason, code: "NOT_CONFIRMABLE" }); return; }
    if (r.result === "link_required" || r.result === "duplicate") {
      res.status(409).json({ error: "기존 선입금·차감 기록과 같은 금액이 있어 반영을 멈췄습니다(기존 기록은 바뀌지 않았습니다).", code: r.result === "duplicate" ? "POSSIBLE_DUPLICATE" : "LINK_REQUIRED", matches: r.matches });
      return;
    }
    // 원본 PDF·AI 분석·사용자 선택을 견적 이력에 남긴다(재조회 시 표시). 사용자 수정값은 견적·항목·선입금 행에 저장돼 있음.
    await logEvent("quote", quoteId, LOG_ACTION, req.log, user ?? undefined, JSON.stringify({
      fileKey: body.source?.fileKey ?? null, fileName: body.source?.fileName ?? null, sha256: body.source?.sha256 ?? null,
      analysis: body.analysis ?? null, flags: Array.isArray(body.flags) ? body.flags : [],
      useExisting: !!body.useExisting, allowDuplicate: !!body.allowDuplicate, excludedLedgerIds: out.excluded,
      result: r.result, ...(r.result === "confirmed" ? { balanceBefore: r.balanceBefore, usageAmount: r.usageAmount, balanceAfter: r.balanceAfter, inflow: r.inflow } : {}),
    }));
    res.json({ ok: true, ...r, excludedLedgerIds: out.excluded });
  } catch (err) {
    req.log.error({ err }, "legacy deduction restore failed");
    res.status(500).json({ error: "과거 차감내역 원장 반영 실패" });
  }
});

// ─── 3) 재조회 ───────────────────────────────────────────────────────────────
async function latestRestore(quoteId: number): Promise<any | null> {
  const [row] = await db.select().from(logsTable)
    .where(and(eq(logsTable.entityType, "quote"), eq(logsTable.entityId, quoteId), eq(logsTable.action, LOG_ACTION)))
    .orderBy(desc(logsTable.id)).limit(1);
  if (!row) return null;
  try { return { ...JSON.parse(row.metadata ?? "{}"), restoredAt: row.createdAt, restoredBy: row.performedByEmail }; } catch { return null; }
}
router.get("/admin/quotes/:id/legacy-restore", ...adminGuard, async (req, res) => {
  const quoteId = Number(req.params.id);
  if (!Number.isInteger(quoteId) || quoteId <= 0) { res.status(400).json({ error: "유효하지 않은 견적 ID" }); return; }
  res.json({ restore: await latestRestore(quoteId) });
});
router.get("/admin/quotes/:id/legacy-restore/file", ...adminGuard, async (req, res) => {
  const meta = await latestRestore(Number(req.params.id));
  const key = meta?.fileKey;
  if (!key || !/^legacy-deduction\/[0-9a-f]{64}\.pdf$/.test(key)) { res.status(404).json({ error: "원본 PDF가 없습니다." }); return; }
  try {
    const { body } = await getR2ObjectBuffer(key);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(meta.fileName ?? "source.pdf")}`);
    res.send(body);
  } catch (err) { req.log.error({ err }, "legacy deduction file read failed"); res.status(404).json({ error: "원본 PDF를 불러오지 못했습니다." }); }
});

export default router;
