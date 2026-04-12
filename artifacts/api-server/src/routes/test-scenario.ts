/**
 * test-scenario.ts
 *
 * 운영 시나리오 테스트 API
 * POST /api/admin/test/run-scenario  — 전체 프로젝트 생애주기 자동 실행
 * GET  /api/admin/test/scenarios     — 과거 시나리오 실행 기록
 * POST /api/admin/feedback           — UX 피드백 메모 등록
 * GET  /api/admin/feedback           — UX 피드백 목록
 */

import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import {
  db,
  projectsTable, quotesTable, paymentsTable, settlementsTable,
  tasksTable, logsTable, notesTable, usersTable,
  companiesTable, contactsTable, translatorProfilesTable,
} from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

// ────────────────────────────────────────────────────────────────────────────
// 내부 헬퍼 타입
// ────────────────────────────────────────────────────────────────────────────

type StepStatus = "ok" | "error" | "skipped";

interface StepResult {
  step: number;
  name: string;
  status: StepStatus;
  detail: string;
  data?: Record<string, unknown>;
}

/** 단일 시나리오 실행 결과 누적 클래스 */
class ScenarioRunner {
  private steps: StepResult[] = [];
  private _aborted = false;
  private projectId?: number;

  get aborted() { return this._aborted; }
  get results() { return this.steps; }
  get currentProjectId() { return this.projectId; }

  setProjectId(id: number) { this.projectId = id; }

  ok(step: number, name: string, detail: string, data?: Record<string, unknown>) {
    this.steps.push({ step, name, status: "ok", detail, data });
  }

  fail(step: number, name: string, detail: string, abort = true) {
    this.steps.push({ step, name, status: "error", detail });
    if (abort) this._aborted = true;
  }

  skip(step: number, name: string, reason: string) {
    this.steps.push({ step, name, status: "skipped", detail: reason });
  }

