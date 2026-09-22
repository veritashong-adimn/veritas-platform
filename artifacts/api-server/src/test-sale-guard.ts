// 판매 Dependency Guard regression test — 현재 남아 있는 테스트 데이터를 fixture 로 사용하여
// A/B/C/D 등급 판정과 canCancel/canDelete 통제가 실제로 동작하는지 검증한다.
//
// [원칙] 이 스크립트는 Guard(evaluateProjectDependencies/evaluateQuoteDependencies)만 호출한다.
//        Guard 는 SELECT 전용이므로 DB 를 변경하지 않는다. 실행 전/후 주요 테이블 행수를 비교해
//        "검사만으로 DB 가 바뀌지 않음"(요구 ⑪)을 증명한다. 어떤 데이터도 삭제/수정하지 않는다.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { evaluateProjectDependencies, evaluateQuoteDependencies } from "./services/saleDependency";

// 전수조사에서 확정한 현재 테스트 데이터 기준 기대 등급(fixture).
const EXPECTED: Record<number, "A" | "B" | "C" | "D"> = {
  // A — 후속 데이터 없음
  70: "A", 71: "A", 72: "A", 137: "A", 138: "A", 139: "A", 140: "A", 187: "A",
  // B — 수행정보만 존재 / 금융거래 없음
  185: "B", 186: "B",
  // C — 미확정 금융자료(입금예정 scheduled / draft 지급회차)
  73: "C", 92: "C", 145: "C",
  // D — 확정 금융이력(입금확정 / 실입금 / 지급확정·완료)
  74: "D", 75: "D", 76: "D", 77: "D", 90: "D", 141: "D",
};

const COUNT_TABLES = [
  "quotes", "quote_items", "projects", "project_payments", "payment_transactions",
  "performance_assignments", "performance_expenses", "performance_deductions",
  "payout_rounds", "payout_round_items", "payout_transfers", "settlements",
];

async function snapshotCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of COUNT_TABLES) {
    const r = await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${t}`));
    out[t] = Number((r.rows?.[0] as any)?.n ?? 0);
  }
  return out;
}

async function main() {
  let pass = 0;
  let fail = 0;
  const fails: string[] = [];

  console.log("=== ⑪ Guard 실행 전 DB 스냅샷 ===");
  const before = await snapshotCounts();

  console.log("\n=== 프로젝트별 등급 판정(요구 ①~⑧) ===");
  const ids = Object.keys(EXPECTED).map(Number).sort((a, b) => a - b);
  for (const id of ids) {
    const rep = await evaluateProjectDependencies(id);
    const exp = EXPECTED[id];
    const ok = rep.grade === exp;
    // A/B → 취소·삭제 허용, C/D → 차단. (D는 확정, C는 미확정)
    const gateOk = (rep.grade === "A" || rep.grade === "B") ? (rep.canCancel && rep.canDelete) : (!rep.canCancel && !rep.canDelete);
    if (ok && gateOk) { pass++; } else { fail++; fails.push(`proj ${id}: expected ${exp} got ${rep.grade} (canCancel=${rep.canCancel},canDelete=${rep.canDelete})`); }
    const reasons = rep.blockingReasons.length ? `  ▸ ${rep.blockingReasons.join(" | ")}` : "";
    console.log(`  proj ${String(id).padStart(3)} [${project(rep.projectStatus)}] → ${rep.grade} ${ok && gateOk ? "✅" : "❌"} cancel=${b(rep.canCancel)} delete=${b(rep.canDelete)}${reasons}`);
  }

  console.log("\n=== ⑨ 견적 영구삭제 우회 차단 (D 프로젝트에 연결된 견적) ===");
  // proj 74(지급완료 D)의 견적 → 견적삭제/영구삭제도 canDelete=false 여야 함.
  const q74 = await db.execute(sql.raw(`SELECT id FROM quotes WHERE project_id = 74 LIMIT 1`));
  const q74Id = Number((q74.rows?.[0] as any)?.id);
  if (q74Id) {
    const qrep = await evaluateQuoteDependencies(q74Id);
    const ok = qrep.grade === "D" && !qrep.canDelete;
    if (ok) pass++; else { fail++; fails.push(`quote ${q74Id}(proj74): expected D/blocked got ${qrep.grade}/canDelete=${qrep.canDelete}`); }
    console.log(`  quote ${q74Id} (proj 74 연결) → ${qrep.grade} delete=${b(qrep.canDelete)} ${ok ? "✅" : "❌"}`);
  } else {
    console.log("  (proj 74 견적 없음 — skip)");
  }

  // 연결 프로젝트 없는 견적은 A(자유 삭제) — 우회가 아니라 정상.
  const qNull = await db.execute(sql.raw(`SELECT id FROM quotes WHERE project_id IS NULL AND deleted_at IS NULL LIMIT 1`));
  const qNullId = Number((qNull.rows?.[0] as any)?.id);
  if (qNullId) {
    const qrep = await evaluateQuoteDependencies(qNullId);
    const ok = qrep.grade === "A" && qrep.canDelete;
    if (ok) pass++; else { fail++; fails.push(`quote ${qNullId}(no project): expected A got ${qrep.grade}`); }
    console.log(`  quote ${qNullId} (프로젝트 미연결) → ${qrep.grade} delete=${b(qrep.canDelete)} ${ok ? "✅" : "❌"}`);
  }

  console.log("\n=== ⑫ 멱등성 — 동일 프로젝트 2회 검사 결과 일치 ===");
  const r1 = await evaluateProjectDependencies(76);
  const r2 = await evaluateProjectDependencies(76);
  const idem = JSON.stringify(r1) === JSON.stringify(r2);
  if (idem) pass++; else { fail++; fails.push("idempotency proj76 mismatch"); }
  console.log(`  proj 76 두 번 검사 동일: ${idem ? "✅" : "❌"}`);

  console.log("\n=== ⑪ Guard 실행 후 DB 스냅샷 비교(무부작용 증명) ===");
  const after = await snapshotCounts();
  let unchanged = true;
  for (const t of COUNT_TABLES) {
    if (before[t] !== after[t]) { unchanged = false; console.log(`  ❌ ${t}: ${before[t]} → ${after[t]}`); }
  }
  if (unchanged) { pass++; console.log("  모든 대상 테이블 행수 불변 ✅ (Guard 는 DB 를 변경하지 않음)"); }
  else { fail++; fails.push("DB mutated by guard"); }

  console.log(`\n=== 결과: ${pass} PASS / ${fail} FAIL ===`);
  if (fails.length) { console.log("실패 상세:"); fails.forEach(f => console.log("  - " + f)); }
  await db.$client.end?.().catch(() => {});
  process.exit(fail === 0 ? 0 : 1);
}

const b = (v: boolean) => (v ? "O" : "X");
const project = (s: string | null) => (s ?? "-").padEnd(9);

main().catch(async (err) => { console.error(err); process.exit(2); });
