import { Router, type IRouter } from "express";
import {
  db, inquiriesTable, quotesTable, companiesTable, contactsTable, divisionsTable, usersTable,
} from "@workspace/db";
import { eq, and, isNull, desc, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";

/**
 * 의뢰건 접수(inquiries) — pre-sales 단계 라우터.
 *
 * 상태 중복 저장 방지: DB inquiries.status 는 pre-quote 수기 상태(new/reviewing/closed_no_quote)만 저장.
 * 「견적작성중/견적발송/판매전환」 은 연결된 quote.status 에서 파생 계산(deriveQuoteProgress)한다.
 * 일자 집계는 KST(Asia/Seoul) 기준 receivedAt 날짜로 계산한다.
 * 기존 quotes/projects/companies/contacts API 는 변경하지 않는다.
 */
const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

// received_at(UTC 저장) → KST 날짜 캐스팅
const kstDate = (col: any) => sql<string>`(${col} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Seoul')::date`;

// ── 접수번호 R000001 시퀀스 (견적번호와 별개) ────────────────────────────────
let inquirySeqReady = false;
async function generateInquiryNumber(): Promise<string> {
  if (!inquirySeqReady) {
    await db.execute(sql`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relkind='S' AND relname='inquiry_number_seq') THEN
          CREATE SEQUENCE inquiry_number_seq;
          PERFORM setval('inquiry_number_seq', GREATEST(
            (SELECT COALESCE(MAX(CAST(SUBSTRING(inquiry_number FROM 2) AS INTEGER)), 0)
               FROM inquiries WHERE inquiry_number ~ '^R[0-9]{6}$'), 1), true);
        END IF;
      END $$;`);
    inquirySeqReady = true;
  }
  const result = await db.execute<{ seq: string }>(sql`SELECT nextval('inquiry_number_seq') AS seq`);
  const seqNum = Number((result.rows[0] as { seq: string | number }).seq);
  return `R${String(seqNum).padStart(6, "0")}`;
}

/**
 * 견적 진행상태 파생 — 저장하지 않고 quote.status 로부터 계산.
 *   none(미견적) | drafting(견적작성중) | sent(견적발송) | closed_no_quote(견적없이 종결)
 * 판매전환(approved) 도 "발송됨" 으로 취급하되 saleConverted 플래그로 별도 구분.
 */
function deriveQuoteProgress(inq: { status: string; quoteId: number | null }, q: { status: string | null } | null) {
  if (inq.status === "closed_no_quote") return { progress: "closed_no_quote", saleConverted: false };
  if (inq.quoteId && q) {
    if (q.status === "pending") return { progress: "drafting", saleConverted: false };
    if (q.status === "approved") return { progress: "sent", saleConverted: true };
    // sent / rejected → 견적은 이미 발송됨
    return { progress: "sent", saleConverted: false };
  }
  return { progress: "none", saleConverted: false };
}

/** 처리상태(업무 표시용) 파생 — 신규접수/확인중/견적작성중/견적발송/견적없이 종결 */
function deriveProcessing(inq: { status: string; quoteId: number | null }, q: { status: string | null } | null) {
  if (inq.status === "closed_no_quote") return "closed_no_quote";
  if (inq.quoteId && q) return deriveQuoteProgress(inq, q).progress === "drafting" ? "quoting" : "quote_sent";
  return inq.status === "reviewing" ? "reviewing" : "new";
}

// ── 목록 + 일자별 현황 집계 ──────────────────────────────────────────────────
// GET /admin/inquiries?date=YYYY-MM-DD  (KST 기준). 미지정 시 KST 오늘.
router.get("/admin/inquiries", ...adminGuard, async (req, res) => {
  try {
    const dateParam = typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date
      : null;
    // 기준일: 지정값 또는 KST 오늘
    const [{ d: baseDate }] = (await db.execute<{ d: string }>(
      dateParam
        ? sql`SELECT ${dateParam}::date::text AS d`
        : sql`SELECT (now() AT TIME ZONE 'Asia/Seoul')::date::text AS d`,
    )).rows as any;

    // 조회 대상: 기준일 접수건 + 이월 미처리(기준일 이전 접수 & 미처리)
    const rows = await db
      .select({
        inq: inquiriesTable,
        quoteNumber: quotesTable.quoteNumber,
        quoteStatus: quotesTable.status,
        quoteIssueDate: quotesTable.issueDate,
        quoteCreatedAt: quotesTable.createdAt,
        companyName: companiesTable.name,
        contactNameLinked: contactsTable.name,
        pmName: usersTable.name,
        recvDate: kstDate(inquiriesTable.receivedAt),
      })
      .from(inquiriesTable)
      .leftJoin(quotesTable, eq(inquiriesTable.quoteId, quotesTable.id))
      .leftJoin(companiesTable, eq(inquiriesTable.companyId, companiesTable.id))
      .leftJoin(contactsTable, eq(inquiriesTable.contactId, contactsTable.id))
      .leftJoin(usersTable, eq(inquiriesTable.assignedPmId, usersTable.id))
      .where(and(
        isNull(inquiriesTable.deletedAt),
        sql`(${kstDate(inquiriesTable.receivedAt)} = ${baseDate}
             OR (${kstDate(inquiriesTable.receivedAt)} < ${baseDate}
                 AND ${inquiriesTable.quoteId} IS NULL
                 AND ${inquiriesTable.status} <> 'closed_no_quote'))`,
      ))
      .orderBy(desc(inquiriesTable.receivedAt));

    const mapped = rows.map(r => {
      const q = r.quoteNumber != null || r.quoteStatus != null ? { status: r.quoteStatus } : null;
      const dq = deriveQuoteProgress({ status: r.inq.status, quoteId: r.inq.quoteId }, q);
      return {
        ...r.inq,
        companyDisplay: r.companyName ?? r.inq.customerCompanyName ?? null,
        contactDisplay: r.contactNameLinked ?? r.inq.contactName ?? null,
        pmName: r.pmName ?? null,
        quoteNumber: r.quoteNumber ?? null,
        quoteStatus: r.quoteStatus ?? null,
        quoteIssueDate: r.quoteIssueDate ?? null,
        quoteCreatedAt: r.quoteCreatedAt ?? null,
        quoteProgress: dq.progress,
        saleConverted: dq.saleConverted,
        processingStatus: deriveProcessing({ status: r.inq.status, quoteId: r.inq.quoteId }, q),
        isCarryover: r.recvDate !== baseDate,
      };
    });

    // 기준일 집계 (isCarryover=false 만)
    const dayRows = mapped.filter(m => !m.isCarryover);
    const summary = {
      total: dayRows.length,
      new: dayRows.filter(m => m.processingStatus === "new").length,
      reviewing: dayRows.filter(m => m.processingStatus === "reviewing").length,
      quoting: dayRows.filter(m => m.processingStatus === "quoting").length,
      quoteSent: dayRows.filter(m => m.processingStatus === "quote_sent").length,
      closedNoQuote: dayRows.filter(m => m.processingStatus === "closed_no_quote").length,
      // 오늘(기준일) 미처리 = 견적 미연결 & 미종결
      unresolvedToday: dayRows.filter(m => !m.quoteId && m.status !== "closed_no_quote").length,
    };
    const carryoverCount = mapped.filter(m => m.isCarryover).length;

    res.json({ date: baseDate, summary, carryoverCount, rows: mapped });
  } catch (err) {
    req.log.error({ err }, "Inquiries: list failed");
    res.status(500).json({ error: "의뢰건 목록 조회 실패." });
  }
});

// ── 상세 ─────────────────────────────────────────────────────────────────────
router.get("/admin/inquiries/:id", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id) || id <= 0) { res.status(400).json({ error: "유효하지 않은 id." }); return; }
  try {
    const [r] = await db
      .select({
        inq: inquiriesTable,
        quoteNumber: quotesTable.quoteNumber,
        quoteStatus: quotesTable.status,
        quoteIssueDate: quotesTable.issueDate,
        quoteCreatedAt: quotesTable.createdAt,
        quotePrice: quotesTable.price,
        companyName: companiesTable.name,
        contactNameLinked: contactsTable.name,
        divisionName: divisionsTable.name,
        pmName: usersTable.name,
      })
      .from(inquiriesTable)
      .leftJoin(quotesTable, eq(inquiriesTable.quoteId, quotesTable.id))
      .leftJoin(companiesTable, eq(inquiriesTable.companyId, companiesTable.id))
      .leftJoin(contactsTable, eq(inquiriesTable.contactId, contactsTable.id))
      .leftJoin(divisionsTable, eq(inquiriesTable.divisionId, divisionsTable.id))
      .leftJoin(usersTable, eq(inquiriesTable.assignedPmId, usersTable.id))
      .where(and(eq(inquiriesTable.id, id), isNull(inquiriesTable.deletedAt)));
    if (!r) { res.status(404).json({ error: "의뢰건을 찾을 수 없습니다." }); return; }
    const q = r.quoteStatus != null ? { status: r.quoteStatus } : null;
    const dq = deriveQuoteProgress({ status: r.inq.status, quoteId: r.inq.quoteId }, q);
    res.json({
      ...r.inq,
      companyName: r.companyName ?? null,
      contactNameLinked: r.contactNameLinked ?? null,
      divisionName: r.divisionName ?? null,
      pmName: r.pmName ?? null,
      quoteNumber: r.quoteNumber ?? null,
      quoteStatus: r.quoteStatus ?? null,
      quoteIssueDate: r.quoteIssueDate ?? null,
      quoteCreatedAt: r.quoteCreatedAt ?? null,
      quotePrice: r.quotePrice != null ? Number(r.quotePrice) : null,
      quoteProgress: dq.progress,
      saleConverted: dq.saleConverted,
      processingStatus: deriveProcessing({ status: r.inq.status, quoteId: r.inq.quoteId }, q),
    });
  } catch (err) {
    req.log.error({ err }, "Inquiries: detail failed");
    res.status(500).json({ error: "의뢰건 조회 실패." });
  }
});