  summary() {
    const ok = this.steps.filter(s => s.status === "ok").length;
    const err = this.steps.filter(s => s.status === "error").length;
    const skipped = this.steps.filter(s => s.status === "skipped").length;
    return { total: this.steps.length, ok, error: err, skipped };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// POST /api/admin/test/run-scenario
// ────────────────────────────────────────────────────────────────────────────

router.post("/admin/test/run-scenario", ...adminGuard, async (req, res) => {
  const adminUser = (req as any).user as { id: number; email: string };
  const { quoteAmount = 500000, translatorRatio = 0.6, companyId, contactId } = req.body as {
    quoteAmount?: number;
    translatorRatio?: number;
    companyId?: number;
    contactId?: number;
  };

  const runner = new ScenarioRunner();
  const startedAt = new Date();
  const scenarioLabel = `[테스트] 시나리오 ${startedAt.toLocaleString("ko-KR")}`;

  // ── Step 1: 프로젝트 생성 ─────────────────────────────────────────────
  try {
    // 실제 거래처 데이터 검증
    let resolvedCompanyId: number | null = null;
    let resolvedContactId: number | null = null;
    if (companyId) {
      const [co] = await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, companyId));
      if (co) { resolvedCompanyId = co.id; }
    }
    if (contactId) {
      const [ct] = await db.select({ id: contactsTable.id }).from(contactsTable).where(eq(contactsTable.id, contactId));
      if (ct) { resolvedContactId = ct.id; }
    }

    const [project] = await db.insert(projectsTable).values({
      userId: adminUser.id,
      title: scenarioLabel,
      adminId: adminUser.id,
      ...(resolvedCompanyId ? { companyId: resolvedCompanyId } : {}),
      ...(resolvedContactId ? { contactId: resolvedContactId } : {}),
    }).returning();

    runner.setProjectId(project.id);
    await logEvent("project", project.id, "scenario_project_created");
    const suffix = resolvedCompanyId ? ` (거래처 #${resolvedCompanyId} 연결)` : " (테스트 데이터)";
    runner.ok(1, "프로젝트 생성", `#${project.id} "${project.title}" 생성 완료${suffix}`, { projectId: project.id });
  } catch (err: any) {
    runner.fail(1, "프로젝트 생성", `실패: ${err?.message ?? String(err)}`);
    return res.status(200).json(buildResponse(runner, startedAt));
  }

  const projectId = runner.currentProjectId!;

  // ── Step 2: 견적 생성 (created → quoted) ─────────────────────────────
  if (!runner.aborted) {
    try {
      const [project] = await db.select({ status: projectsTable.status }).from(projectsTable).where(eq(projectsTable.id, projectId));
      if (project.status !== "created") throw new Error(`예상 상태 "created", 현재 "${project.status}"`);

      const [quote] = await db.transaction(async tx => {
        const q = await tx.insert(quotesTable).values({
          projectId,
          price: String(Number(quoteAmount)),
          status: "sent",
        }).returning();
        await tx.update(projectsTable).set({ status: "quoted" }).where(eq(projectsTable.id, projectId));
        return q;
      });

      await logEvent("project", projectId, "scenario_quote_created");
      runner.ok(2, "견적 생성", `견적 #${quote.id} — ${Number(quoteAmount).toLocaleString("ko-KR")}원`, {
        quoteId: quote.id, amount: Number(quoteAmount),
      });
    } catch (err: any) {
      runner.fail(2, "견적 생성", `실패: ${err?.message ?? String(err)}`);
    }
  } else {
    runner.skip(2, "견적 생성", "이전 단계 실패로 건너뜀");
  }

  // ── Step 3: 견적 승인 (quoted → approved) ────────────────────────────
  if (!runner.aborted) {
    try {
      const [project] = await db.select({ status: projectsTable.status }).from(projectsTable).where(eq(projectsTable.id, projectId));
      if (project.status !== "quoted") throw new Error(`예상 상태 "quoted", 현재 "${project.status}"`);

      await db.transaction(async tx => {
        await tx.update(projectsTable).set({ status: "approved" }).where(eq(projectsTable.id, projectId));
        await tx.update(quotesTable).set({ status: "approved" }).where(eq(quotesTable.projectId, projectId));
      });

      await logEvent("project", projectId, "scenario_quote_approved");
      runner.ok(3, "견적 승인", `프로젝트 상태 → approved, 견적 상태 → approved`);
    } catch (err: any) {
      runner.fail(3, "견적 승인", `실패: ${err?.message ?? String(err)}`);
    }
  } else {
    runner.skip(3, "견적 승인", "이전 단계 실패로 건너뜀");
  }

  // ── Step 4: 결제 등록 (approved → paid) ──────────────────────────────
  let paymentId: number | undefined;
  if (!runner.aborted) {
    try {
      const [project] = await db.select({ status: projectsTable.status }).from(projectsTable).where(eq(projectsTable.id, projectId));
      if (project.status !== "approved") throw new Error(`예상 상태 "approved", 현재 "${project.status}"`);

      const [payment] = await db.transaction(async tx => {
        const p = await tx.insert(paymentsTable).values({
          projectId,
          amount: String(Number(quoteAmount)),
          status: "paid",
        }).returning();
        await tx.update(projectsTable).set({ status: "paid" }).where(eq(projectsTable.id, projectId));
        return p;
      });

      paymentId = payment.id;
      await logEvent("project", projectId, "scenario_payment_received");
      runner.ok(4, "결제 등록", `결제 #${payment.id} — ${Number(quoteAmount).toLocaleString("ko-KR")}원`, {
        paymentId: payment.id,
      });
    } catch (err: any) {
      runner.fail(4, "결제 등록", `실패: ${err?.message ?? String(err)}`);
    }
  } else {
    runner.skip(4, "결제 등록", "이전 단계 실패로 건너뜀");
  }

  // ── Step 5: 번역사 배정 (paid → matched) ─────────────────────────────
  let translatorId: number | undefined;
  if (!runner.aborted) {
    try {
      const translators = await db.select({ id: usersTable.id, email: usersTable.email })
        .from(usersTable)
        .where(and(eq(usersTable.role, "translator"), eq(usersTable.isActive, true)));

      if (translators.length === 0) throw new Error("활성 상태의 번역사가 없습니다. 시드 데이터를 확인해 주세요.");

      const chosen = translators[Math.floor(Math.random() * translators.length)];
      translatorId = chosen.id;

      const [task] = await db.transaction(async tx => {
        const t = await tx.insert(tasksTable).values({
          projectId,
          translatorId: chosen.id,
        }).returning();
        await tx.update(projectsTable).set({ status: "matched" }).where(eq(projectsTable.id, projectId));
        return t;
      });

      await logEvent("project", projectId, `scenario_translator_matched_${chosen.id}`);
      runner.ok(5, "번역사 배정", `번역사 #${chosen.id} (${chosen.email}) → task #${task.id}`, {
        translatorId: chosen.id, taskId: task.id,
      });
    } catch (err: any) {
      runner.fail(5, "번역사 배정", `실패: ${err?.message ?? String(err)}`);
    }
  } else {
    runner.skip(5, "번역사 배정", "이전 단계 실패로 건너뜀");
  }

  // ── Step 6: 작업 시작 (matched → in_progress) ─────────────────────────
  if (!runner.aborted) {
    try {
      await db.update(projectsTable).set({ status: "in_progress" }).where(eq(projectsTable.id, projectId));
      await logEvent("project", projectId, "scenario_status_in_progress");
      runner.ok(6, "작업 시작", "프로젝트 상태 → in_progress");
    } catch (err: any) {
      runner.fail(6, "작업 시작", `실패: ${err?.message ?? String(err)}`);
    }
  } else {
    runner.skip(6, "작업 시작", "이전 단계 실패로 건너뜀");
  }

  // ── Step 7: 작업 완료 (in_progress → completed) ───────────────────────
  if (!runner.aborted) {
    try {
      await db.transaction(async tx => {
        await tx.update(projectsTable).set({ status: "completed" }).where(eq(projectsTable.id, projectId));
        await tx.update(tasksTable).set({ status: "done" }).where(eq(tasksTable.projectId, projectId));
      });
      await logEvent("project", projectId, "scenario_status_completed");
      runner.ok(7, "작업 완료", "프로젝트 상태 → completed, 태스크 상태 → done");
    } catch (err: any) {
      runner.fail(7, "작업 완료", `실패: ${err?.message ?? String(err)}`);
    }
  } else {
    runner.skip(7, "작업 완료", "이전 단계 실패로 건너뜀");
  }

  // ── Step 8: 정산 생성 ──────────────────────────────────────────────────
  let settlementId: number | undefined;
  if (!runner.aborted) {
    try {
      if (!translatorId) throw new Error("번역사 ID를 확인할 수 없습니다.");

      const total = Number(quoteAmount);
      const tAmt = Math.round(total * Math.min(1, Math.max(0, Number(translatorRatio))));
      const fee = total - tAmt;

      const [settlement] = await db.insert(settlementsTable).values({
        projectId,
        translatorId,
        paymentId: paymentId ?? null,
        totalAmount: String(total),
        translatorAmount: String(tAmt),
        platformFee: String(fee),
        status: "ready",
      }).returning();

      settlementId = settlement.id;
      await logEvent("project", projectId, "scenario_settlement_created");
      runner.ok(8, "정산 생성", `정산 #${settlement.id} — 번역사 ${tAmt.toLocaleString("ko-KR")}원 / 플랫폼 ${fee.toLocaleString("ko-KR")}원`, {
        settlementId: settlement.id, translatorAmount: tAmt, platformFee: fee,
      });
    } catch (err: any) {
      runner.fail(8, "정산 생성", `실패: ${err?.message ?? String(err)}`, false);
    }
  } else {
    runner.skip(8, "정산 생성", "이전 단계 실패로 건너뜀");
  }

  // ── Step 9: 정산 지급 완료 ────────────────────────────────────────────
  if (!runner.aborted && settlementId) {
    try {
      await db.update(settlementsTable).set({ status: "paid" }).where(eq(settlementsTable.id, settlementId));
      await logEvent("project", projectId, "scenario_settlement_paid");
      runner.ok(9, "정산 지급 완료", `정산 #${settlementId} → paid`);
    } catch (err: any) {
      runner.fail(9, "정산 지급 완료", `실패: ${err?.message ?? String(err)}`, false);
    }
  } else if (!runner.aborted) {
    runner.skip(9, "정산 지급 완료", "정산 미생성으로 건너뜀");
  } else {
    runner.skip(9, "정산 지급 완료", "이전 단계 실패로 건너뜀");
  }

  // ── 로그 검증 ─────────────────────────────────────────────────────────
  try {
    const logs = await db.select().from(logsTable).where(
      and(eq(logsTable.entityType, "project"), eq(logsTable.entityId, projectId))
    ).orderBy(logsTable.createdAt);

    runner.ok(10, "로그 검증", `총 ${logs.length}개 이벤트 기록 확인`, {
      logs: logs.map(l => ({ action: l.action, at: l.createdAt })),
    });
  } catch (err: any) {
    runner.fail(10, "로그 검증", `실패: ${err?.message ?? String(err)}`, false);
  }

  req.log.info({ projectId, summary: runner.summary() }, "Scenario run completed");
  res.status(200).json(buildResponse(runner, startedAt));
});

