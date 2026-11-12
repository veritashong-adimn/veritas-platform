// ─── 판매관리 '미연결 관리' — 과거 CRM 판매의 거래처·담당자 미연결 통합관리 ─────────────────────────────
//   GET  /admin/legacy-party/summary            상태별 건수(실제 DB 연결 상태 기준, 판매 1건 = 1상태 — 중복 없음)
//   GET  /admin/legacy-party/list               검색·필터·페이지네이션
//   GET  /admin/legacy-party/company-contacts   거래처 담당자 목록 + 원본 고객과 비교 + 다른 거래처 동명이인 경고
//   POST /admin/legacy-party/link-company       기존 거래처 연결(단건·일괄)
//   POST /admin/legacy-party/create-company     신규 거래처·개인고객 등록 후 연결(중복 확인)
//   POST /admin/legacy-party/link-contact       같은 거래처 담당자를 여러 판매에 연결(일괄)
//
// 원칙(기존 구조 재사용 — 스키마 변경 없음)
//   · 상태 판정은 공통 연결 로직 planPartyLinks(services/legacyPartyLink) 결과를 그대로 쓴다. 자동 연결은 하지 않는다 — 직원이 실행할 때만 변경.
//   · 과거 CRM 미전환 판매의 거래처 = company_aliases(원본 거래처 표기 → 거래처). 같은 표기의 판매는 함께 연결된다(화면에서 대상 판매를 모두 보여 준다).
//     운영 전환 판매 = projects.company_id(비어 있을 때만) — 기존 견적 수신자 출력은 바꾸기 전 값으로 고정(freezeProjectQuotes).
//   · 담당자 연결은 판매관리 담당자 보완(salesContact)의 resolveSale·applyLink 를 재사용한다. 이미 담당자가 연결된 판매는 덮어쓰지 않고 건너뛴다.
//   · 판매·견적·품목·수행·청구·입금·지급·정산·과거 CRM 원본은 읽지도 바꾸지도 않는다(거래처·담당자 참조만).
//   · 일괄 처리는 판매별 SAVEPOINT — 실패한 건은 다른 건에 영향 없이 보류. 재실행해도 중복 생성 없음(별칭·연결 고유키, 기존 연결 건너뜀).
//   · 변경 전후 ID·작업자·시각은 logs 와 import_row_sources(module=legacy_party_link) 에 남긴다.
import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth";
import { normalizeCompanyName as N } from "../lib/normalizeCompany";
import { planPartyLinks, individualNameOf, PARTY_LINK_MODULE, type PartyLinkRow } from "../services/legacyPartyLink";
import { personKey, normPhone } from "../services/legacyContactRestore";
import { freezeProjectQuotes } from "../services/quoteRecipientSnapshot";
import { resolveSale, applyLink, lockCompany } from "./salesContact";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];
const rows = async (dbx: any, q: any) => ((await dbx.execute(q)).rows as any[]);
class HttpError extends Error { constructor(public status: number, message: string, public extra?: Record<string, unknown>) { super(message); } }
const sendError = (res: any, req: any, err: any, fallback: string) => {
  if (err instanceof HttpError) { res.status(err.status).json({ error: err.message, ...(err.extra ?? {}) }); return; }
  req.log?.error?.({ err }, fallback); res.status(500).json({ error: fallback });
};
const performer = (req: any) => ({ id: req.user?.id ?? null, email: req.user?.email ?? null });

