import { Router, type IRouter } from "express";
import {
  db, tasksTable, projectsTable, usersTable, paymentsTable,
  settlementsTable, translatorSensitiveTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logEvent } from "../lib/logEvent";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();

// ── 지급 예정일 계산 (한국 기준) ──────────────────────────────────────────────
// 1~15일 완료 → 해당월 말일, 16~31일 완료 → 다음달 15일
function calcPayoutDueDate(completedAt: Date): string {
  // KST = UTC+9
  const kst = new Date(completedAt.getTime() + 9 * 60 * 60 * 1000);
  const day = kst.getUTCDate();
  const month = kst.getUTCMonth(); // 0-indexed
  const year = kst.getUTCFullYear();

  if (day >= 1 && day <= 15) {
    // 해당 월 말일
    const lastDay = new Date(Date.UTC(year, month + 1, 0));
    return `${lastDay.getUTCFullYear()}-${String(lastDay.getUTCMonth() + 1).padStart(2, "0")}-${String(lastDay.getUTCDate()).padStart(2, "0")}`;
  } else {
    // 다음달 15일
    const nextMonth = month + 1;
    const nextYear = nextMonth > 11 ? year + 1 : year;
    const nm = nextMonth > 11 ? 0 : nextMonth;
    return `${nextYear}-${String(nm + 1).padStart(2, "0")}-15`;
  }
}

// ── 세금 계산 ─────────────────────────────────────────────────────────────────
type SettlementType = "WITHHOLDING_3_3" | "VAT_INVOICE" | "OVERSEAS_REMITTANCE" | "OTHER_REVIEW";

function calcTax(type: SettlementType, gross: number) {
  let withholdingRate = 0;
  let withholdingAmount = 0;
  let vatAmount = 0;
  let netAmount = gross;

  if (type === "WITHHOLDING_3_3") {
    withholdingRate = 3.3;
    withholdingAmount = Math.round(gross * 0.033 * 100) / 100;
    netAmount = Math.round((gross - withholdingAmount) * 100) / 100;
  } else if (type === "VAT_INVOICE") {
    vatAmount = Math.round(gross * 0.1 * 100) / 100;
    netAmount = gross; // VAT는 별도 청구이므로 실지급액은 gross
  } else {
    // OVERSEAS_REMITTANCE, OTHER_REVIEW: 수수료/환율 미적용, gross = net
    netAmount = gross;
  }

  return {
    withholdingRate: withholdingRate.toFixed(4),
    withholdingAmount: withholdingAmount.toFixed(2),
    vatAmount: vatAmount.toFixed(2),
    netAmount: netAmount.toFixed(2),
  };
}

// ── 정산 유형 분류 ────────────────────────────────────────────────────────────
function classifySettlementType(paymentMethod: string | null | undefined): SettlementType {
  if (!paymentMethod) return "OTHER_REVIEW";
  switch (paymentMethod) {
    case "domestic_withholding": return "WITHHOLDING_3_3";
    case "domestic_business":   return "VAT_INVOICE";
    case "overseas_paypal":
    case "overseas_bank":       return "OVERSEAS_REMITTANCE";
    default:                    return "OTHER_REVIEW";
  }
}

// ── 정산 상태 자동 분류 ───────────────────────────────────────────────────────
function classifyStatus(
  type: SettlementType,
  sensitive: { bankAccount?: string | null; accountHolder?: string | null; paymentHold?: boolean | null } | null | undefined,
  grossAmount: number,
): { status: "ready" | "pending_review"; reviewReason: string | null } {
  const reasons: string[] = [];

  if (grossAmount <= 0) reasons.push("금액이 0 이하");
  if (!sensitive) reasons.push("지급 정보 없음");
  else {
    if (sensitive.paymentHold) reasons.push("지급 보류 상태");
    if (!sensitive.bankAccount) reasons.push("지급 계좌 확인 필요");
  }
  if (type === "OVERSEAS_REMITTANCE") reasons.push("해외 송금 대상");
  if (type === "VAT_INVOICE") reasons.push("세금계산서 검토 필요");
  if (type === "OTHER_REVIEW") reasons.push("세금 유형 검토 필요");

  if (reasons.length > 0) {
    return { status: "pending_review", reviewReason: reasons.join(" / ") };
  }
  return { status: "ready", reviewReason: null };
}

