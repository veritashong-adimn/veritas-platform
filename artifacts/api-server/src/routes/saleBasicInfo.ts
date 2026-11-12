// ─── 판매상세 A. 기본정보 수정 ─────────────────────────────────────────────────────
//   GET   /admin/sales/:id/basic-info   현재 값(이 판매건 견적 수신자 · 담당자 Master · PM · 견적서명 · 견적일) + 거래처 담당자 목록 + 변경 이력
//   PATCH /admin/sales/:id/basic-info   기본정보 수정(수정 사유 필수)
//
// 원칙(견적·판매건 = 당시 확정 거래 정보 / 담당자 Master = 현재 고객 연락처 기준)
//   · 담당자 연락처·이메일 수정 기본값 = '이 판매건만' — 현재 견적의 수신자 고정값(quotes.customer_contact_*)만 바꾼다.
//     담당자 Master(contacts)는 사용자가 applyToMaster=true 로 명시했을 때만 함께 바꾼다(contact.update 권한 필요).
//     Master 를 바꿀 때는 그 담당자를 쓰는 다른 견적 중 고정값이 없는 것을 먼저 고정한다(다른 판매건 출력 불변 — freezeContactQuotes).
//   · 담당자 변경 = 이 판매 거래처 소속 담당자 Master 만 선택 가능(다른 거래처 담당자 자동 연결 금지).
//     같은 판매의 다른(이전 버전) 견적 출력은 바꾸기 전 값으로 고정한다(freezeProjectQuotes).
//   · 거래처 이메일을 담당자 이메일로 대체하지 않는다(담당자 Master 이메일이 없으면 빈 칸).
//   · 수행·지급·청구·수금·정산 테이블은 읽지도 쓰지도 않는다. 바꾸는 것은 projects(담당자·PM·판매명),
//     quotes(견적서명·견적일·수신자 고정값), 그리고 명시 선택 시 contacts 뿐이다.
//   · 변경 전후·사유·Master 동시 수정 여부는 logs 에 같은 트랜잭션으로 남긴다.
//   · 판매일: 운영 판매의 판매일은 별도 저장 칸이 없고 견적일(quotes.issue_date)을 그대로 쓴다 — 견적일 수정이 곧 판매일 수정이다.
import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db, logsTable } from "@workspace/db";
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth";
import { getPermissionsForRole } from "../lib/rbac";
import { captureIfMissing, freezeContactQuotes, freezeProjectQuotes } from "../services/quoteRecipientSnapshot";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];
const rows = async (dbx: any, q: any) => ((await dbx.execute(q)).rows as any[]);

class HttpError extends Error { constructor(public status: number, message: string, public extra?: Record<string, unknown>) { super(message); } }

const nz = (v: unknown): string | null => (v == null ? null : String(v).trim() || null);
const EMAIL_OK = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const DATE_OK = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime());

async function hasPermission(user: any, key: string): Promise<boolean> {
  if (!user) return false;
  if (user.role === "admin" && !user.roleId) return true;
  if (!user.roleId) return false;
  return (await getPermissionsForRole(user.roleId)).has(key);
}

const FIXED = sql.raw(`(q.customer_company_name IS NOT NULL OR q.customer_contact_name IS NOT NULL OR q.customer_contact_position IS NOT NULL
  OR q.customer_contact_department IS NOT NULL OR q.customer_contact_phone IS NOT NULL OR q.customer_contact_mobile IS NOT NULL OR q.customer_contact_email IS NOT NULL)`);

async function loadSale(dbx: any, projectId: number, lock = false) {
  const [p] = await rows(dbx, sql`SELECT p.id, p.title, p.status, p.company_id "companyId", p.contact_id "contactId", p.admin_id "adminId",
      p.company_name_snapshot "companyNameSnapshot", p.contact_name_snapshot "contactNameSnapshot", co.name "companyName",
      (SELECT m.legacy_id FROM legacy_master_mappings m WHERE m.source_system = 'old_crm' AND m.entity_type = 'sale' AND m.status = 'active' AND m.entity_id = p.id LIMIT 1) "saleNo"
    FROM projects p LEFT JOIN companies co ON co.id = p.company_id WHERE p.id = ${projectId} ${lock ? sql`FOR UPDATE OF p` : sql``}`);
  if (!p) throw new HttpError(404, "판매건을 찾을 수 없습니다.");
  // 판매 상세가 보는 견적과 같은 기준: 현재 버전 우선
  const [q] = await rows(dbx, sql`SELECT q.id, q.quote_number "quoteNumber", q.title, q.issue_date "issueDate", q.derived_contact_id "derivedContactId",
      q.customer_contact_name "name", q.customer_contact_phone "phone", q.customer_contact_mobile "mobile", q.customer_contact_email "email", ${FIXED} "fixed"
    FROM quotes q WHERE q.project_id = ${projectId} AND q.deleted_at IS NULL ORDER BY q.is_current DESC, q.id DESC LIMIT 1 ${lock ? sql`FOR UPDATE` : sql``}`);
  return { p, q: q ?? null };
}