// ── 상태(판매 1건당 1개) ─────────────────────────────────────────────────────
export type ManageStatus = "company_missing" | "contact_missing" | "contact_conflict" | "name_check" | "individual_review" | "linked";
export const STATUS_LABEL: Record<ManageStatus, string> = {
  company_missing: "거래처 미등록", contact_missing: "거래처만 연결 · 담당자 미연결", contact_conflict: "담당자 식별정보 충돌",
  name_check: "동일 이름·연락처 확인 필요", individual_review: "개인고객 확인 필요", linked: "연결 완료",
};
// 특별 확인(관리자 지정) — 표시만, 자동 변경 없음
export const WATCH: Record<string, { note: string; status?: ManageStatus }> = {
  "2018-11-30-0001": { note: "개인고객 이현정 — 원본 연락처 없음, 이름만으로 인식됨(동일인 확인 필요)", status: "individual_review" },
  "2018-11-28-0033": { note: "개인고객 이현정 — 원본 연락처 없음, 이름만으로 인식됨(동일인 확인 필요)", status: "individual_review" },
  "2026-11-09-0005": { note: "한국보건복지인재원 김하나 — 담당자 연결 상태 확인" },
  "2026-11-09-0001": { note: "고제이슨 — 개인고객 거래처 연결 상태 확인" },
};
const YK = "법무법인YK (법무법인 와이케이)";

export interface ManageRow {
  key: string; source: "legacy" | "current" | "platform"; saleNo: string | null; saleRowId: number | null; projectId: number | null;
  saleDate: string | null; product: string | null; total: number | null; rawCompany: string | null;
  company: { id: number | null; name: string | null; brn: string | null; customerType: string | null; via: string | null };
  customerName: string | null; sourcePhones: string[]; sourceEmail: string | null;
  contact: { id: number; name: string; check: string } | null; proposal: PartyLinkRow["proposal"];
  status: ManageStatus; detail: string; watchNote: string | null; sameRawCount: number; editable: boolean;
}

let cache: { at: number; rows: ManageRow[] } | null = null;
const TTL = 120_000;
export const invalidateManageCache = () => { cache = null; };

