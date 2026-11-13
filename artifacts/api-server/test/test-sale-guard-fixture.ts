// 판매 Dependency Guard — fixture 생성형 회귀 테스트(복제 DB veritas_inq_scratch 전용).
//  기존 test-sale-guard.ts 는 과거 특정 시점 DB 의 프로젝트 id(70~187)를 기대값으로 고정해, 그 데이터가 없는 DB 에서는
//  존재하지 않는 프로젝트 = A 로 판정되어 B/C/D 기대값이 실패한다(코드 문제 아님). 이 테스트는 같은 Guard 함수를
//  등급별 fixture 를 직접 만들어 검증한다. Guard 로직·기준은 변경하지 않는다. 끝나면 fixture 를 삭제한다.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { evaluateProjectDependencies, evaluateQuoteDependencies } from "../src/services/saleDependency";

if (!/\/veritas_inq_scratch(\?|$)/.test(process.env.DATABASE_URL ?? "")) { console.error("복제 DB(veritas_inq_scratch) 전용 테스트입니다."); process.exit(1); }
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: unknown = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✅" : "❌"} ${n}${ok ? "" : " — " + JSON.stringify(d)}`); };
const one = async (q: any) => ((await db.execute(q)).rows as any[])[0];

const pids: number[] = [], rounds: number[] = [];
const mkProject = async (tag: string, status = "approved") => {
  const [u] = (await db.execute(sql`SELECT id FROM users WHERE role = 'admin' LIMIT 1`)).rows as any[];
  const p = await one(sql`INSERT INTO projects (user_id, title, status) VALUES (${u.id}, ${`__GUARD_${tag}`}, ${status}) RETURNING id`);
  pids.push(Number(p.id));
  await db.execute(sql`INSERT INTO quotes (project_id, price, status, title, is_current) VALUES (${p.id}, 1000000, 'approved', ${`__GUARD_${tag}`}, true)`);
  return Number(p.id);
};
const pay = (pid: number, confirmed: boolean) => one(sql`INSERT INTO project_payments (project_id, sequence, payment_method, supply_amount, vat_amount, amount, deposit_status, deposit_confirmed, paid_date)
  VALUES (${pid}, 1, '영세율 계산서', 1000000, 0, 1000000, ${confirmed ? "completed" : "scheduled"}, ${confirmed}, ${confirmed ? sql`'2026-11-13'` : sql`NULL`}) RETURNING id`);
const perf = async (pid: number, roundStatus?: string) => {
  let rid: number | null = null;
  if (roundStatus) { const r = await one(sql`INSERT INTO payout_rounds (payment_date, status) VALUES ('2026-11-30', ${roundStatus}) RETURNING id`); rid = Number(r.id); rounds.push(rid); }
  await db.execute(sql`INSERT INTO performance_assignments (project_id, payout_round_id) VALUES (${pid}, ${rid})`);
};

async function main() {
  try {
    const cases: Array<[string, "A" | "B" | "C" | "D", (pid: number) => Promise<unknown>]> = [
      ["후속 데이터 없음", "A", async () => {}],
      ["수행정보만", "B", (p) => perf(p)],
      ["입금예정(미확정) 청구행", "C", (p) => pay(p, false)],
      ["draft 지급회차 편입 수행", "C", (p) => perf(p, "draft")],
      ["입금확정 청구행", "D", (p) => pay(p, true)],
      ["실제 입금거래", "D", async (p) => { const r = await pay(p, false); await db.execute(sql`INSERT INTO payment_transactions (project_id, project_payment_id, customer_paid_amount, paid_date) VALUES (${p}, ${r.id}, 1000000, '2026-11-13')`); }],
      ["지급완료(paid) 회차", "D", (p) => perf(p, "paid")],
      ["확정(confirmed) 회차", "D", (p) => perf(p, "confirmed")],
    ];
    console.log("\n[등급 판정 · 취소/삭제 통제]");
    const byGrade: Record<string, number> = {};
    for (const [label, exp, setup] of cases) {
      const pid = await mkProject(label); await setup(pid);
      const rep = await evaluateProjectDependencies(pid);
      const gate = exp === "A" || exp === "B" ? rep.canCancel && rep.canDelete : !rep.canCancel && !rep.canDelete;
      check(`${label} → ${exp} (cancel=${rep.canCancel} delete=${rep.canDelete})`, rep.grade === exp && gate, { grade: rep.grade, reasons: rep.blockingReasons });
      byGrade[exp] ??= pid;
    }
    console.log("\n[견적 삭제 우회 차단]");
    const qD = await one(sql`SELECT id FROM quotes WHERE project_id = ${byGrade.D}`);
    const qr = await evaluateQuoteDependencies(Number(qD.id));
    check("D 판매의 견적 → 견적 삭제도 차단", (qr as any).canDelete === false, qr);
    const qA = await one(sql`SELECT id FROM quotes WHERE project_id = ${byGrade.A}`);
    const qa = await evaluateQuoteDependencies(Number(qA.id));
    check("A 판매의 견적 → 삭제 허용", (qa as any).canDelete === true, qa);
    const before = await one(sql`SELECT (SELECT count(*) FROM project_payments) a, (SELECT count(*) FROM performance_assignments) b, (SELECT count(*) FROM quotes) c`);
    for (const pid of pids) await evaluateProjectDependencies(pid);
    const after = await one(sql`SELECT (SELECT count(*) FROM project_payments) a, (SELECT count(*) FROM performance_assignments) b, (SELECT count(*) FROM quotes) c`);
    check("Guard 검사만으로 DB 변경 없음", JSON.stringify(before) === JSON.stringify(after));
  } finally {
    const P = sql.join((pids.length ? pids : [0]).map(i => sql`${i}`), sql`, `);
    await db.execute(sql`DELETE FROM payment_transactions WHERE project_id IN (${P})`);
    await db.execute(sql`DELETE FROM project_payments WHERE project_id IN (${P})`);
    await db.execute(sql`DELETE FROM performance_assignments WHERE project_id IN (${P})`);
    if (rounds.length) await db.execute(sql`DELETE FROM payout_rounds WHERE id IN (${sql.join(rounds.map(i => sql`${i}`), sql`, `)})`);
    await db.execute(sql`DELETE FROM quotes WHERE project_id IN (${P})`);
    await db.execute(sql`DELETE FROM projects WHERE id IN (${P})`);
  }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
