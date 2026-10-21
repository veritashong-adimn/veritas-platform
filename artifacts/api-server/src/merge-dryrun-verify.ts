// @ts-nocheck — 읽기 전용 검증 하네스(앱 빌드 비포함). 운영 DB에 대해 "조회·DRY-RUN"만 수행 — 어떤 쓰기도 하지 않는다(§10).
//  · buildMergePreview / runMergeExecute(commit=false) 만 호출 → SELECT 전용. transaction 진입 전 반환되므로 DB 미변경.
//  · 목적: 식별정보 없는 동일인(강보성 #2406/2407/2408)의 통합 가드/실행가능 로직 수정 결과를 실데이터로 검증.
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { buildMergePreview } from "./services/translatorMerge";
import { runMergeExecute, expectedConfirmToken } from "./services/translatorMergeExecute";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL 필요"); process.exit(1); }
const pool = new Pool({ connectionString: url });
const db = drizzle(pool);

const IDS = (process.env.MERGE_IDS ?? "2406,2407,2408").split(",").map((s) => Number(s.trim())).filter(Boolean);

async function main() {
  console.log("=== 읽기전용 DRY-RUN 검증 (쓰기 없음) — ids:", IDS.join(","), "===\n");

  // 1) 미리보기(가드) — 식별정보 없음은 차단이 아니어야 한다.
  const pv = await buildMergePreview(db, IDS);
  console.log("[미리보기] masters:", pv.masters.map((m) => `#${m.id} ${m.name} (rrn:${m.hasResidentNumber} ph:${m.phones.length} em:${m.emails.length})`).join(" | "));
  console.log("[신호] allSameName:", pv.signals.allSameName, "| nameMismatch:", pv.signals.nameMismatch, "| rrnConflict:", pv.signals.rrnConflict, "| sharedRrn/Phone/Email:", pv.signals.sharedRrn, pv.signals.sharedPhone, pv.signals.sharedEmail);
  console.log("[가드] blocked:", pv.guard.blocked, "| reasons:", JSON.stringify(pv.guard.reasons), "| warnings:", JSON.stringify(pv.guard.warnings));

  const rep = IDS[0];

  // 2) 대표 지정 미리보기
  const pv2 = await buildMergePreview(db, IDS, rep);
  if (pv2.preview) {
    const p = pv2.preview;
    console.log(`\n[통합후 미리보기] 대표 #${p.representativeId} ← 숨김 ${p.mergedMasterIds.map((i) => "#" + i).join(",")}`);
    console.log(`  진행이력(dedup) ${p.finalHistoryCount} · 판매 ${p.finalSalesCount} · 정산 ${p.settlementCount}건/${p.settlementAmount} · 실지급 ${p.payoutTransferCount}건/${p.totalPaid} · ambiguous:${p.ambiguousHistory}`);
  } else {
    console.log("\n[통합후 미리보기] 없음 (blocked 또는 대표 미선택)");
  }

  // 3) DRY-RUN(확인 미체크) — 하드 차단이 없으면 blocked=false, canExecute=false 여야 한다.
  const dryNo = await runMergeExecute(db, { masterIds: IDS, representativeId: rep, samePersonConfirmed: false, commit: false });
  console.log("\n[DRY-RUN · 확인X] blocked:", dryNo.blocked, "| canExecute:", dryNo.canExecute, "| requiresConfirm:", dryNo.requiresSamePersonConfirm, "| sharedId:", dryNo.sharedIdentifier);
  console.log("  plan:", JSON.stringify((dryNo.plan ?? []).filter((x) => x.count > 0)), "| reasons:", JSON.stringify(dryNo.reasons));

  // 4) DRY-RUN(확인 체크) — 하드 차단이 없으면 canExecute=true 여야 한다.
  const dryYes = await runMergeExecute(db, { masterIds: IDS, representativeId: rep, samePersonConfirmed: true, commit: false });
  console.log("\n[DRY-RUN · 확인O] blocked:", dryYes.blocked, "| canExecute:", dryYes.canExecute, "| token:", dryYes.confirmToken);

  // 판정
  const ok =
    pv.guard.blocked === false &&                       // 식별정보 없어도 차단 아님(§1·§2)
    pv.signals.rrnConflict === false &&                 // 전제: 주민번호 충돌 없음
    dryNo.blocked === false && dryNo.canExecute === false &&  // 확인 전: 차단 아님 + 실행불가(§3·§4)
    dryYes.blocked === false && dryYes.canExecute === true;   // 확인 후: 실행가능(§3)
  console.log("\n=== 판정:", ok ? "PASS ✅ (식별정보 없어도 동일인 확인 시 실행 가능, 하드차단 없음)" : "FAIL ❌", "===");
  console.log("※ 본 검증은 SELECT 전용 — 운영 DB에 어떤 변경도 가하지 않았습니다(§10).");
  await pool.end();
  process.exit(ok ? 0 : 2);
}
main().catch(async (e) => { console.error("FATAL", e); try { await pool.end(); } catch { /* ignore */ } process.exit(1); });