export async function buildRows(dbx: any): Promise<ManageRow[]> {
  const plan = await planPartyLinks(dbx);
  const cos = new Map((await rows(dbx, sql`SELECT id, name, business_number, customer_type, phone, mobile FROM companies WHERE deleted_at IS NULL`)).map(c => [Number(c.id), c]));
  const projOf = new Map((await rows(dbx, sql`SELECT m.legacy_id, m.entity_id FROM legacy_master_mappings m WHERE m.source_system='old_crm' AND m.entity_type='sale' AND m.status='active'`)).map(r => [String(r.legacy_id), Number(r.entity_id)]));
  const rawCount = new Map<string, number>(); for (const r of plan) { const k = N(r.rawCompany ?? ""); rawCount.set(k, (rawCount.get(k) ?? 0) + 1); }
  const out: ManageRow[] = [];
  for (const r of plan) {
    const co = r.company.id ? cos.get(r.company.id) : null;
    let status: ManageStatus =
      r.category === "A" ? "linked" : r.category === "B" ? "name_check" : r.category === "C" ? "contact_missing" : r.category === "G" ? "contact_conflict" : "company_missing";
    // 개인고객: 거래처 미등록 중 개인고객 표기 / 연결됐으나 원본 연락처로 확인되지 않는 개인고객(Master 에 번호가 있는데 원본과 일치하지 않음)
    if (status === "company_missing" && (individualNameOf(r.rawCompany) || /^(개인|개인고객|개인 고객)$/.test(String(r.rawCompany ?? "").trim()))) status = "individual_review";
    if (status === "linked" && co?.customer_type === "INDIVIDUAL") {
      const coTels = [co.phone, co.mobile].map(normPhone).filter((t: string) => t.length >= 9);
      if (coTels.length && !r.sourcePhones.some(t => coTels.includes(t))) status = "individual_review";
    }
    const w = r.saleNo ? WATCH[r.saleNo] : undefined;
    if (w?.status) status = w.status;
    const watchNote = w?.note ?? (r.rawCompany === YK ? "법무법인YK — 원본 고객 담당자(강예린) Master 미등록, 연결 여부 확인" : null);
    out.push({ key: `L${r.saleRowId}`, source: r.converted ? "current" : "legacy", saleNo: r.saleNo, saleRowId: r.saleRowId, projectId: r.saleNo ? projOf.get(r.saleNo) ?? null : null,
      saleDate: r.saleDate, product: r.product, total: r.total, rawCompany: r.rawCompany,
      company: { id: r.company.id, name: r.company.name, brn: co?.business_number ?? null, customerType: co?.customer_type ?? null, via: r.company.via },
      customerName: r.customerName, sourcePhones: r.sourcePhones, sourceEmail: r.sourceEmail,
      contact: r.linked ? { id: r.linked.contactId, name: r.linked.name, check: r.linked.check } : null, proposal: r.proposal,
      status, detail: r.detail, watchNote, sameRawCount: rawCount.get(N(r.rawCompany ?? "")) ?? 1, editable: status !== "linked" || !!watchNote });
  }
  // 플랫폼 신규 판매 — 거래처·담당자가 비어 있는 것만(정상 연결 건은 제외). 수정은 판매상세에서(여기서는 조회만).
  for (const p of await rows(dbx, sql`SELECT p.id, p.title, p.company_id, p.contact_id, p.company_name_snapshot, p.contact_name_snapshot, p.created_at,
      (SELECT q.price FROM quotes q WHERE q.project_id = p.id AND q.deleted_at IS NULL ORDER BY q.is_current DESC, q.id DESC LIMIT 1) price,
      (SELECT to_char(q.issue_date,'YYYY-MM-DD') FROM quotes q WHERE q.project_id = p.id AND q.deleted_at IS NULL ORDER BY q.is_current DESC, q.id DESC LIMIT 1) issue
    FROM projects p WHERE p.status <> 'cancelled' AND NOT EXISTS (SELECT 1 FROM legacy_master_mappings m WHERE m.entity_type='sale' AND m.status='active' AND m.entity_id = p.id)
      AND (p.company_id IS NULL OR (p.contact_id IS NULL AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = p.company_id AND c.customer_type = 'INDIVIDUAL')))`)) {
    const co = p.company_id ? cos.get(Number(p.company_id)) : null;
    out.push({ key: `P${p.id}`, source: "platform", saleNo: null, saleRowId: null, projectId: Number(p.id), saleDate: p.issue ?? null, product: p.title, total: p.price != null ? Number(p.price) : null,
      rawCompany: p.company_name_snapshot ?? co?.name ?? null, company: { id: p.company_id ? Number(p.company_id) : null, name: co?.name ?? null, brn: co?.business_number ?? null, customerType: co?.customer_type ?? null, via: p.company_id ? "project" : null },
      customerName: p.contact_name_snapshot ?? null, sourcePhones: [], sourceEmail: null, contact: null, proposal: null,
      status: p.company_id ? "contact_missing" : "company_missing", detail: "플랫폼 판매 — 판매상세에서 거래처·담당자 지정", watchNote: null, sameRawCount: 1, editable: false });
  }
  return out;
}
async function getRows(force = false) {
  if (!force && cache && Date.now() - cache.at < TTL) return cache.rows;
  const r = await buildRows(db); cache = { at: Date.now(), rows: r }; return r;
}

router.get("/admin/legacy-party/summary", ...adminGuard, async (req, res) => {
  try {
    const all = await getRows(req.query.refresh === "1");
    const count = (src?: string) => Object.fromEntries((Object.keys(STATUS_LABEL) as ManageStatus[]).map(s => [s, all.filter(r => r.status === s && (!src || r.source === src)).length]));
    res.json({ total: all.length, legacyTotal: all.filter(r => r.source !== "platform").length, byStatus: count(), legacyByStatus: Object.fromEntries((Object.keys(STATUS_LABEL) as ManageStatus[]).map(s => [s, all.filter(r => r.status === s && r.source !== "platform").length])),
      platformByStatus: count("platform"), watch: all.filter(r => r.watchNote).length, labels: STATUS_LABEL, builtAt: cache?.at ?? null });
  } catch (err) { sendError(res, req, err, "미연결 현황 조회 실패."); }
});

