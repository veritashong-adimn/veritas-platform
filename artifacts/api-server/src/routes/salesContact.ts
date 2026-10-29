// ─── 과거 CRM 판매건 고객 담당자 보완 + 견적 수신자 '담당자 정보 갱신' ─────────────────────────
//   GET  /admin/sales-contact/context          판매건(과거 CRM 미전환 행 / 전환된 운영 판매)의 거래처·현재 담당자·거래처 담당자 목록
//   POST /admin/sales-contact/link             기존 담당자 Master 연결
//   POST /admin/sales-contact/create           담당자 Master 신규 등록 + 연결(같은 거래처 중복 확인)
//   POST /admin/sales-contact/link-related     같은 담당자의 다른 과거 CRM 판매건(관리자가 고른 건만)을 같은 담당자 Master 에 연결
//   POST /admin/quotes/:id/recipient-refresh   견적 수신자 고정값을 현재 담당자 Master 로 갱신(사용자 명시 선택)
//
// 원칙
//   · 과거 CRM 원본(legacy_archive_rows)은 읽기만 한다. 보완 정보는 별도 연결 데이터로 둔다:
//       - 미전환 판매: legacy_master_mappings(old_crm, 'sale_contact', 판매번호 → contacts.id)
//       - 전환된 판매: 운영 판매(projects.contact_id) — 이미 운영 데이터이므로 판매관리·상세·견적이 같은 값을 본다
//   · 담당자는 해당 판매의 거래처 소속만 연결한다. 이름으로 추측하거나 다른 거래처 담당자를 자동 연결하지 않는다.
//   · 판매금액·상품·입금·지급 정보는 건드리지 않는다. 변경 전후는 logs 에 기록한다.
//   · 기존 견적서의 수신자 출력은 담당자 연결 때문에 바뀌지 않는다(연결 직전 고정 — quoteRecipientSnapshot).
import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";
import { matchCompany } from "../services/legacySaleActivation";
import { freezeProjectQuotes, liveRecipientOf } from "../services/quoteRecipientSnapshot";
import { saleContactInfo, personKey, normPhone } from "../services/legacyContactRestore";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];
const performerOf = (req: any) => (req.user ? { id: req.user.id, email: req.user.email } : undefined);
const rows = async (dbx: any, q: any) => ((await dbx.execute(q)).rows as any[]);

class HttpError extends Error { constructor(public status: number, message: string, public extra?: Record<string, unknown>) { super(message); } }

const CONTACT_COLS = sql`c.id, c.company_id "companyId", c.name, c.position, c.department, c.phone, c.mobile, c.office_phone "officePhone", c.email`;

interface SaleRef {
  source: "legacy" | "current";
  id: number;                    // legacy_archive_rows.id | projects.id
  saleNo: string | null;
  rawCompanyName: string | null; // 원본 거래처명(legacy) / 판매 거래처명(current)
  company: { id: number; name: string } | null;
  companyMatch: string;          // name_or_alias | ambiguous | unmatched | contact | project
  contact: any | null;           // 현재 연결된 담당자
  contactSource: "supplement" | "project" | null;
  linkVia?: string | null;       // 연결 방식(manual 보완 / auto_name_phone / auto_samename_phone / project)
}

async function contactById(dbx: any, id: number | null | undefined) {
  if (!id) return null;
  const [c] = await rows(dbx, sql`SELECT ${CONTACT_COLS}, c.deleted_at "deletedAt", c.is_active "isActive" FROM contacts c WHERE c.id = ${id}`);
  return c ?? null;
}
async function companyById(dbx: any, id: number | null | undefined) {
  if (!id) return null;
  const [c] = await rows(dbx, sql`SELECT id, name FROM companies WHERE id = ${id} AND deleted_at IS NULL`);
  return c ? { id: Number(c.id), name: String(c.name) } : null;
}