// ── 핵심 정산 자동 생성 함수 ──────────────────────────────────────────────────
async function autoCreateSettlement(
  taskId: number,
  projectId: number,
  translatorId: number,
  completedAt: Date,
  log: typeof console,
) {
  // 중복 방지: taskId 기준
  const [existingByTask] = await db
    .select({ id: settlementsTable.id })
    .from(settlementsTable)
    .where(eq(settlementsTable.taskId, taskId));
  if (existingByTask) {
    log.info({ taskId }, "Settlement already exists for task, skipping");
    return;
  }

  // 번역사 정보
  const [translator] = await db
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, translatorId));

  // 지급 정보 (민감정보)
  const [sensitive] = await db
    .select()
    .from(translatorSensitiveTable)
    .where(eq(translatorSensitiveTable.translatorId, translatorId));

  // 결제 금액
  const [payment] = await db
    .select()
    .from(paymentsTable)
    .where(eq(paymentsTable.projectId, projectId));

  const gross = payment ? Number(payment.amount) : 0;

  // 정산 유형 분류
  const settlementType = classifySettlementType(sensitive?.paymentMethod);

  // 세금 계산
  const tax = calcTax(settlementType, gross);

  // 지급 예정일
  const payoutDueDate = calcPayoutDueDate(completedAt);

  // 상태 자동 분류
  const { status, reviewReason } = classifyStatus(settlementType, sensitive, gross);

  // 은행 정보 스냅샷 (생성 시점 고정)
  const bankInfoSnapshot = sensitive ? {
    paymentMethod: sensitive.paymentMethod,
    bankName: sensitive.bankName,
    bankAccount: sensitive.bankAccount ? "***" + sensitive.bankAccount.slice(-4) : null,
    accountHolder: sensitive.accountHolder,
    businessNumber: sensitive.businessNumber ?? null,
    businessName: sensitive.businessName ?? null,
    country: sensitive.country ?? null,
    currency: sensitive.currency ?? null,
    swiftCode: sensitive.swiftCode ?? null,
    paypalEmail: sensitive.paypalEmail ? "***" : null,
  } : null;

  // 기존 호환 금액 (translatorAmount = 70%, platformFee = 30%)
  const translatorAmount = Math.round(gross * 0.7 * 100) / 100;
  const platformFee = Math.round(gross * 0.3 * 100) / 100;

  const [settlement] = await db
    .insert(settlementsTable)
    .values({
      projectId,
      taskId,
      translatorId,
      paymentId: payment?.id ?? null,
      translatorName: translator?.name ?? null,
      bankInfoSnapshot,

      totalAmount: gross.toFixed(2),
      translatorAmount: translatorAmount.toFixed(2),
      platformFee: platformFee.toFixed(2),

      grossAmount: gross.toFixed(2),
      netAmount: tax.netAmount,

      settlementType,
      withholdingRate: tax.withholdingRate,
      withholdingAmount: tax.withholdingAmount,
      vatAmount: tax.vatAmount,

      paymentMethod: sensitive?.paymentMethod ?? null,
      payoutDueDate,

      status,
      reviewReason,
      isAutoGenerated: true,
    })
    .returning();

  await logEvent("project", projectId, "settlement_auto_created", log as any);
  await logEvent("project", projectId,
    status === "ready" ? "settlement_marked_ready" : "settlement_marked_review", log as any);

  log.info(
    { settlementId: settlement.id, projectId, taskId, type: settlementType, status, payoutDueDate },
    "Settlement auto-created",
  );
}

// ── 작업 목록 ─────────────────────────────────────────────────────────────────
router.get("/tasks", async (req, res) => {
  try {
    const { translatorId } = req.query as { translatorId?: string };
    let query = db.select({
      id: tasksTable.id,
      projectId: tasksTable.projectId,
      translatorId: tasksTable.translatorId,
      status: tasksTable.status,
      createdAt: tasksTable.createdAt,
      projectTitle: projectsTable.title,
      projectStatus: projectsTable.status,
    })
    .from(tasksTable)
    .leftJoin(projectsTable, eq(tasksTable.projectId, projectsTable.id))
    .$dynamic();

    if (translatorId) {
      const id = Number(translatorId);
      if (!isNaN(id)) query = query.where(eq(tasksTable.translatorId, id));
    }
    res.json(await query);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch tasks");
    res.status(500).json({ error: "작업 조회 실패." });
  }
});

