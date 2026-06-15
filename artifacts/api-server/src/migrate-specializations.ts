/**
 * 전문분야 레이블 마이그레이션 스크립트
 *
 * 문제: "범용 대응 가능" 레이블이 "다분야 가능"으로 변경되었으나
 *       기존 등록된 translator_profiles 레코드에 구값이 잔존
 *
 * 수정: specializations 컬럼에서 alias 값 → "다분야 가능" 표준값으로 치환
 *
 * 실행:
 *   pnpm run migrate:specializations           # dry-run (변경 예정 목록만 출력)
 *   pnpm run migrate:specializations -- --apply  # 실제 DB 적용
 */
import { db, pool, translatorProfilesTable } from "@workspace/db";
import { isNotNull, eq } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");

const ALIAS_MAP: Record<string, string> = {
  "범용 대응 가능": "다분야 가능",
  "범용대응가능": "다분야 가능",
  "generalist": "다분야 가능",
  "multi-domain": "다분야 가능",
  "multidomain": "다분야 가능",
  "general": "다분야 가능",
};

function normalizeSpecializations(raw: string): { normalized: string; changed: boolean } {
  const parts = raw.split(/[,，;]/).map(p => p.trim()).filter(Boolean);
  let changed = false;
  const normalized = parts.map(p => {
    const mapped = ALIAS_MAP[p] ?? ALIAS_MAP[p.toLowerCase()];
    if (mapped && mapped !== p) { changed = true; return mapped; }
    return p;
  });
  return { normalized: normalized.join(", "), changed };
}

async function main() {
  console.log(`\n전문분야 레이블 마이그레이션: "범용 대응 가능" → "다분야 가능"`);
  console.log(`모드: ${APPLY ? "실제 적용 (--apply)" : "Dry-run (변경 없음)"}\n`);

  const rows = await db
    .select({ id: translatorProfilesTable.id, specializations: translatorProfilesTable.specializations })
    .from(translatorProfilesTable)
    .where(isNotNull(translatorProfilesTable.specializations));

  const changes: { id: number; before: string; after: string }[] = [];

  for (const row of rows) {
    if (!row.specializations) continue;
    const { normalized, changed } = normalizeSpecializations(row.specializations);
    if (changed) changes.push({ id: row.id, before: row.specializations, after: normalized });
  }

  if (changes.length === 0) {
    console.log("변경 대상 없음 — 이미 정규화된 상태입니다.\n");
    await pool.end();
    return;
  }

  console.log(`변경 대상 ${changes.length}건:\n`);
  console.log(`  ${"ID".padEnd(6)} ${"현재값".padEnd(50)} → 변경 후`);
  console.log("  " + "─".repeat(110));
  for (const { id, before, after } of changes) {
    console.log(`  ${String(id).padEnd(6)} ${before.padEnd(50)} → ${after}`);
  }

  if (!APPLY) {
    console.log(`\n  적용하려면: pnpm run migrate:specializations -- --apply\n`);
    await pool.end();
    return;
  }

  console.log(`\nDB 적용 중...\n`);
  let success = 0;
  let fail = 0;

  for (const { id, before, after } of changes) {
    try {
      await db
        .update(translatorProfilesTable)
        .set({ specializations: after })
        .where(eq(translatorProfilesTable.id, id));
      console.log(`  [${id}] "${before}" → "${after}"`);
      success++;
    } catch (err) {
      console.error(`  [${id}] 업데이트 실패:`, err);
      fail++;
    }
  }

  console.log(`\n완료: 성공 ${success}건 / 실패 ${fail}건\n`);
  await pool.end();
}

main().catch(err => {
  console.error("오류:", err);
  pool.end();
  process.exit(1);
});