// 판매건 식별 — 과거 CRM 미전환 행(legacy) 또는 과거 CRM 에서 전환된 운영 판매(current)만 대상
export async function resolveSale(dbx: any, source: string, id: number): Promise<SaleRef> {
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "유효하지 않은 판매 id.");
  if (source === "legacy") {
    const [r] = await rows(dbx, sql`SELECT id, company_name, source_raw->>'판매번호' sale_no FROM legacy_archive_rows
      WHERE id = ${id} AND source_type = 'sales_list' AND is_effective`);
    if (!r) throw new HttpError(404, "과거 CRM 판매건을 찾을 수 없습니다.");
    const saleNo = r.sale_no ? String(r.sale_no) : null;
    if (!saleNo) throw new HttpError(409, "판매번호가 없는 과거 판매건은 담당자를 연결할 수 없습니다.");
    const [act] = await rows(dbx, sql`SELECT entity_id FROM legacy_master_mappings WHERE source_system = 'old_crm' AND entity_type = 'sale' AND status = 'active' AND legacy_id = ${saleNo}`);
    if (act) return resolveSale(dbx, "current", Number(act.entity_id));   // 이미 전환된 판매는 운영 판매 기준
    const [m] = await rows(dbx, sql`SELECT entity_id, match_method FROM legacy_master_mappings WHERE source_system = 'old_crm' AND entity_type = 'sale_contact' AND status = 'active' AND legacy_id = ${saleNo}`);
    const contact = await contactById(dbx, m ? Number(m.entity_id) : null);
    const rawCompanyName = r.company_name ? String(r.company_name) : null;
    // 거래처: 이미 보완 연결된 담당자의 거래처 > 원본 거래처명이 Master 1곳과 일치(정규화·별칭)
    if (contact) return { source: "legacy", id, saleNo, rawCompanyName, company: await companyById(dbx, contact.companyId), companyMatch: "contact", contact, contactSource: "supplement", linkVia: m?.match_method ?? null };
    const cm = await matchCompany(dbx, rawCompanyName);
    return { source: "legacy", id, saleNo, rawCompanyName, company: cm.matchedId ? { id: cm.matchedId, name: cm.matchedName! } : null, companyMatch: cm.method, contact: null, contactSource: null };
  }
  if (source === "current") {
    const [p] = await rows(dbx, sql`SELECT p.id, p.company_id, p.contact_id, p.company_name_snapshot, m.legacy_id sale_no FROM projects p
      JOIN legacy_master_mappings m ON m.entity_id = p.id AND m.source_system = 'old_crm' AND m.entity_type = 'sale' AND m.status = 'active'
      WHERE p.id = ${id}`);
    if (!p) throw new HttpError(404, "과거 CRM 에서 전환된 판매건이 아닙니다.");
    const company = await companyById(dbx, p.company_id ? Number(p.company_id) : null);
    const contact = await contactById(dbx, p.contact_id ? Number(p.contact_id) : null);
    return { source: "current", id: Number(p.id), saleNo: String(p.sale_no), rawCompanyName: p.company_name_snapshot ?? company?.name ?? null,
      company, companyMatch: company ? "project" : "unmatched", contact, contactSource: contact ? "project" : null, linkVia: contact ? "project" : null };
  }
  throw new HttpError(400, "source 는 legacy 또는 current 여야 합니다.");
}

// 연결할 거래처 결정 — 판매에 거래처가 확정돼 있으면 그 거래처만, 확정되지 않았으면(미일치·후보 복수) 사용자가 고른 거래처
function targetCompanyId(sale: SaleRef, requested: unknown): number {
  const req = Number(requested);
  if (sale.company) {
    if (requested != null && req !== sale.company.id) throw new HttpError(409, `이 판매건의 거래처는 '${sale.company.name}'입니다. 다른 거래처의 담당자는 연결할 수 없습니다.`);
    return sale.company.id;
  }
  if (sale.source === "current") throw new HttpError(409, "판매에 거래처가 연결되어 있지 않습니다. 판매 상세에서 거래처를 먼저 연결하세요.");
  if (!Number.isInteger(req) || req <= 0) throw new HttpError(400, "거래처를 먼저 선택하세요(신규 등록·연결 시 거래처 연결 필수).");
  return req;
}