router.get("/admin/legacy-party/list", ...adminGuard, async (req, res) => {
  try {
    const qy = req.query as Record<string, string | undefined>;
    const t = (v?: string) => (v ?? "").trim().toLowerCase();
    const company = t(qy.company), contact = t(qy.contact), email = t(qy.email), saleNo = t(qy.saleNo), phone = (qy.phone ?? "").replace(/\D/g, "");
    const from = qy.from ?? "", to = qy.to ?? "", status = qy.status ?? "", rawExact = qy.raw ?? null;
    let list = await getRows(qy.refresh === "1");
    if (status === "watch") list = list.filter(r => r.watchNote);
    else if (status === "unlinked") list = list.filter(r => r.status !== "linked");
    else if (status) list = list.filter(r => r.status === status);
    if (rawExact != null) list = list.filter(r => N(r.rawCompany ?? "") === N(rawExact) && r.source !== "platform");
    if (company) list = list.filter(r => [r.rawCompany, r.company.name].some(v => (v ?? "").toLowerCase().includes(company)));
    if (contact) list = list.filter(r => [r.customerName, r.contact?.name].some(v => (v ?? "").toLowerCase().includes(contact)));
    if (phone) list = list.filter(r => r.sourcePhones.some(p => p.includes(phone)));
    if (email) list = list.filter(r => (r.sourceEmail ?? "").includes(email));
    if (saleNo) list = list.filter(r => (r.saleNo ?? "").toLowerCase().includes(saleNo));
    if (from) list = list.filter(r => (r.saleDate ?? "") >= from);
    if (to) list = list.filter(r => (r.saleDate ?? "") && (r.saleDate ?? "") <= to);
    list = [...list].sort((a, b) => (b.saleDate ?? "").localeCompare(a.saleDate ?? ""));
    const pageSize = [20, 50, 100].includes(Number(qy.pageSize)) ? Number(qy.pageSize) : 50;
    const total = list.length, totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, Number(qy.page) || 1), totalPages);
    res.json({ rows: list.slice((page - 1) * pageSize, page * pageSize), pagination: { page, pageSize, total, totalPages } });
  } catch (err) { sendError(res, req, err, "미연결 목록 조회 실패."); }
});

// 거래처 담당자 + 원본 고객 비교 + 다른 거래처 동명이인 경고
router.get("/admin/legacy-party/company-contacts", ...adminGuard, async (req, res) => {
  try {
    const companyId = Number(req.query.companyId);
    const names = String(req.query.names ?? "").split(",").map(s => s.trim()).filter(Boolean);
    if (!Number.isInteger(companyId) || companyId <= 0) throw new HttpError(400, "거래처를 선택하세요.");
    const [co] = await rows(db, sql`SELECT id, name, business_number "businessNumber", customer_type "customerType", phone, mobile, email, representative_name "representativeName" FROM companies WHERE id = ${companyId} AND deleted_at IS NULL`);
    if (!co) throw new HttpError(404, "거래처를 찾을 수 없습니다.");
    const contacts = await rows(db, sql`SELECT id, name, position, department, phone, mobile, office_phone "officePhone", email FROM contacts WHERE company_id = ${companyId} AND deleted_at IS NULL AND is_active ORDER BY name`);
    const keys = names.map(personKey).filter(Boolean);
    const others = keys.length ? (await rows(db, sql`SELECT c.id, c.name, c.mobile, c.phone, c.office_phone "officePhone", c.email, co.name "companyName", co.id "companyId" FROM contacts c JOIN companies co ON co.id = c.company_id AND co.deleted_at IS NULL
      WHERE c.deleted_at IS NULL AND c.company_id <> ${companyId}`)).filter(c => keys.includes(personKey(c.name))) : [];
    res.json({ company: co, contacts, otherCompanySameName: others.slice(0, 30) });
  } catch (err) { sendError(res, req, err, "담당자 조회 실패."); }
});

