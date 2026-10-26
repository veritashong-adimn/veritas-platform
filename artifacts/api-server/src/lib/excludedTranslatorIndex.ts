// ─── 통합·제외(soft delete)된 통번역사 Master 대조 색인 — VERITAS OS ─────────────────
// 목적: 통번역사 Excel 반복 업로드 시 이미 통합·제외된 인물이 '신규 Master'로 다시 생성되지 않게 한다.
//   · 통합(translator_merges, status='active')된 Master → 대표 Master 로 연결(대표가 살아 있을 때).
//   · 그 외 제외 Master 와 동일인/동명 → 보류(needs_review). 재활성화·신규 생성 금지.
//   · 읽기 전용. 주민번호 원문은 서버 내부 비교에만 사용(반환·로그 금지).
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { decrypt } from "./encrypt";
import { isLegacyPlaceholderEmail } from "./mailer";

export interface ExcludedHit {
  excludedId: number;
  method: "rrn" | "email" | "phone" | "name";
  representativeId: number | null;   // 통합 대표 Master(살아 있을 때만)
}

export interface ExcludedTranslatorIndex {
  size: number;
  lookup(nameNorm: string, rrnKey: string | null, emailNorm: string, phoneNorm: string): ExcludedHit | null;
}

export async function buildExcludedTranslatorIndex(norm: {
  name: (s: string) => string;
  email: (s: string | null | undefined) => string;
  phone: (s: string | null | undefined) => string;
  rrn13: (s: string | null | undefined) => string | null;
}): Promise<ExcludedTranslatorIndex> {
  const ex = (await db.execute(sql`
    SELECT u.id, u.name, u.email, p.phone, s.resident_number AS rn
    FROM users u
    LEFT JOIN translator_profiles p ON p.user_id = u.id
    LEFT JOIN translator_sensitive s ON s.translator_id = u.id
    WHERE u.role = 'translator' AND u.deleted_at IS NOT NULL`)).rows as any[];
  const alive = new Set(((await db.execute(sql`SELECT id FROM users WHERE role = 'translator' AND deleted_at IS NULL`)).rows as any[]).map(r => Number(r.id)));
  const merges = (await db.execute(sql`
    SELECT merged_master_id AS m, representative_master_id AS r FROM translator_merges WHERE status = 'active'`)).rows as any[];
  const repOf = new Map<number, number>(merges.map(r => [Number(r.m), Number(r.r)]));
  const resolveRep = (id: number): number | null => {
    let cur = id;
    for (let i = 0; i < 5; i++) {             // 통합 체인(대표가 다시 통합된 경우) 추적
      const r = repOf.get(cur);
      if (r == null) break;
      if (alive.has(r)) return r;
      cur = r;
    }
    return null;
  };

  const ids = new Set(ex.map(r => Number(r.id)));
  const aliasRows = ids.size
    ? ((await db.execute(sql`SELECT translator_id AS id, normalized_alias AS a FROM translator_aliases WHERE translator_id IN (SELECT id FROM users WHERE role='translator' AND deleted_at IS NOT NULL)`)).rows as any[])
    : [];
  const emailRows = ids.size
    ? ((await db.execute(sql`SELECT translator_id AS id, email FROM translator_emails WHERE translator_id IN (SELECT id FROM users WHERE role='translator' AND deleted_at IS NOT NULL)`)).rows as any[])
    : [];

  const nameIdx = new Map<string, Set<number>>(), rrnIdx = new Map<string, Set<number>>(), emailIdx = new Map<string, Set<number>>(), phoneIdx = new Map<string, Set<number>>();
  const add = (m: Map<string, Set<number>>, k: string | null | undefined, id: number) => { if (!k) return; const s = m.get(k) ?? new Set(); s.add(id); m.set(k, s); };
  const idNames = new Map<number, Set<string>>();
  const addName = (id: number, n: string) => { if (!n) return; add(nameIdx, n, id); const s = idNames.get(id) ?? new Set(); s.add(n); idNames.set(id, s); };
  for (const r of ex) {
    const id = Number(r.id);
    addName(id, norm.name(r.name ?? ""));
    if (r.email && !isLegacyPlaceholderEmail(r.email)) add(emailIdx, norm.email(r.email), id);
    add(phoneIdx, norm.phone(r.phone), id);
    if (r.rn) { try { add(rrnIdx, norm.rrn13(decrypt(String(r.rn))), id); } catch { /* 복호 실패 skip */ } }
  }
  for (const a of aliasRows) addName(Number(a.id), String(a.a ?? ""));
  for (const e of emailRows) if (e.email && !isLegacyPlaceholderEmail(e.email)) add(emailIdx, norm.email(e.email), Number(e.id));

  const pick = (cands: number[], method: ExcludedHit["method"]): ExcludedHit => {
    // 복수 후보면 대표가 있는 쪽 우선, 그다음 id 오름차순(결정적).
    const sorted = [...cands].sort((a, b) => (resolveRep(a) == null ? 1 : 0) - (resolveRep(b) == null ? 1 : 0) || a - b);
    return { excludedId: sorted[0], method, representativeId: resolveRep(sorted[0]) };
  };

  return {
    size: ex.length,
    lookup(nameNorm, rrnKey, emailNorm, phoneNorm) {
      const nameSet = nameNorm ? nameIdx.get(nameNorm) : undefined;
      if (!nameSet || nameSet.size === 0) return null;     // 성명 불일치 → 기존 업로드 규칙(성명+식별정보)과 동일하게 대상 아님
      const withName = (m: Map<string, Set<number>>, k: string | null | undefined) => (k ? [...(m.get(k) ?? [])].filter(id => nameSet.has(id)) : []);
      const byRrn = withName(rrnIdx, rrnKey); if (byRrn.length) return pick(byRrn, "rrn");
      const byEmail = withName(emailIdx, emailNorm); if (byEmail.length) return pick(byEmail, "email");
      const byPhone = withName(phoneIdx, phoneNorm); if (byPhone.length) return pick(byPhone, "phone");
      return pick([...nameSet], "name");
    },
  };
}