const contactSummary = (c: any) => c ? { id: Number(c.id), name: c.name, position: c.position ?? null, department: c.department ?? null, phone: c.phone ?? null, mobile: c.mobile ?? null, email: c.email ?? null } : null;

// 연결 적용(같은 트랜잭션) — 변경 전후 기록
async function applyLink(tx: any, req: any, sale: SaleRef, contact: any, companyId: number, how: "link" | "create" | "link_related") {
  const before = contactSummary(sale.contact);
  const after = contactSummary(contact);
  if (before?.id === after?.id) return { changed: false, frozenQuotes: [] as number[] };
  let frozenQuotes: number[] = [];
  if (sale.source === "legacy") {
    await tx.execute(sql`INSERT INTO legacy_master_mappings (source_system, entity_type, legacy_id, entity_id, match_method, status, created_by)
      VALUES ('old_crm', 'sale_contact', ${sale.saleNo}, ${contact.id}, 'manual', 'active', ${req.user?.id ?? null})
      ON CONFLICT (source_system, entity_type, legacy_id) DO UPDATE SET entity_id = EXCLUDED.entity_id, status = 'active'`);
    await logEvent("company", companyId, "legacy_sale_contact_linked", req.log, performerOf(req), JSON.stringify({
      saleNo: sale.saleNo, legacyRowId: sale.id, how, before, after }));
  } else {
    // 운영 판매 담당자 변경 — 이 판매의 기존 견적 수신자 출력은 바뀌기 전 값으로 고정(자동 변경 금지)
    frozenQuotes = await freezeProjectQuotes(tx, sale.id);
    await tx.execute(sql`UPDATE projects SET contact_id = ${contact.id}, contact_name_snapshot = ${contact.name} WHERE id = ${sale.id}`);
    await logEvent("project", sale.id, "legacy_sale_contact_linked", req.log, performerOf(req), JSON.stringify({
      saleNo: sale.saleNo, how, before, after, frozenQuoteIds: frozenQuotes }));
  }
  return { changed: true, frozenQuotes };
}