// ── 번역사 배정 ───────────────────────────────────────────────────────────────
router.post(
  "/projects/:id/match",
  requireAuth,
  requireRole("admin", "customer"),
  async (req, res) => {
    const projectId = Number(req.params.id);
    if (isNaN(projectId) || projectId <= 0) {
      res.status(400).json({ error: "유효하지 않은 project id." });
      return;
    }

    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
    if (!project) {
      res.status(404).json({ error: `Project ${projectId} not found.` });
      return;
    }
    if (project.status !== "paid") {
      res.status(400).json({ error: `매칭하려면 결제가 완료된 "paid" 상태여야 합니다. 현재: "${project.status}"` });
      return;
    }

    const existingTask = await db.select().from(tasksTable).where(eq(tasksTable.projectId, projectId));
    if (existingTask.length > 0) {
      res.status(400).json({ error: "이미 번역사가 배정된 프로젝트입니다." });
      return;
    }

    const translators = await db.select().from(usersTable).where(eq(usersTable.role, "translator"));
    if (translators.length === 0) {
      res.status(404).json({ error: "등록된 번역사가 없습니다." });
      return;
    }

    const randomTranslator = translators[Math.floor(Math.random() * translators.length)];

    try {
      const result = await db.transaction(async (tx) => {
        const [task] = await tx
          .insert(tasksTable)
          .values({ projectId, translatorId: randomTranslator.id })
          .returning();
        await tx.update(projectsTable).set({ status: "matched" }).where(eq(projectsTable.id, projectId));
        return task;
      });
      await logEvent("project", projectId, "project_matched", req.log);
      res.status(201).json(result);
    } catch (err) {
      req.log.error({ err }, "Failed to match project");
      res.status(500).json({ error: "매칭 실패." });
    }
  },
);

// ── 작업 시작 ─────────────────────────────────────────────────────────────────
router.patch(
  "/tasks/:id/start",
  requireAuth,
  requireRole("translator", "admin"),
  async (req, res) => {
    const taskId = Number(req.params.id);
    if (isNaN(taskId) || taskId <= 0) {
      res.status(400).json({ error: "유효하지 않은 task id." });
      return;
    }

    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    if (!task) {
      res.status(404).json({ error: `Task ${taskId} not found.` });
      return;
    }
    if (task.status === "working" || task.status === "done") {
      res.status(400).json({ error: `이미 "${task.status}" 상태입니다.` });
      return;
    }
    if (req.user!.role === "translator" && task.translatorId !== req.user!.id) {
      res.status(403).json({ error: "본인에게 배정된 작업만 시작할 수 있습니다." });
      return;
    }

    try {
      const result = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(tasksTable).set({ status: "working" })
          .where(eq(tasksTable.id, taskId)).returning();
        await tx.update(projectsTable).set({ status: "in_progress" }).where(eq(projectsTable.id, task.projectId));
        return updated;
      });
      await logEvent("task", taskId, "task_started", req.log);
      res.json(result);
    } catch (err) {
      req.log.error({ err }, "Failed to start task");
      res.status(500).json({ error: "작업 시작 실패." });
    }
  },
);

// ── 작업 완료 (정산 자동 생성 트리거) ────────────────────────────────────────
router.patch(
  "/tasks/:id/complete",
  requireAuth,
  requireRole("translator", "admin"),
  async (req, res) => {
    const taskId = Number(req.params.id);
    if (isNaN(taskId) || taskId <= 0) {
      res.status(400).json({ error: "유효하지 않은 task id." });
      return;
    }

    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    if (!task) {
      res.status(404).json({ error: `Task ${taskId} not found.` });
      return;
    }
    if (task.status === "done") {
      res.status(400).json({ error: "이미 완료된 작업입니다." });
      return;
    }
    if (task.status !== "working") {
      res.status(400).json({ error: `완료하려면 "working" 상태여야 합니다. 현재: "${task.status}"` });
      return;
    }
    if (req.user!.role === "translator" && task.translatorId !== req.user!.id) {
      res.status(403).json({ error: "본인에게 배정된 작업만 완료할 수 있습니다." });
      return;
    }

    const completedAt = new Date();

    try {
      const result = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(tasksTable).set({ status: "done" })
          .where(eq(tasksTable.id, taskId)).returning();
        await tx.update(projectsTable).set({ status: "completed" }).where(eq(projectsTable.id, task.projectId));
        return updated;
      });
      await logEvent("task", taskId, "task_completed", req.log);

      // 정산 자동 생성 (비동기, 응답 차단 없이)
      autoCreateSettlement(
        taskId,
        task.projectId,
        task.translatorId,
        completedAt,
        req.log as any,
      ).catch(err => {
        req.log.error({ err, taskId }, "Settlement auto-create failed");
      });

      res.json(result);
    } catch (err) {
      req.log.error({ err }, "Failed to complete task");
      res.status(500).json({ error: "작업 완료 실패." });
    }
  },
);

export default router;