// ── 거래처 연결(단건·일괄) ─────────────────────────────────────────────────────
async function newBatch(tx: any, type: string, userId: number | null, note: string) {
  const [b] = await rows(tx, sql`INSERT INTO import_batches (module, import_type, original_filename, total_rows, success_rows, status, created_by, source_system, is_current)
    VALUES (${PARTY_LINK_MODULE}, ${type}, ${note}, 0, 0, 'completed', ${userId}, 'old_crm', false) RETURNING id`);
  return Number(b.id);
}
async function lineage(tx: any, batchId: number, entityId: number, rowKey: string, status: string, legacyId: string | null, raw: unknown) {
  await tx.execute(sql`INSERT INTO import_row_sources (batch_id, module, entity_id, row_key, status, source_system, legacy_id, source_raw)
    VALUES (${batchId}, ${PARTY_LINK_MODULE}, ${entityId}, ${rowKey}, ${status}, 'old_crm', ${legacyId}, ${JSON.stringify(raw)}::jsonb)`);
}
type ItemResult = { saleNo: string; ok: boolean; result: string; message?: string; affectedSaleNos?: string[] };

/** 판매번호들을 거래처에 연결(같은 트랜잭션 · 판매별 SAVEPOINT). 과거 CRM 미전환 = 원본 표기 별칭, 전환 = projects.company_id(비어 있을 때만) */
async function linkSalesToCompany(tx: any, req: any, companyId: number, saleNos: string[], batchId: number, how: string): Promise<ItemResult[]> {
  const [co] = await rows(tx, sql`SELECT id, name, deleted_at FROM companies WHERE id = ${companyId}`);
  if (!co || co.deleted_at) throw new HttpError(404, "거래처를 찾을 수 없습니다.");
  const plan = new Map((await planPartyLinks(tx, { saleNos })).map(r => [String(r.saleNo), r]));
  const results: ItemResult[] = []; const doneRaw = new Set<string>();
  for (const saleNo of saleNos) {
    const r = plan.get(saleNo);
    if (!r) { results.push({ saleNo, ok: false, result: "not_found", message: "과거 CRM 판매를 찾을 수 없습니다." }); continue; }
    try {
      await tx.transaction(async (sp: any) => {
        if (r.converted) {
          const [pj] = await rows(sp, sql`SELECT p.id, p.company_id FROM projects p JOIN legacy_master_mappings m ON m.entity_id = p.id AND m.entity_type='sale' AND m.status='active' WHERE m.legacy_id = ${saleNo} FOR UPDATE OF p`);
          if (!pj) throw new HttpError(404, "운영 판매를 찾을 수 없습니다.");
          if (pj.company_id && Number(pj.company_id) === companyId) { results.push({ saleNo, ok: true, result: "already" }); return; }
          if (pj.company_id) throw new HttpError(409, "이미 다른 거래처가 연결된 운영 판매입니다(기존 연결 변경 안 함).");
          const frozen = await freezeProjectQuotes(sp, Number(pj.id));
          await sp.execute(sql`UPDATE projects SET company_id = ${companyId} WHERE id = ${pj.id}`);
          await lineage(sp, batchId, Number(pj.id), `project:${pj.id}`, "project_linked", saleNo, { before: { companyId: null }, after: { companyId }, how, frozenQuotes: frozen, by: performer(req), at: new Date().toISOString() });
          await sp.execute(sql`INSERT INTO logs (entity_type, entity_id, action, performed_by, performed_by_email, metadata) VALUES ('project', ${pj.id}, 'legacy_sale_company_linked', ${req.user?.id ?? null}, ${req.user?.email ?? null},
            ${JSON.stringify({ saleNo, before: { companyId: null }, after: { companyId, companyName: co.name }, how, batchId, frozenQuotes: frozen })})`);
          results.push({ saleNo, ok: true, result: "linked_project" });
          return;
        }
        const raw = String(r.rawCompany ?? "").trim();
        if (!raw) throw new HttpError(409, "원본 거래처명이 없는 판매는 거래처 표기로 연결할 수 없습니다.");
        if (r.company.id && r.company.id === companyId) { results.push({ saleNo, ok: true, result: "already" }); return; }
        if (r.company.id) throw new HttpError(409, `이미 다른 거래처(${r.company.name})로 인식되는 표기입니다(기존 연결 변경 안 함).`);
        const k = N(raw);
        if (doneRaw.has(k)) { results.push({ saleNo, ok: true, result: "linked_with_same_name" }); return; }
        const hits = await rows(sp, sql`SELECT DISTINCT a.company_id FROM company_aliases a JOIN companies c ON c.id = a.company_id AND c.deleted_at IS NULL WHERE a.normalized_alias = ${k}`);
        if (hits.some(h => Number(h.company_id) !== companyId)) throw new HttpError(409, "같은 표기가 다른 거래처 별칭으로 이미 등록되어 있습니다.");
        const [a] = await rows(sp, sql`INSERT INTO company_aliases (company_id, alias_name, normalized_alias, is_primary) VALUES (${companyId}, ${raw}, ${k}, false)
          ON CONFLICT (company_id, normalized_alias) DO NOTHING RETURNING id`);
        doneRaw.add(k);
        // 같은 원본 표기의 판매 전체(별칭으로 함께 연결됨)
        const same = (await rows(sp, sql`SELECT source_raw->>'판매번호' s, company_name FROM legacy_archive_rows WHERE source_type='sales_list' AND is_effective AND company_name ILIKE ${"%" + raw.replace(/[%_\\]/g, "") + "%"}`))
          .filter(x => N(x.company_name ?? "") === k).map(x => String(x.s));
        if (a) {
          await lineage(sp, batchId, Number(a.id), `alias:${a.id}`, "alias_added", saleNo, { companyId, alias: raw, how, before: { companyId: null }, after: { companyId }, saleNos: same, by: performer(req), at: new Date().toISOString() });
          await sp.execute(sql`INSERT INTO logs (entity_type, entity_id, action, performed_by, performed_by_email, metadata) VALUES ('company', ${companyId}, 'legacy_sale_company_linked', ${req.user?.id ?? null}, ${req.user?.email ?? null},
            ${JSON.stringify({ alias: raw, aliasId: Number(a.id), saleNos: same, before: { companyId: null }, after: { companyId, companyName: co.name }, how, batchId })})`);
        }
        results.push({ saleNo, ok: true, result: "linked", affectedSaleNos: same });
      });
    } catch (e: any) { results.push({ saleNo, ok: false, result: "failed", message: e instanceof HttpError ? e.message : "처리 중 오류" }); }
  }
  return results;
}