// 같은 거래처의 담당자 등록·연결을 직렬화 — 버튼 반복 클릭·중복 요청이 동시에 중복 검사를 통과해 2명이 생기지 않도록
export const lockCompany = (tx: any, companyId: number) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`sales-contact:${companyId}`}))`);

const inList = (vals: string[]) => sql.join(vals.map(v => sql`${v}`), sql`, `);

// 기준 판매의 담당자 식별값 — 복원 고객명(없으면 연결된 Master 이름) + 개인 전화번호(원본 중 공용·대표번호 제외, Master 휴대전화)
export function personOf(sale: SaleRef, info: any): { name: string | null; phones: string[] } {
  const name = info?.restoredName ?? sale.contact?.name ?? null;
  const phones = new Set<string>();
  for (const p of info?.sourcePhones ?? []) if (!p.shared && p.number.length >= 9) phones.add(p.number);
  const m = normPhone(sale.contact?.mobile);
  if (m.length >= 9) phones.add(m);
  return { name, phones: [...phones] };
}

type RelatedStatus = "linkable" | "linked_same" | "linked_other" | "company_mismatch";
// 같은 담당자의 다른 과거 CRM 판매 — ①같은 거래처 ②복원 고객명 일치 ③원본 전화번호 일치(진행관리표에는 이메일 칸이 없다)
//   이름만 같은 판매(다른 거래처 동명이인 등)는 후보로 올리지 않는다. 다른 담당자에 연결된 판매는 보여 주되 선택 불가.
export async function relatedSales(dbx: any, base: SaleRef, person: { name: string | null; phones: string[] }, contactId: number | null) {
  if (!base.saleNo || !person.name || !person.phones.length) return [];
  const cands = await rows(dbx, sql`SELECT DISTINCT s.id, s.company_name, s.source_raw->>'판매번호' sale_no, s.source_raw->>'세금계산서발행(예정)일' "date",
      s.source_raw->>'상품명' product, s.source_raw->>'총액' total
    FROM legacy_archive_rows s JOIN legacy_sales_progress_links l ON l.sale_row_id = s.id AND l.decision = 'confirmed'
    JOIN legacy_archive_rows p ON p.id = l.progress_row_id AND p.is_effective
    WHERE s.source_type = 'sales_list' AND s.is_effective AND s.source_raw->>'판매번호' IS NOT NULL AND s.source_raw->>'판매번호' <> ${base.saleNo}
      AND regexp_replace(coalesce(p.source_raw->>'연락처', ''), '[^0-9]', '', 'g') IN (${inList(person.phones)})`);
  const out: Array<{ legacyRowId: number; saleNo: string; date: string | null; product: string | null; total: string | null; rawCompanyName: string | null; status: RelatedStatus; currentContact: { id: number; name: string } | null }> = [];
  for (const c of cands) {
    const saleNo = String(c.sale_no);
    const info = await saleContactInfo(dbx, saleNo, { companyId: base.company?.id ?? null, companyName: c.company_name ?? null, linkedContactId: null, linkVia: null });
    if (!info.restoredName || personKey(info.restoredName) !== personKey(person.name)) continue;
    if (!info.sourcePhones.some((p: any) => person.phones.includes(p.number))) continue;
    const sale = await resolveSale(dbx, "legacy", Number(c.id));
    const cur = sale.contact ? { id: Number(sale.contact.id), name: String(sale.contact.name) } : null;
    const status: RelatedStatus = !base.company || sale.company?.id !== base.company.id ? "company_mismatch"
      : !cur ? "linkable" : cur.id === contactId ? "linked_same" : "linked_other";
    out.push({ legacyRowId: Number(c.id), saleNo, date: c.date ?? null, product: c.product ?? null, total: c.total ?? null, rawCompanyName: c.company_name ?? null, status, currentContact: cur });
  }
  return out.sort((a, b) => a.saleNo.localeCompare(b.saleNo));
}

// 전체 담당자 Master 중복 후보(다른 거래처) — 같은 전화번호·이메일 또는 같은 이름. 소속 확인용 표시만 하고 연결·이전은 하지 않는다.
export async function otherCompanyCandidates(dbx: any, companyId: number | null, person: { name: string | null; phones: string[] }, emails: string[]) {
  const conds = [];
  if (person.phones.length) conds.push(sql`regexp_replace(coalesce(c.mobile, ''), '[^0-9]', '', 'g') IN (${inList(person.phones)})
    OR regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') IN (${inList(person.phones)})
    OR regexp_replace(coalesce(c.office_phone, ''), '[^0-9]', '', 'g') IN (${inList(person.phones)})`);
  if (emails.length) conds.push(sql`lower(c.email) IN (${inList(emails)})`);
  if (person.name) conds.push(sql`regexp_replace(lower(c.name), '\s', '', 'g') = ${person.name.replace(/\s/g, "").toLowerCase()}`);
  if (!conds.length) return [];
  const found = await rows(dbx, sql`SELECT ${CONTACT_COLS}, co.name "companyName" FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
    WHERE c.deleted_at IS NULL AND c.company_id IS DISTINCT FROM ${companyId} AND (${sql.join(conds, sql` OR `)}) ORDER BY c.id LIMIT 20`);
  return found.map(c => {
    const nums = [c.mobile, c.phone, c.officePhone].map(normPhone);
    const matchedBy = [
      ...(person.name && personKey(c.name) === personKey(person.name) ? ["name"] : []),
      ...(person.phones.some(p => nums.includes(p)) ? ["phone"] : []),
      ...(c.email && emails.includes(String(c.email).toLowerCase()) ? ["email"] : []),
    ];
    return { ...contactSummary(c), companyId: c.companyId ? Number(c.companyId) : null, companyName: c.companyName ?? null, matchedBy };
  }).filter(c => c.matchedBy.length);
}

// 연결 일시 — 마지막 연결 감사 로그(없으면 자동 복원 매핑 생성 시각)
async function linkedAtOf(dbx: any, sale: SaleRef): Promise<{ at: string; by: string | null } | null> {
  if (!sale.contact || !sale.saleNo) return null;
  const [l] = await rows(dbx, sql`SELECT created_at, performed_by_email FROM logs WHERE action = 'legacy_sale_contact_linked'
    AND metadata LIKE ${`%"saleNo":${JSON.stringify(sale.saleNo)}%`} ORDER BY id DESC LIMIT 1`);
  if (l) return { at: new Date(l.created_at).toISOString(), by: l.performed_by_email ?? null };
  if (sale.source !== "legacy") return null;
  const [m] = await rows(dbx, sql`SELECT created_at FROM legacy_master_mappings WHERE source_system = 'old_crm' AND entity_type = 'sale_contact' AND status = 'active' AND legacy_id = ${sale.saleNo}`);
  return m ? { at: new Date(m.created_at).toISOString(), by: null } : null;
}

function sendError(res: any, req: any, err: any, fallback: string) {
  if (err instanceof HttpError) { res.status(err.status).json({ error: err.message, ...(err.extra ?? {}) }); return; }
  req.log.error({ err }, fallback);
  res.status(500).json({ error: fallback });
}

router.get("/admin/sales-contact/context", ...adminGuard, async (req, res) => {
  try {
    const sale = await resolveSale(db, String(req.query.source ?? ""), Number(req.query.id));
    const contacts = sale.company ? await rows(db, sql`SELECT ${CONTACT_COLS} FROM contacts c
      WHERE c.company_id = ${sale.company.id} AND c.deleted_at IS NULL AND c.is_active ORDER BY c.is_primary DESC, c.name`) : [];
    // 진행관리표 근거(확정 연결된 유효 진행행의 고객명·연락처) — 복원 고객명 확인·신규 등록 시 원본 값만 쓰기 위해
    const evidence = sale.saleNo ? await rows(db, sql`SELECT p.id, p.source_raw->>'체결일' "date", p.source_raw->>'상품명' "product", p.source_raw->>'총액' "total",
        btrim(p.source_raw->>'고객명') "customerName", btrim(p.source_raw->>'연락처') "tel", l.match_method "method"
      FROM legacy_archive_rows s JOIN legacy_sales_progress_links l ON l.sale_row_id = s.id AND l.decision = 'confirmed'
      JOIN legacy_archive_rows p ON p.id = l.progress_row_id AND p.is_effective
      WHERE s.source_type = 'sales_list' AND s.is_effective AND s.source_raw->>'판매번호' = ${sale.saleNo} ORDER BY p.source_row NULLS LAST, p.id`) : [];
    // 연락처(출처 구분): 판매 당시 원본 번호 / 현재 연결된 Master / 연결 후보 — 같은 사람의 정보만 묶는다
    const contactInfo = sale.saleNo ? await saleContactInfo(db, sale.saleNo, { companyId: sale.company?.id ?? null, companyName: sale.rawCompanyName,
      linkedContactId: sale.contact ? Number(sale.contact.id) : null, linkVia: sale.linkVia ?? null }) : null;
    // 같은 담당자의 다른 판매건(연결 대상 미리보기) · 다른 거래처의 중복 후보 · 연결 일시
    const person = personOf(sale, contactInfo);
    const related = await relatedSales(db, sale, person, sale.contact ? Number(sale.contact.id) : null);
    const emails = [...new Set([...(contactInfo?.sourceEmails ?? []), ...(contactInfo?.companyEmail ? [String(contactInfo.companyEmail).toLowerCase()] : [])])];
    const otherCompanyMatches = await otherCompanyCandidates(db, sale.company?.id ?? null, person, emails);
    const linkedAt = await linkedAtOf(db, sale);
    res.json({ ...sale, contact: contactSummary(sale.contact), contacts, evidence, restoredName: contactInfo?.restoredName ?? null, contactInfo,
      relatedSales: related, otherCompanyMatches, linkedAt });
  } catch (err) { sendError(res, req, err, "담당자 정보 조회 실패."); }
});

router.post("/admin/sales-contact/link", ...adminGuard, requirePermission("contact.update"), async (req, res) => {
  const b = req.body ?? {};
  try {
    const out = await db.transaction(async tx => {
      const sale = await resolveSale(tx, String(b.source ?? ""), Number(b.id));
      const companyId = targetCompanyId(sale, b.companyId);
      await lockCompany(tx, companyId);
      const contact = await contactById(tx, Number(b.contactId));
      if (!contact || contact.deletedAt) throw new HttpError(404, "담당자를 찾을 수 없습니다.");
      if (Number(contact.companyId) !== companyId) throw new HttpError(409, "선택한 담당자는 이 판매건의 거래처 소속이 아닙니다.");
      const r = await applyLink(tx, req, sale, contact, companyId, "link");
      return { ...r, contact: contactSummary(contact) };
    });
    res.json(out);
  } catch (err) { sendError(res, req, err, "담당자 연결 실패."); }
});

router.post("/admin/sales-contact/create", ...adminGuard, requirePermission("contact.create"), async (req, res) => {
  const b = req.body ?? {};
  const t = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const name = t(b.name);
  if (!name) { res.status(400).json({ error: "담당자명은 필수입니다." }); return; }
  const email = t(b.email)?.toLowerCase() ?? null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { res.status(400).json({ error: "이메일 형식이 올바르지 않습니다." }); return; }
  const mobile = t(b.mobile)?.replace(/\D/g, "") || null;   // 기존 담당자 등록과 같은 정규화(숫자만)
  try {
    const out = await db.transaction(async tx => {
      const pre = await resolveSale(tx, String(b.source ?? ""), Number(b.id));
      const companyId = targetCompanyId(pre, b.companyId);
      await lockCompany(tx, companyId);
      // 잠금 뒤 다시 읽는다 — 앞선 요청(반복 클릭)이 이미 등록·연결했다면 그 결과를 보고 중복 등록하지 않는다
      const sale = await resolveSale(tx, String(b.source ?? ""), Number(b.id));
      if (sale.contact && personKey(sale.contact.name) === personKey(name)) throw new HttpError(409, `이 판매건은 이미 '${sale.contact.name}' 담당자에 연결되어 있습니다.`, { code: "ALREADY_LINKED", existing: [contactSummary(sale.contact)] });
      if (!(await companyById(tx, companyId))) throw new HttpError(404, "거래처를 찾을 수 없습니다.");
      // 같은 거래처 중복 방지
      //   · 같은 이름 + 같은 휴대전화·이메일 → 같은 사람으로 보고 신규 등록하지 않음(기존 담당자 선택)
      //   · 같은 이름만 → 동명이인 확인 후에만 등록
      //   · 다른 이름이 같은 이메일·휴대전화를 씀 → 공유 연락처일 수 있어 확인 후 등록(공유 이메일 허용)
      const nk = sql`regexp_replace(lower(c.name), '\\s', '', 'g') = regexp_replace(lower(${name}), '\\s', '', 'g')`;
      const idMatch = sql`((${email}::text IS NOT NULL AND lower(c.email) = ${email}) OR (${mobile}::text IS NOT NULL AND regexp_replace(coalesce(c.mobile, ''), '[^0-9]', '', 'g') = ${mobile}))`;
      const base = sql`c.company_id = ${companyId} AND c.deleted_at IS NULL AND c.is_active`;
      const samePerson = await rows(tx, sql`SELECT ${CONTACT_COLS} FROM contacts c WHERE ${base} AND ${nk} AND ${idMatch}`);
      if (samePerson.length) throw new HttpError(409, "같은 이름·연락처의 담당자가 이미 있습니다. 기존 담당자를 선택하세요.", { code: "IDENTIFIER_MATCH", existing: samePerson });
      const sameName = await rows(tx, sql`SELECT ${CONTACT_COLS} FROM contacts c WHERE ${base} AND ${nk}`);
      if (sameName.length && b.confirmSameName !== true) throw new HttpError(409, "같은 이름의 담당자가 이미 있습니다. 같은 사람이면 기존 담당자를 선택하고, 다른 사람이면 확인 후 등록하세요.", { code: "SAME_NAME", existing: sameName });
      // 이메일 공유는 허용(여러 담당자가 같은 업무 이메일 사용) — 다른 이름이 같은 휴대전화를 쓰는 경우만 확인
      const sharedMobile = mobile ? await rows(tx, sql`SELECT ${CONTACT_COLS} FROM contacts c WHERE ${base} AND regexp_replace(coalesce(c.mobile, ''), '[^0-9]', '', 'g') = ${mobile}`) : [];
      if (sharedMobile.length && b.confirmShared !== true) throw new HttpError(409, "같은 휴대전화를 쓰는 다른 담당자가 있습니다. 같은 번호를 함께 쓰는 것이 맞으면 확인 후 등록하세요.", { code: "SHARED_CONTACT", existing: sharedMobile });
      // 확인된 정보만 저장(이름만 확인된 경우 연락처 없이 등록 — 이 보완 화면 한정)
      const [created] = await rows(tx, sql`INSERT INTO contacts (company_id, name, position, department, phone, mobile, email, memo)
        VALUES (${companyId}, ${name}, ${t(b.position)}, ${t(b.department)}, ${t(b.phone)}, ${mobile}, ${email}, ${`과거 CRM 판매 담당자 보완 등록(판매번호 ${sale.saleNo})`})
        RETURNING id, company_id "companyId", name, position, department, phone, mobile, email`);
      await logEvent("company", companyId, "company_contact_created", req.log, performerOf(req), JSON.stringify({ contactId: created.id, name: created.name, isPrimary: false, via: "legacy_sale_contact", saleNo: sale.saleNo }));
      const r = await applyLink(tx, req, sale, created, companyId, "create");
      return { ...r, contact: contactSummary(created), created: true };
    });
    res.status(201).json(out);
  } catch (err) { sendError(res, req, err, "담당자 등록 실패."); }
});

// 같은 담당자의 다른 과거 판매건 연결 — 기준 판매가 먼저 이 담당자에 연결돼 있어야 하고, 관리자가 고른 판매번호만 처리한다.
//   서버가 대상 목록을 다시 계산해 '연결 가능(linkable)'인 건만 연결한다. 다른 담당자에 연결된 판매·거래처 불일치는 건너뛴다(덮어쓰기 없음).
router.post("/admin/sales-contact/link-related", ...adminGuard, requirePermission("contact.update"), async (req, res) => {
  const b = req.body ?? {};
  const contactId = Number(b.contactId);
  const saleNos: string[] = Array.isArray(b.saleNos) ? [...new Set(b.saleNos.map((v: unknown) => String(v)).filter(Boolean))] as string[] : [];
  if (!saleNos.length) { res.status(400).json({ error: "연결할 판매건을 선택하세요." }); return; }
  if (saleNos.length > 200) { res.status(400).json({ error: "한 번에 200건까지 연결할 수 있습니다." }); return; }
  try {
    const out = await db.transaction(async tx => {
      const base = await resolveSale(tx, String(b.source ?? ""), Number(b.id));
      if (!base.company) throw new HttpError(409, "기준 판매건의 거래처가 확정되지 않았습니다.");
      await lockCompany(tx, base.company.id);
      if (!base.contact || Number(base.contact.id) !== contactId) throw new HttpError(409, "기준 판매건이 이 담당자에 연결되어 있지 않습니다. 화면을 새로고침하세요.");
      const contact = await contactById(tx, contactId);
      if (!contact || contact.deletedAt || Number(contact.companyId) !== base.company.id) throw new HttpError(409, "담당자가 이 거래처 소속이 아닙니다.");
      const info = await saleContactInfo(tx, base.saleNo!, { companyId: base.company.id, companyName: base.rawCompanyName, linkedContactId: contactId, linkVia: base.linkVia ?? null });
      const related = new Map((await relatedSales(tx, base, personOf(base, info), contactId)).map(r => [r.saleNo, r]));
      const linked: string[] = []; const skipped: Array<{ saleNo: string; reason: string }> = [];
      for (const no of saleNos) {
        const r = related.get(no);
        if (!r) { skipped.push({ saleNo: no, reason: "not_related" }); continue; }
        if (r.status !== "linkable") { skipped.push({ saleNo: no, reason: r.status }); continue; }
        const sale = await resolveSale(tx, "legacy", r.legacyRowId);
        if (sale.contact) { skipped.push({ saleNo: no, reason: "linked_other" }); continue; }
        await applyLink(tx, req, sale, contact, base.company.id, "link_related");
        linked.push(no);
      }
      await logEvent("company", base.company.id, "legacy_sale_contact_related_linked", req.log, performerOf(req), JSON.stringify({
        baseSaleNo: base.saleNo, contactId, requested: saleNos, linked, skipped }));
      return { linked, skipped, contact: contactSummary(contact) };
    });
    res.json(out);
  } catch (err) { sendError(res, req, err, "관련 판매건 연결 실패."); }
});

// 견적 수신자 '담당자 정보 갱신' — 사용자가 명시적으로 선택한 경우에만 현재 Master 값으로 고정값을 바꾼다
router.post("/admin/quotes/:id/recipient-refresh", ...adminGuard, requirePermission("quote.update"), async (req, res) => {
  const quoteId = Number(req.params.id);
  if (!Number.isInteger(quoteId) || quoteId <= 0) { res.status(400).json({ error: "유효하지 않은 quote id." }); return; }
  try {
    const [q] = await rows(db, sql`SELECT id, customer_company_name "customerCompanyName", customer_contact_name "customerContactName", customer_contact_position "customerContactPosition",
      customer_contact_department "customerContactDepartment", customer_contact_phone "customerContactPhone", customer_contact_mobile "customerContactMobile", customer_contact_email "customerContactEmail"
      FROM quotes WHERE id = ${quoteId} AND deleted_at IS NULL`);
    if (!q) { res.status(404).json({ error: "견적을 찾을 수 없습니다." }); return; }
    const { id: _id, ...before } = q;
    const live = await liveRecipientOf(db, quoteId);
    // 같은 사람(담당자명 동일)이면 현재 Master 에 없는 항목은 기존 고정값을 지우지 않는다(판매 당시 원본 연락처 보존).
    //  다른 사람으로 바뀐 경우에는 이전 사람의 연락처가 섞이지 않도록 현재 Master 값으로 전부 바꾼다.
    const same = !!live?.customerContactName && String(live.customerContactName).replace(/\s/g, "") === String(before.customerContactName ?? "").replace(/\s/g, "");
    const after: Record<string, string | null> = {};
    for (const k of Object.keys(before)) after[k] = (live as any)?.[k] ?? (same ? (before as any)[k] : null);
    await db.execute(sql`UPDATE quotes SET customer_company_name = ${after.customerCompanyName}, customer_contact_name = ${after.customerContactName},
      customer_contact_position = ${after.customerContactPosition}, customer_contact_department = ${after.customerContactDepartment},
      customer_contact_phone = ${after.customerContactPhone}, customer_contact_mobile = ${after.customerContactMobile}, customer_contact_email = ${after.customerContactEmail}
      WHERE id = ${quoteId}`);
    await logEvent("quote", quoteId, "quote_recipient_refreshed", req.log, performerOf(req), JSON.stringify({ before, after }));
    res.json({ ok: true, before, after });
  } catch (err) { sendError(res, req, err, "담당자 정보 갱신 실패."); }
});

export default router;