// 입력 정규화 헬퍼
const str = (v: any): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: any): number | null => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));
const ts = (v: any): Date | null => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d; };
const CHANNELS = ["homepage", "email", "phone", "kakao", "other"];

// ── 등록 ─────────────────────────────────────────────────────────────────────
router.post("/admin/inquiries", ...adminGuard, async (req, res) => {
  const b = req.body ?? {};
  try {
    const channel = CHANNELS.includes(b.channel) ? b.channel : "phone";
    const receivedAt = ts(b.receivedAt) ?? new Date();
    const inquiryNumber = await generateInquiryNumber();

    const [created] = await db.insert(inquiriesTable).values({
      inquiryNumber, receivedAt, channel, status: "new",
      assignedPmId: num(b.assignedPmId), createdBy: req.user?.id ?? null,
      customerCompanyName: str(b.customerCompanyName), contactName: str(b.contactName),
      department: str(b.department), contactPosition: str(b.contactPosition),
      contactPhone: str(b.contactPhone), contactMobile: str(b.contactMobile), contactEmail: str(b.contactEmail),
      companyId: num(b.companyId), contactId: num(b.contactId), divisionId: num(b.divisionId),
      serviceType: str(b.serviceType), languageFrom: str(b.languageFrom), languageTo: str(b.languageTo),
      scheduleFrom: ts(b.scheduleFrom), scheduleTo: ts(b.scheduleTo),
      place: str(b.place), volume: str(b.volume), subject: str(b.subject), requirements: str(b.requirements),
      quoteDueDate: ts(b.quoteDueDate),
      interpretType: str(b.interpretType), interpretDuration: str(b.interpretDuration),
      documentType: str(b.documentType), documentUsage: str(b.documentUsage), desiredCompletionDate: ts(b.desiredCompletionDate),
      equipmentJson: str(b.equipmentJson),
      rawSource: str(b.rawSource), attachmentsJson: str(b.attachmentsJson),
    } as any).returning();

    await logEvent("inquiry", created.id, "inquiry_created", req.log, req.user ?? undefined,
      JSON.stringify({ inquiryNumber, channel }));
    res.status(201).json(created);
  } catch (err) {
    req.log.error({ err }, "Inquiries: create failed");
    res.status(500).json({ error: "의뢰건 등록 실패." });
  }
});