const saleNosOf = (b: any): string[] => (Array.isArray(b?.saleNos) ? [...new Set(b.saleNos.map((s: unknown) => String(s).trim()).filter(Boolean))] as string[] : []);

router.post("/admin/legacy-party/link-company", ...adminGuard, requirePermission("company.update"), async (req, res) => {
  const b = req.body ?? {}; const saleNos = saleNosOf(b); const companyId = Number(b.companyId);
  if (!saleNos.length) { res.status(400).json({ error: "연결할 판매를 선택하세요." }); return; }
  if (saleNos.length > 300) { res.status(400).json({ error: "한 번에 300건까지 처리할 수 있습니다." }); return; }
  if (!Number.isInteger(companyId) || companyId <= 0) { res.status(400).json({ error: "거래처를 선택하세요." }); return; }
  try {
    const out = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${PARTY_LINK_MODULE}))`);
      const batchId = await newBatch(tx, "manual_company_link", req.user?.id ?? null, `판매관리 미연결 관리 — 거래처 연결 #${companyId}`);
      const results = await linkSalesToCompany(tx, req, companyId, saleNos, batchId, "link");
      return { batchId, results };
    });
    invalidateManageCache();
    res.json({ ...out, success: out.results.filter(r => r.ok).length, failed: out.results.filter(r => !r.ok).length });
  } catch (err) { sendError(res, req, err, "거래처 연결 실패."); }
});

