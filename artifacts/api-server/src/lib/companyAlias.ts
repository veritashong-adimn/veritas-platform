import { db, companyAliasesTable } from "@workspace/db";
import { normalizeCompanyName } from "./normalizeCompany";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | Tx;

/** aliasName → INSERT 값(정규화 포함). aliasName 은 trim 된다. */
export function buildAliasValues(companyId: number, aliasName: string, isPrimary = false) {
  const name = aliasName.trim();
  return {
    companyId,
    aliasName: name,
    normalizedAlias: normalizeCompanyName(name),
    isPrimary,
  };
}

/**
 * 거래처 생성 시 공식명 기반 기본 Alias 1개를 자동 생성한다(§8).
 * 이미 동일 normalizedAlias 가 있으면(UNIQUE) 조용히 건너뛴다.
 * 공식명이 비었거나 정규화 결과가 비면 생성하지 않는다.
 */
export async function ensureDefaultAlias(dbc: DbLike, companyId: number, officialName: string): Promise<void> {
  const name = (officialName ?? "").trim();
  if (!name) return;
  const values = buildAliasValues(companyId, name, true);
  if (!values.normalizedAlias) return;
  await dbc.insert(companyAliasesTable).values(values).onConflictDoNothing();
}