// ── 수정 (필드/상태/거래처·담당자 확정 연결) ─────────────────────────────────
// 견적 파생 상태는 저장하지 않는다. status 는 new|reviewing 만 수기 변경 허용.
router.patch("/admin/inquiries/:id", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id) || id <= 0) { res.status(400).json({ error: "유효하지 않은 id." }); return; }
  const b = req.body ?? {};
  try {
    const [existing] = await db.select().from(inquiriesTable).where(and(eq(inquiriesTable.id, id), isNull(inquiriesTable.deletedAt)));
    if (!existing) { res.status(404).json({ error: "의뢰건을 찾을 수 없습니다." }); return; }
    if (existing.status === "closed_no_quote") { res.status(409).json({ error: "종결된 의뢰건은 수정할 수 없습니다." }); return; }

    const patch: any = { updatedAt: new Date() };
    // 수기 상태(new|reviewing)만 허용 — closed_no_quote 는 /close 로만.
    if (b.status === "new" || b.status === "reviewing") patch.status = b.status;
    for (const f of ["customerCompanyName", "contactName", "department", "contactPosition",
      "contactPhone", "contactMobile", "contactEmail",
      "serviceType", "languageFrom", "languageTo", "place", "volume", "subject", "requirements",
      "interpretType", "interpretDuration", "documentType", "documentUsage", "equipmentJson", "rawSource", "attachmentsJson"]) {
      if (f in b) patch[f] = str(b[f]);
    }
    for (const f of ["companyId", "contactId", "divisionId", "assignedPmId"]) {
      if (f in b) patch[f] = num(b[f]);
    }
    if ("channel" in b && CHANNELS.includes(b.channel)) patch.channel = b.channel;
    if ("receivedAt" in b) { const t = ts(b.receivedAt); if (t) patch.receivedAt = t; }
    for (const f of ["scheduleFrom", "scheduleTo", "quoteDueDate", "desiredCompletionDate"]) {
      if (f in b) patch[f] = ts(b[f]);
    }

    const [updated] = await db.update(inquiriesTable).set(patch).where(eq(inquiriesTable.id, id)).returning();
    await logEvent("inquiry", id, "inquiry_updated", req.log, req.user ?? undefined,
      JSON.stringify({ fields: Object.keys(patch).filter(k => k !== "updatedAt") }));
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Inquiries: update failed");
    res.status(500).json({ error: "의뢰건 수정 실패." });
  }
});

