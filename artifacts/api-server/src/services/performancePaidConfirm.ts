// ─── 일반 수행정보 지급완료 확인(회차 밖 실제 지급 기록) ─────────────────────────────────────
//  지급회차·이체를 거치지 않고 이미 지급한 건을 담당자가 확인해 기록한다(송금 실행 아님).
//  대상: 과거 CRM 전환 행이 아닌 일반 수행정보 중 '미지급' + 지급회차 미배정 건만.
//  기록: payment_status=paid · status=paid · 실제 지급일·지급액. 지급회차·이체·정산 레코드는 만들지 않는다.
//  지급예정일·원가·원천세 등 기존 값은 바꾸지 않는다. 확인자·일시·근거(선택)는 호출측 감사로그에 남긴다.
import { db, performanceAssignmentsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

export class PaidConfirmError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function confirmRegularPaid(assignmentId: number, paid: { actualPaymentDate: string; actualPaymentAmount: number }, performer: { id: number | null }) {
  return db.transaction(async (tx: any) => {
    const [a] = await tx.select().from(performanceAssignmentsTable).where(eq(performanceAssignmentsTable.id, assignmentId)).for("update");
    if (!a || a.deletedAt) throw new PaidConfirmError(404, "수행정보를 찾을 수 없습니다.");
    if (a.paymentStatus === "paid") throw new PaidConfirmError(409, "이미 지급완료된 수행정보입니다.");
    if (a.paymentStatus !== "unpaid") throw new PaidConfirmError(409, "미지급 상태인 건만 지급완료 확인할 수 있습니다(지급보류·처리중 건 제외).");
    if (a.payoutRoundId != null) throw new PaidConfirmError(409, "지급회차에 배정된 건은 정산 화면의 지급회차에서 처리하세요.");
    await tx.update(performanceAssignmentsTable).set({
      paymentStatus: "paid", status: "paid",
      actualPaymentDate: paid.actualPaymentDate, actualPaymentAmount: String(paid.actualPaymentAmount),
      updatedBy: performer.id ?? null, updatedAt: new Date(),
    }).where(eq(performanceAssignmentsTable.id, assignmentId));
    return { projectId: a.projectId as number, performerName: a.performerNameSnapshot ?? null,
      before: { paymentStatus: a.paymentStatus, status: a.status, costTotal: a.costTotal, expectedPaymentDate: a.expectedPaymentDate, actualPaymentDate: a.actualPaymentDate, actualPaymentAmount: a.actualPaymentAmount } };
  });
}

/** 과거 CRM 전환 수행정보(확인 대기 대상 계보)인지 — 그런 행은 기존 과거 지급 확인 경로로 처리 */
export async function isLegacyActivationRow(assignmentId: number): Promise<boolean> {
  const r = await db.execute(sql`SELECT 1 FROM import_row_sources WHERE module = 'legacy_sale_activation' AND row_key LIKE 'progress:%' AND entity_id = ${assignmentId} LIMIT 1`);
  return (r.rows as unknown[]).length > 0;
}