async function contactRow(dbx: any, id: number | null | undefined) {
  if (!id) return null;
  const [c] = await rows(dbx, sql`SELECT id, company_id "companyId", name, position, department, phone, mobile, office_phone "officePhone", email,
      is_active "isActive", deleted_at "deletedAt" FROM contacts WHERE id = ${id}`);
  return c ?? null;
}

// 판매상세 A.기본정보에 실제로 보이는 값(견적서 출력과 같은 규칙: 고정값이 있으면 고정값, 없으면 담당자 Master)
async function displayed(dbx: any, sale: Awaited<ReturnType<typeof loadSale>>) {
  const live = await contactRow(dbx, sale.q?.derivedContactId ?? sale.p.contactId);
  const fixed = !!sale.q?.fixed;
  return {
    contactId: sale.p.contactId ? Number(sale.p.contactId) : null,
    contactName: sale.p.contactNameSnapshot ?? live?.name ?? null,
    phone: fixed ? nz(sale.q.phone) : nz(live?.phone ?? (live?.mobile ? null : live?.officePhone)),
    mobile: fixed ? nz(sale.q.mobile) : nz(live?.mobile),
    email: fixed ? nz(sale.q.email) : nz(live?.email),
    adminId: sale.p.adminId ? Number(sale.p.adminId) : null,
    title: sale.q?.title ?? sale.p.title ?? null,
    issueDate: sale.q?.issueDate ? String(sale.q.issueDate).slice(0, 10) : null,
    fixed,
  };
}

async function buildView(dbx: any, projectId: number) {
  const sale = await loadSale(dbx, projectId);
  const cur = await displayed(dbx, sale);
  const master = await contactRow(dbx, sale.p.contactId);
  const contacts = sale.p.companyId ? await rows(dbx, sql`SELECT id, name, position, department, phone, mobile, office_phone "officePhone", email
      FROM contacts WHERE company_id = ${sale.p.companyId} AND deleted_at IS NULL AND is_active ORDER BY is_primary DESC, name`) : [];
  const staff = await rows(dbx, sql`SELECT id, name, email, role FROM users WHERE role IN ('admin', 'staff') AND is_active AND deleted_at IS NULL ORDER BY name NULLS LAST, id`);
  const history = await rows(dbx, sql`SELECT id, performed_by_email "by", created_at "at", metadata FROM logs
    WHERE entity_type = 'project' AND entity_id = ${projectId} AND action = 'sale_basic_info_updated' ORDER BY id DESC LIMIT 30`);
  // 이 판매건(견적 출력) 값과 현재 담당자 Master 값의 차이 — 표시만, 자동 반영 없음
  const diffs: Array<{ field: string; label: string; sale: string | null; master: string | null }> = [];
  if (master && !master.deletedAt) {
    const pairs: Array<[string, string, string | null, string | null]> = [
      ["mobile", "휴대전화", cur.mobile, nz(master.mobile)],
      ["phone", "일반전화", cur.phone, nz(master.phone ?? (master.mobile ? null : master.officePhone))],
      ["email", "이메일", cur.email, nz(master.email)],
    ];
    const norm = (f: string, v: string | null) => (v == null ? "" : f === "email" ? v.toLowerCase() : v.replace(/\D/g, ""));
    for (const [f, l, a, b] of pairs) if (norm(f, a) !== norm(f, b)) diffs.push({ field: f, label: l, sale: a, master: b });
  }
  return {
    projectId, saleNo: sale.p.saleNo ?? null, status: sale.p.status,
    company: sale.p.companyId ? { id: Number(sale.p.companyId), name: sale.p.companyName ?? sale.p.companyNameSnapshot ?? null } : null,
    quote: sale.q ? { id: Number(sale.q.id), quoteNumber: sale.q.quoteNumber ?? null } : null,
    current: cur,
    master: master ? { id: Number(master.id), name: master.name, phone: master.phone, mobile: master.mobile, officePhone: master.officePhone, email: master.email, deleted: !!master.deletedAt } : null,
    diffs, contacts, staff,
    history: history.map(h => { let m: any = null; try { m = JSON.parse(h.metadata ?? "null"); } catch { /* 기록 원문 유지 */ } return { id: h.id, by: h.by, at: h.at, ...m }; }),
  };
}

