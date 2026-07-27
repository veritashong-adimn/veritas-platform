import { db, translatorAliasesTable } from "@workspace/db";
import { normalizeCompanyName } from "./normalizeCompany";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | Tx;

// 통번역사 Alias 정규화는 거래처와 동일 기준(normalizeCompanyName: 소문자화 + 공백/기호 제거)을 재사용한다.
// 사람 이름에도 법인표기 제거가 무해하게 동작한다("Michael Kim" → "michaelkim", "김마이크" → "김마이크").

/** aliasName → INSERT 값(정규화 포함). aliasName 은 trim 된다. */
export function buildTranslatorAliasValues(translatorId: number, aliasName: string, isPrimary = false) {
  const name = aliasName.trim();
  return {
    translatorId,
    aliasName: name,
    normalizedAlias: normalizeCompanyName(name),
    isPrimary,
  };
}

/**
 * 통번역사 생성 시 실제 이름 기반 기본 Alias 1개를 자동 생성한다.
 * 이미 동일 normalizedAlias 가 있으면(UNIQUE) 조용히 건너뛴다.
 * 이름이 비었거나 정규화 결과가 비면 생성하지 않는다.
 */
export async function ensureDefaultTranslatorAlias(dbc: DbLike, translatorId: number, realName: string): Promise<void> {
  const name = (realName ?? "").trim();
  if (!name) return;
  const values = buildTranslatorAliasValues(translatorId, name, true);
  if (!values.normalizedAlias) return;
  await dbc.insert(translatorAliasesTable).values(values).onConflictDoNothing();
}