router.post("/admin/legacy-party/create-company", ...adminGuard, requirePermission("company.create"), async (req, res) => {
  const b = req.body ?? {}; const saleNos = saleNosOf(b);
  const t = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const name = t(b.name); const customerType = b.customerType === "INDIVIDUAL" ? "INDIVIDUAL" : "CORPORATE";
  const brn = t(b.businessNumber)?.replace(/[^0-9-]/g, "") || null; const phone = t(b.phone); const mobile = t(b.mobile); const email = t(b.email)?.toLowerCase() ?? null;
  if (!name) { res.status(400).json({ error: "거래처명을 입력하세요." }); return; }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { res.status(400).json({ error: "이메일 형식이 올바르지 않습니다." }); return; }
  if (!saleNos.length) { res.status(400).json({ error: "연결할 판매를 선택하세요." }); return; }
  try {
    const out = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${PARTY_LINK_MODULE}))`);
      // 중복 확인 — 사업자번호 같으면 등록 불가, 이름·별칭·연락처 같으면 확인 후에만
      const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");
      if (brn) {
        const same = await rows(tx, sql`SELECT id, name FROM companies WHERE deleted_at IS NULL AND regexp_replace(coalesce(business_number,''),'[^0-9]','','g') = ${digits(brn)}`);
        if (same.length) throw new HttpError(409, "같은 사업자등록번호의 거래처가 이미 있습니다. 기존 거래처에 연결하세요.", { code: "BRN_EXISTS", duplicates: same });
      }
      const key = N(name);
      const byName = await rows(tx, sql`SELECT DISTINCT c.id, c.name, c.customer_type "customerType", c.business_number "businessNumber" FROM companies c JOIN company_aliases a ON a.company_id = c.id
        WHERE c.deleted_at IS NULL AND a.normalized_alias = ${key}`);
      const nameHits = (await rows(tx, sql`SELECT id, name, customer_type "customerType", business_number "businessNumber" FROM companies WHERE deleted_at IS NULL`)).filter(c => N(c.name) === key);
      const tels = [phone, mobile].map(normPhone).filter(x => x.length >= 9);
      const telHits = tels.length ? await rows(tx, sql`SELECT id, name FROM companies WHERE deleted_at IS NULL AND (regexp_replace(coalesce(phone,''),'[^0-9]','','g') = ANY(${sql.raw(`ARRAY[${tels.map(x => `'${x}'`).join(",")}]::text[]`)})
        OR regexp_replace(coalesce(mobile,''),'[^0-9]','','g') = ANY(${sql.raw(`ARRAY[${tels.map(x => `'${x}'`).join(",")}]::text[]`)}))`) : [];
      const dups = [...new Map([...byName, ...nameHits, ...telHits].map(c => [Number(c.id), c])).values()];
      if (dups.length && b.confirmDuplicate !== true) throw new HttpError(409, "같은 이름·별칭·연락처의 거래처가 있습니다. 같은 거래처면 기존 거래처에 연결하고, 다른 거래처일 때만 확인 후 등록하세요.", { code: "POSSIBLE_DUPLICATE", duplicates: dups });
      const batchId = await newBatch(tx, "manual_company_create", req.user?.id ?? null, `판매관리 미연결 관리 — 거래처 등록 '${name}'`);
      const [co] = await rows(tx, sql`INSERT INTO companies (name, notes, is_customer, customer_type, business_number, phone, mobile, email)
        VALUES (${name}, ${`판매관리 미연결 관리에서 등록(판매 ${saleNos.join(", ")})`}, true, ${customerType}, ${brn}, ${phone}, ${mobile}, ${email}) RETURNING id`);
      const companyId = Number(co.id);
      await tx.execute(sql`INSERT INTO company_aliases (company_id, alias_name, normalized_alias, is_primary) VALUES (${companyId}, ${name}, ${N(name)}, true) ON CONFLICT DO NOTHING`);
      await lineage(tx, batchId, companyId, `company:${companyId}`, "company_created", saleNos[0], { name, customerType, businessNumber: brn, phone, mobile, email, saleNos, by: performer(req), at: new Date().toISOString(), duplicatesConfirmed: dups.map(d => d.id) });
      await tx.execute(sql`INSERT INTO logs (entity_type, entity_id, action, performed_by, performed_by_email, metadata) VALUES ('company', ${companyId}, 'company_created', ${req.user?.id ?? null}, ${req.user?.email ?? null},
        ${JSON.stringify({ via: "legacy_party_manage", name, customerType, saleNos, batchId })})`);
      const results = await linkSalesToCompany(tx, req, companyId, saleNos, batchId, "create");
      return { batchId, companyId, results };
    });
    invalidateManageCache();
    res.status(201).json({ ...out, success: out.results.filter(r => r.ok).length, failed: out.results.filter(r => !r.ok).length });
  } catch (err) { sendError(res, req, err, "거래처 등록 실패."); }
});

// ── 담당자 일괄 연결(같은 거래처) — 판매관리 담당자 보완의 applyLink 재사용, 기존 담당자 연결은 건너뜀 ──
router.post("/admin/legacy-party/link-contact", ...adminGuard, requirePermission("contact.update"), async (req, res) => {
  const b = req.body ?? {}; const saleNos = saleNosOf(b); const contactId = Number(b.contactId);
  if (!saleNos.length) { res.status(400).json({ error: "연결할 판매를 선택하세요." }); return; }
  if (saleNos.length > 300) { res.status(400).json({ error: "한 번에 300건까지 처리할 수 있습니다." }); return; }
  if (!Number.isInteger(contactId) || contactId <= 0) { res.status(400).json({ error: "담당자를 선택하세요." }); return; }
  try {
    const out = await db.transaction(async tx => {
      const [ct] = await rows(tx, sql`SELECT id, company_id "companyId", name, position, department, phone, mobile, email, deleted_at "deletedAt", is_active "isActive" FROM contacts WHERE id = ${contactId}`);
      if (!ct || ct.deletedAt || !ct.isActive) throw new HttpError(404, "담당자를 찾을 수 없습니다.");
      await lockCompany(tx, Number(ct.companyId));
      const ids = await rows(tx, sql`SELECT DISTINCT ON (source_raw->>'판매번호') id, source_raw->>'판매번호' sale_no FROM legacy_archive_rows WHERE source_type='sales_list' AND is_effective
        AND source_raw->>'판매번호' IN (${sql.join(saleNos.map(s => sql`${s}`), sql`, `)}) ORDER BY source_raw->>'판매번호', id DESC`);
      const idOf = new Map(ids.map(r => [String(r.sale_no), Number(r.id)]));
      const results: ItemResult[] = [];
      for (const saleNo of saleNos) {
        try {
          await tx.transaction(async (sp: any) => {
            const id = idOf.get(saleNo); if (!id) throw new HttpError(404, "과거 CRM 판매를 찾을 수 없습니다.");
            const sale = await resolveSale(sp, "legacy", id);
            if (!sale.company) throw new HttpError(409, "판매의 거래처가 아직 연결되지 않았습니다. 거래처를 먼저 연결하세요.");
            if (sale.company.id !== Number(ct.companyId)) throw new HttpError(409, `담당자가 이 판매 거래처(${sale.company.name}) 소속이 아닙니다.`);
            if (sale.contact && Number(sale.contact.id) === contactId) { results.push({ saleNo, ok: true, result: "already" }); return; }
            if (sale.contact) throw new HttpError(409, `이미 다른 담당자(${sale.contact.name})가 연결되어 있습니다(덮어쓰지 않음).`);
            await applyLink(sp, req, sale, ct, sale.company.id, "link_related");
            results.push({ saleNo, ok: true, result: "linked" });
          });
        } catch (e: any) { results.push({ saleNo, ok: false, result: "failed", message: e?.message ?? "처리 중 오류" }); }
      }
      return { results };
    });
    invalidateManageCache();
    res.json({ ...out, success: out.results.filter(r => r.ok).length, failed: out.results.filter(r => !r.ok).length });
  } catch (err) { sendError(res, req, err, "담당자 연결 실패."); }
});

export default router;