function sendError(res: any, req: any, err: any, fallback: string) {
  if (err instanceof HttpError) { res.status(err.status).json({ error: err.message, ...(err.extra ?? {}) }); return; }
  req.log.error({ err }, fallback);
  res.status(500).json({ error: fallback });
}

router.get("/admin/sales/:id/basic-info", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "유효하지 않은 판매 id." }); return; }
  try { res.json(await buildView(db, id)); } catch (err) { sendError(res, req, err, "기본정보 조회 실패."); }
});

const LABEL: Record<string, string> = {
  contact: "거래처 담당자", mobile: "담당자 휴대전화", phone: "담당자 일반전화", email: "담당자 이메일",
  adminId: "담당 PM", title: "견적서명/판매명", issueDate: "견적일(=판매일)",
};

router.patch("/admin/sales/:id/basic-info", ...adminGuard, requirePermission("project.update"), async (req, res) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId) || projectId <= 0) { res.status(400).json({ error: "유효하지 않은 판매 id." }); return; }
  const b = req.body ?? {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  const reason = nz(b.reason);
  if (!reason) { res.status(400).json({ error: "수정 사유를 입력하세요." }); return; }
  const applyToMaster = b.applyToMaster === true;
  // 입력 검증(트랜잭션 전)
  const email = has("contactEmail") ? nz(b.contactEmail)?.toLowerCase() ?? null : undefined;
  if (email && !EMAIL_OK(email)) { res.status(400).json({ error: "이메일 형식이 올바르지 않습니다." }); return; }
  const mobile = has("contactMobile") ? nz(b.contactMobile) : undefined;
  const phone = has("contactPhone") ? nz(b.contactPhone) : undefined;
  for (const [v, l] of [[mobile, "휴대전화"], [phone, "일반전화"]] as const)
    if (v && (!/^[0-9+\-()\s.]+$/.test(v) || v.replace(/\D/g, "").length < 7)) { res.status(400).json({ error: `${l} 형식이 올바르지 않습니다.` }); return; }
  const title = has("title") ? nz(b.title) : undefined;
  if (has("title") && !title) { res.status(400).json({ error: "견적서명/판매명은 빈 값일 수 없습니다." }); return; }
  const issueDate = has("issueDate") ? nz(b.issueDate) : undefined;
  if (has("issueDate") && (!issueDate || !DATE_OK(issueDate))) { res.status(400).json({ error: "견적일 형식이 올바르지 않습니다(YYYY-MM-DD)." }); return; }
  const contactId = has("contactId") ? (b.contactId == null ? null : Number(b.contactId)) : undefined;
  if (contactId === null) { res.status(400).json({ error: "담당자 연결 해제는 지원하지 않습니다. 다른 담당자를 선택하세요." }); return; }
  const adminId = has("adminId") ? (b.adminId == null ? null : Number(b.adminId)) : undefined;
  const contactFieldsTouched = mobile !== undefined || phone !== undefined || email !== undefined;
  if (applyToMaster && !contactFieldsTouched) { res.status(400).json({ error: "담당자 Master 에 반영할 연락처·이메일 변경이 없습니다." }); return; }
  if (applyToMaster && !(await hasPermission(req.user, "contact.update"))) { res.status(403).json({ error: "권한이 없습니다: contact.update (담당자 Master 수정)" }); return; }

  try {
    const out = await db.transaction(async tx => {
      const sale = await loadSale(tx, projectId, true);
      const q = sale.q;
      if (!q && (contactId !== undefined || contactFieldsTouched || title !== undefined || issueDate !== undefined))
        throw new HttpError(409, "이 판매건에 연결된 견적이 없어 담당자·견적 정보를 수정할 수 없습니다.");
      // 화면을 연 뒤 다른 사람이 견적을 바꿨으면 중단(다른 견적 덮어쓰기 방지)
      if (b.expectedQuoteId != null && q && Number(b.expectedQuoteId) !== Number(q.id)) throw new HttpError(409, "판매건의 견적이 바뀌었습니다. 새로고침 후 다시 시도하세요.");
      const before = await displayed(tx, sale);
      const frozenQuoteIds: number[] = [];

      // 0) 이 견적의 현재 출력값을 먼저 고정(고정값 없는 기존 견적 — 출력 불변). 이후 변경은 이 판매건 고정값에만 반영된다.
      if (q && (contactId !== undefined || contactFieldsTouched)) await captureIfMissing(tx, Number(q.id));

      // 1) 거래처 담당자 변경 — 이 판매 거래처 소속 Master 만
      let targetContactId: number | null = sale.p.contactId ? Number(sale.p.contactId) : null;
      if (contactId !== undefined && contactId !== targetContactId) {
        if (!Number.isInteger(contactId) || contactId! <= 0) throw new HttpError(400, "유효하지 않은 담당자입니다.");
        if (!sale.p.companyId) throw new HttpError(409, "판매에 거래처가 연결되어 있지 않습니다. 거래처를 먼저 연결하세요.");
        const c = await contactRow(tx, contactId);
        if (!c || c.deletedAt) throw new HttpError(404, "담당자를 찾을 수 없습니다.");
        if (Number(c.companyId) !== Number(sale.p.companyId)) throw new HttpError(409, "선택한 담당자는 이 판매건의 거래처 소속이 아닙니다.");
        if (!c.isActive) throw new HttpError(409, "비활성 담당자는 선택할 수 없습니다.");
        frozenQuoteIds.push(...await freezeProjectQuotes(tx, projectId, Number(q.id)));   // 같은 판매의 다른 견적 출력 보존
        await tx.execute(sql`UPDATE projects SET contact_id = ${c.id}, contact_name_snapshot = ${c.name} WHERE id = ${projectId}`);
        // 이 판매건 견적 수신자 = 새 담당자 Master 값(거래처 이메일로 대체하지 않음). 아래 직접 입력값이 있으면 그 값이 우선.
        await tx.execute(sql`UPDATE quotes SET customer_contact_name = ${c.name}, customer_contact_position = ${c.position}, customer_contact_department = ${c.department},
            customer_contact_phone = ${nz(c.phone ?? (c.mobile ? null : c.officePhone))}, customer_contact_mobile = ${nz(c.mobile)}, customer_contact_email = ${nz(c.email)}
          WHERE id = ${q.id}`);
        targetContactId = Number(c.id);
      }

      // 2) 연락처·이메일 — 이 판매건 고정값
      if (contactFieldsTouched) {
        const sets = [
          ...(mobile !== undefined ? [sql`customer_contact_mobile = ${mobile}`] : []),
          ...(phone !== undefined ? [sql`customer_contact_phone = ${phone}`] : []),
          ...(email !== undefined ? [sql`customer_contact_email = ${email}`] : []),
        ];
        await tx.execute(sql`UPDATE quotes SET ${sql.join(sets, sql`, `)} WHERE id = ${q.id}`);
      }

      // 3) (명시 선택) 담당자 Master 동시 수정
      let master: { contactId: number; companyId: number; before: Record<string, string | null>; after: Record<string, string | null> } | null = null;
      if (applyToMaster) {
        if (!targetContactId) throw new HttpError(409, "연결된 담당자 Master 가 없어 Master 를 수정할 수 없습니다. 담당자를 먼저 선택하세요.");
        const c = await contactRow(tx, targetContactId);
        if (!c || c.deletedAt) throw new HttpError(404, "담당자 Master 를 찾을 수 없습니다.");
        if (sale.p.companyId && Number(c.companyId) !== Number(sale.p.companyId)) throw new HttpError(409, "담당자 Master 가 이 판매건 거래처 소속이 아닙니다.");
        frozenQuoteIds.push(...await freezeContactQuotes(tx, [Number(c.id)]));   // 이 담당자를 쓰는 다른 판매·견적 출력 보존
        const mb = { mobile: nz(c.mobile), phone: nz(c.phone), email: nz(c.email) };
        const ma = { mobile: mobile !== undefined ? mobile : mb.mobile, phone: phone !== undefined ? phone : mb.phone, email: email !== undefined ? email : mb.email };
        await tx.execute(sql`UPDATE contacts SET mobile = ${ma.mobile}, phone = ${ma.phone}, email = ${ma.email}, updated_at = now() WHERE id = ${c.id}`);
        master = { contactId: Number(c.id), companyId: Number(c.companyId), before: mb, after: ma };
      }

      // 4) 담당 PM
      if (adminId !== undefined && adminId !== before.adminId) {
        if (adminId !== null) {
          const [u] = await rows(tx, sql`SELECT id FROM users WHERE id = ${adminId} AND role IN ('admin', 'staff') AND is_active AND deleted_at IS NULL`);
          if (!u) throw new HttpError(400, "유효한 직원이 아닙니다.");
        }
        await tx.execute(sql`UPDATE projects SET admin_id = ${adminId} WHERE id = ${projectId}`);
      }
      // 5) 견적서명/판매명 — 견적 제목과 판매명(projects.title)을 같이
      if (title !== undefined) {
        if (q) await tx.execute(sql`UPDATE quotes SET title = ${title} WHERE id = ${q.id}`);
        await tx.execute(sql`UPDATE projects SET title = ${title} WHERE id = ${projectId}`);
      }
      // 6) 견적일(=판매일)
      if (issueDate !== undefined) await tx.execute(sql`UPDATE quotes SET issue_date = ${issueDate} WHERE id = ${q.id}`);

      const after = await displayed(tx, await loadSale(tx, projectId));
      const changes: Array<{ field: string; label: string; before: unknown; after: unknown }> = [];
      const push = (field: string, a: unknown, z: unknown) => { if (JSON.stringify(a ?? null) !== JSON.stringify(z ?? null)) changes.push({ field, label: LABEL[field], before: a ?? null, after: z ?? null }); };
      push("contact", before.contactId ? { id: before.contactId, name: before.contactName } : null, after.contactId ? { id: after.contactId, name: after.contactName } : null);
      push("mobile", before.mobile, after.mobile); push("phone", before.phone, after.phone); push("email", before.email, after.email);
      push("adminId", before.adminId, after.adminId); push("title", before.title, after.title); push("issueDate", before.issueDate, after.issueDate);
      const masterChanged = !!master && JSON.stringify(master.before) !== JSON.stringify(master.after);
      if (!changes.length && !masterChanged) throw new HttpError(400, "변경된 항목이 없습니다.");

      const performer = req.user ? { performedBy: req.user.id, performedByEmail: req.user.email } : { performedBy: null, performedByEmail: null };
      const meta = { saleNo: sale.p.saleNo ?? null, projectId, quoteId: q?.id ?? null, quoteNumber: q?.quoteNumber ?? null, reason, changes,
        contactScope: applyToMaster ? "sale_and_master" : "sale_only", masterUpdated: masterChanged,
        master: masterChanged ? master : null, frozenQuoteIds: [...new Set(frozenQuoteIds)] };
      await tx.insert(logsTable).values({ entityType: "project", entityId: projectId, action: "sale_basic_info_updated", ...performer, metadata: JSON.stringify(meta) });
      const recipientChanges = changes.filter(c => ["contact", "mobile", "phone", "email"].includes(c.field));
      if (q && recipientChanges.length) await tx.insert(logsTable).values({ entityType: "quote", entityId: Number(q.id), action: "quote_recipient_edited", ...performer,
        metadata: JSON.stringify({ via: "sale_basic_info", projectId, reason, changes: recipientChanges }) });
      if (masterChanged) await tx.insert(logsTable).values({ entityType: "company", entityId: master!.companyId, action: "company_contact_updated", ...performer,
        metadata: JSON.stringify({ contactId: master!.contactId, via: "sale_basic_info", projectId, reason, before: master!.before, after: master!.after }) });
      return meta;
    });
    res.json({ ok: true, ...out, view: await buildView(db, projectId) });
  } catch (err) { sendError(res, req, err, "기본정보 수정 실패."); }
});

export default router;
