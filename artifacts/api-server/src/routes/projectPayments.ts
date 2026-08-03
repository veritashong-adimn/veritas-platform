// ─────────────────────────────────────────────────────────────────────────────
// 결제정보 (고객 수금) API — 프로젝트별 고객 결제 현황.
//  · 고객→우리 수금 기록(통번역사 지급 settlements 와는 별개).
//  · GET 프로젝트 상세(admin.ts)에서 paymentRecords[] 로 함께 반환 → 별도 조회 엔드포인트 불필요.
//  · 배치 저장(rows + deletedIds)만 제공. 회차(sequence)는 서버에서 순서대로 자동번호.
//  · 미수금은 저장하지 않고 화면에서 계산(총 판매금액 − 총 입금액).
// ─────────────────────────────────────────────────────────────────────────────
import { Router, type IRouter } from "express";
import { db, projectPaymentsTable, companiesTable, contactsTable } from "@workspace/db";
import { eq, and, inArray, getTableColumns } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

// 프로젝트 상세 응답에 포함 — 회차 오름차순. 청구업체·담당자 이름 조인(표시용).
export async function loadPaymentRecords(projectId: number) {
  return db
    .select({
      ...getTableColumns(projectPaymentsTable),
      billingCompanyName: companiesTable.name,
      billingContactName: contactsTable.name,
    })
    .from(projectPaymentsTable)
    .leftJoin(companiesTable, eq(projectPaymentsTable.billingCompanyId, companiesTable.id))
    .leftJoin(contactsTable, eq(projectPaymentsTable.billingContactId, contactsTable.id))
    .where(eq(projectPaymentsTable.projectId, projectId))
    .orderBy(projectPaymentsTable.sequence);
}

const PAYMENT_TYPE = ["advance", "interim", "balance", "lump_sum", "other"] as const;
const DEPOSIT_STATUS = ["scheduled", "partial", "completed", "unpaid"] as const;

const rowSchema = z.object({
  id: z.number().int().optional(),
  issueDate: z.string().nullable().optional(),      // 발행일 — 세금계산서 발행일(세금계산서일 때만)
  expectedDate: z.string().nullable().optional(),   // 입금예정일
  paidDate: z.string().nullable().optional(),       // 입금일
  paymentType: z.enum(PAYMENT_TYPE).nullable().optional(),
  paymentMethod: z.string().max(100).nullable().optional(),   // 결제방법 — 자유 입력(text). 기본 4개 라벨 또는 사용자 직접입력.
  supplyAmount: z.coerce.number().min(0).nullable().optional(),
  vatAmount: z.coerce.number().min(0).nullable().optional(),
  amount: z.coerce.number().min(0).nullable().optional(),
  depositStatus: z.enum(DEPOSIT_STATUS).nullable().optional(),
  paymentCategory: z.string().max(50).nullable().optional(),   // 결제유형: 일반결제 · 수출바우처(자유 확장)
  payer: z.string().max(100).nullable().optional(),            // 입금주체: 고객사 · 수출바우처 운영기관
  depositItem: z.string().max(50).nullable().optional(),       // 입금항목: 공급가액 · 부가세 · 전체금액
  billingCompanyId: z.number().int().nullable().optional(),    // 청구업체
  billingContactId: z.number().int().nullable().optional(),    // 담당자
  note: z.string().nullable().optional(),
});
const batchSchema = z.object({
  rows: z.array(rowSchema),
  deletedIds: z.array(z.number().int()).default([]),
});

// 배치 저장 — 삭제 후 upsert. 회차는 전송된 순서대로 1..N 재부여(자동번호).
router.put("/admin/projects/:id/payment-records", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId) || projectId <= 0) { res.status(400).json({ error: "잘못된 프로젝트 ID" }); return; }
  const parsed = batchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "유효성 검증 실패", detail: parsed.error.flatten() }); return; }
  const { rows, deletedIds } = parsed.data;
  const userId = req.user?.id ?? null;

  try {
    await db.transaction(async (tx) => {
      if (deletedIds.length) {
        await tx.delete(projectPaymentsTable)
          .where(and(eq(projectPaymentsTable.projectId, projectId), inArray(projectPaymentsTable.id, deletedIds)));
      }
      let seq = 1;
      for (const r of rows) {
        const values = {
          sequence: seq++,                         // 회차 자동번호(프로젝트별, 순서 기준)
          issueDate: r.issueDate || null,
          expectedDate: r.expectedDate || null,
          paidDate: r.paidDate || null,
          paymentType: r.paymentType ?? null,
          paymentMethod: r.paymentMethod ?? null,
          supplyAmount: String(r.supplyAmount ?? 0),
          vatAmount: String(r.vatAmount ?? 0),
          amount: String(r.amount ?? 0),
          depositStatus: r.depositStatus ?? "scheduled",
          paymentCategory: r.paymentCategory ?? "일반결제",
          payer: r.payer ?? null,
          depositItem: r.depositItem ?? null,
          billingCompanyId: r.billingCompanyId ?? null,
          billingContactId: r.billingContactId ?? null,
          note: r.note ?? null,
          updatedBy: userId,
          updatedAt: new Date(),
        };
        if (r.id) {
          await tx.update(projectPaymentsTable).set(values)
            .where(and(eq(projectPaymentsTable.id, r.id), eq(projectPaymentsTable.projectId, projectId)));
        } else {
          await tx.insert(projectPaymentsTable).values({ projectId, createdBy: userId, ...values });
        }
      }
    });
    res.json({ rows: await loadPaymentRecords(projectId) });
  } catch (err) {
    req.log.error({ err }, "결제정보 저장 실패");
    res.status(500).json({ error: "결제정보 저장 중 오류가 발생했습니다." });
  }
});

export default router;