function buildResponse(runner: ScenarioRunner, startedAt: Date) {
  return {
    projectId: runner.currentProjectId ?? null,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    steps: runner.results,
    summary: runner.summary(),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/admin/test/scenarios  — 시나리오 테스트 프로젝트 목록
// ────────────────────────────────────────────────────────────────────────────

router.get("/admin/test/scenarios", ...adminGuard, async (req, res) => {
  try {
    const rows = await db
      .select({
        id: projectsTable.id,
        title: projectsTable.title,
        status: projectsTable.status,
        createdAt: projectsTable.createdAt,
      })
      .from(projectsTable)
      .where(eq(projectsTable.title, "[테스트]"))
      .orderBy(desc(projectsTable.createdAt))
      .limit(50);

    const scenarioProjects = await db
      .select({
        id: projectsTable.id,
        title: projectsTable.title,
        status: projectsTable.status,
        createdAt: projectsTable.createdAt,
      })
      .from(projectsTable)
      .orderBy(desc(projectsTable.createdAt))
      .limit(200);

    const filtered = scenarioProjects.filter(p => p.title.startsWith("[테스트]"));
    res.json(filtered);
  } catch (err) {
    req.log.error({ err }, "Failed to list scenario projects");
    res.status(500).json({ error: "시나리오 목록 조회 실패." });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// UX 피드백 메모 (notesTable entityType=project, entityId=0 특별 값)
// entityId=0 : 전역 UX 피드백 센티넬 값 (실제 project와 충돌 없음)
// ────────────────────────────────────────────────────────────────────────────

const FEEDBACK_ENTITY_ID = 0;

router.post("/admin/feedback", ...adminGuard, async (req, res) => {
  const adminUser = (req as any).user as { id: number };
  const { content, tag } = req.body as { content?: string; tag?: string };

  if (!content?.trim()) {
    res.status(400).json({ error: "피드백 내용을 입력해 주세요." });
    return;
  }

  const VALID_TAGS = ["bug", "ux", "idea", "urgent", "general"];
  const safeTag = tag && VALID_TAGS.includes(tag) ? tag : "general";

  try {
    const [note] = await db.insert(notesTable).values({
      entityType: "project",
      entityId: FEEDBACK_ENTITY_ID,
      adminId: adminUser.id,
      content: content.trim(),
      tag: safeTag,
    }).returning();

    res.status(201).json(note);
  } catch (err) {
    req.log.error({ err }, "Failed to save UX feedback");
    res.status(500).json({ error: "피드백 저장 실패." });
  }
});

router.get("/admin/feedback", ...adminGuard, async (req, res) => {
  try {
    const rows = await db
      .select({
        id: notesTable.id,
        content: notesTable.content,
        tag: notesTable.tag,
        createdAt: notesTable.createdAt,
        adminId: notesTable.adminId,
        adminEmail: usersTable.email,
      })
      .from(notesTable)
      .leftJoin(usersTable, eq(notesTable.adminId, usersTable.id))
      .where(and(
        eq(notesTable.entityType, "project"),
        eq(notesTable.entityId, FEEDBACK_ENTITY_ID),
      ))
      .orderBy(desc(notesTable.createdAt));

    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch UX feedback");
    res.status(500).json({ error: "피드백 목록 조회 실패." });
  }
});

router.delete("/admin/feedback/:id", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id) || id <= 0) { res.status(400).json({ error: "유효하지 않은 id." }); return; }

  try {
    await db.delete(notesTable).where(and(
      eq(notesTable.id, id),
      eq(notesTable.entityType, "project"),
      eq(notesTable.entityId, FEEDBACK_ENTITY_ID),
    ));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete UX feedback");
    res.status(500).json({ error: "피드백 삭제 실패." });
  }
});

// ── 실제 운영 데이터 조회 (시나리오 셀렉터용) ───────────────────────────────

router.get("/admin/test/real-data", ...adminGuard, async (req, res) => {
  try {
    const [companies, contacts, translators] = await Promise.all([
      db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable).orderBy(companiesTable.name),
      db.select({ id: contactsTable.id, name: contactsTable.name, companyId: contactsTable.companyId }).from(contactsTable).orderBy(contactsTable.name),
      db.select({ id: usersTable.id, email: usersTable.email })
        .from(usersTable)
        .innerJoin(translatorProfilesTable, eq(usersTable.id, translatorProfilesTable.userId))
        .orderBy(usersTable.email),
    ]);
    res.json({ companies, contacts, translators });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch real data for test tab");
    res.status(500).json({ error: "실제 데이터 조회 실패." });
  }
});

export default router;
