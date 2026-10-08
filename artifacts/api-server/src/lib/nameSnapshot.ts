import { eq } from "drizzle-orm";
import { companiesTable, contactsTable } from "@workspace/db";

// ── 거래 당시 표시명 Snapshot 헬퍼 ────────────────────────────────────────────
// companyId/contactId 로 "그 시점" Master 이름을 1건 조회해 반환(없으면 null).
// 신규 거래 생성/확정 시 이 값을 Snapshot 컬럼에 1회 고정하는 용도이며,
// 이후 Master 이름이 변경되어도 저장된 Snapshot 은 자동으로 바뀌지 않는다.
//  · 주의: CRM 과거자료 import 는 Master 이름이 아니라 Excel 원본명을 직접 Snapshot 에 저장하므로
//    이 헬퍼를 사용하지 않는다(§Phase2 — 원본명 보존).
//  · 조회(Read)는 COALESCE(snapshot, 현재 Master명) fallback 으로 처리한다(§Phase3).

type Dbx = any; // tx 또는 db (프로젝트 services 의 `type Db = any` 관례와 동일)

export async function fetchCompanyName(dbx: Dbx, companyId: number | null | undefined): Promise<string | null> {
  if (companyId == null) return null;
  const rows = await dbx.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
  return rows[0]?.name ?? null;
}

export async function fetchContactName(dbx: Dbx, contactId: number | null | undefined): Promise<string | null> {
  if (contactId == null) return null;
  const rows = await dbx.select({ name: contactsTable.name }).from(contactsTable).where(eq(contactsTable.id, contactId)).limit(1);
  return rows[0]?.name ?? null;
}