// ── 견적 연결 (견적서 작성 화면에서 저장 성공 후 호출) ────────────────────────
router.post("/admin/inquiries/:id/link-quote", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  const quoteId = num(req.body?.quoteId);
  if (isNaN(id) || id <= 0 || !quoteId) { res.status(400).json({ error: "id/quoteId가 필요합니다." }); return; }
  try {
    const [existing] = await db.select().from(inquiriesTable).where(and(eq(inquiriesTable.id, id), isNull(inquiriesTable.deletedAt)));
    if (!existing) { res.status(404).json({ error: "의뢰건을 찾을 수 없습니다." }); return; }
    // 상태는 저장하지 않고 파생하지만, 신규(new)면 확인중(reviewing)으로 올려 목록 가독성 향상(중복 아님).
    const nextStatus = existing.status === "new" ? "reviewing" : existing.status;
    const [updated] = await db.update(inquiriesTable)
      .set({ quoteId, status: nextStatus as any, updatedAt: new Date() })
      .where(eq(inquiriesTable.id, id)).returning();
    await logEvent("inquiry", id, "inquiry_quote_linked", req.log, req.user ?? undefined, JSON.stringify({ quoteId }));
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Inquiries: link-quote failed");
    res.status(500).json({ error: "견적 연결 실패." });
  }
});

// ── 견적 없이 종결 (사유 필수) ────────────────────────────────────────────────
const CLOSE_CODES = ["customer_cancel", "schedule_mismatch", "no_resource", "out_of_scope",
  "budget_mismatch", "simple_inquiry", "duplicate", "competitor", "other"];
router.post("/admin/inquiries/:id/close", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id) || id <= 0) { res.status(400).json({ error: "유효하지 않은 id." }); return; }
  const code = typeof req.body?.reasonCode === "string" ? req.body.reasonCode : "";
  const detail = str(req.body?.reasonDetail);
  if (!CLOSE_CODES.includes(code)) { res.status(400).json({ error: "종결 사유를 선택해 주세요." }); return; }
  if (code === "other" && !detail) { res.status(400).json({ error: "기타 선택 시 상세 사유를 입력해 주세요." }); return; }
  try {
    const [existing] = await db.select().from(inquiriesTable).where(and(eq(inquiriesTable.id, id), isNull(inquiriesTable.deletedAt)));
    if (!existing) { res.status(404).json({ error: "의뢰건을 찾을 수 없습니다." }); return; }
    if (existing.status === "closed_no_quote") { res.status(409).json({ error: "이미 종결된 의뢰건입니다." }); return; }
    if (existing.quoteId) { res.status(409).json({ error: "견적이 연결된 의뢰건은 견적 없이 종결할 수 없습니다." }); return; }

    const [updated] = await db.update(inquiriesTable)
      .set({ status: "closed_no_quote", closeReasonCode: code, closeReasonDetail: detail, closedAt: new Date(), closedBy: req.user?.id ?? null, updatedAt: new Date() })
      .where(eq(inquiriesTable.id, id)).returning();
    // 종결은 삭제하지 않고 영업분석용으로 보존. 감사로그에도 사유 기록.
    await logEvent("inquiry", id, "inquiry_closed_no_quote", req.log, req.user ?? undefined,
      JSON.stringify({ reasonCode: code, ...(detail ? { reasonDetail: detail } : {}) }));
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Inquiries: close failed");
    res.status(500).json({ error: "의뢰건 종결 실패." });
  }
});

// ── soft delete (감사 포함, 종결과 별개) ──────────────────────────────────────
router.delete("/admin/inquiries/:id", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id) || id <= 0) { res.status(400).json({ error: "유효하지 않은 id." }); return; }
  const reason = str(req.body?.reason) ?? "";
  try {
    const [existing] = await db.select().from(inquiriesTable).where(and(eq(inquiriesTable.id, id), isNull(inquiriesTable.deletedAt)));
    if (!existing) { res.status(404).json({ error: "의뢰건을 찾을 수 없습니다." }); return; }
    await db.update(inquiriesTable)
      .set({ deletedAt: new Date(), deletedBy: req.user?.id ?? null, deletionReason: reason || null, updatedAt: new Date() })
      .where(eq(inquiriesTable.id, id));
    await logEvent("inquiry", id, "inquiry_deleted", req.log, req.user ?? undefined, JSON.stringify(reason ? { reason } : {}));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Inquiries: delete failed");
    res.status(500).json({ error: "의뢰건 삭제 실패." });
  }
});

export default router;
