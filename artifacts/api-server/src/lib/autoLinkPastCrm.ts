// ─────────────────────────────────────────────────────────────────────────────
// 통번역사 Master ↔ 과거 CRM(old_crm, progress) 주민번호 기반 자동 연결 — VERITAS OS
//
// 안전 원칙:
//   · 주민번호 전체값은 서버 내부에서만 복호/비교. API·로그·응답에 원문 노출 금지(건수·상태만 반환).
//   · 과거 CRM 원본(legacy_archive_rows)·Master·기존 매핑은 수정/삭제하지 않는다.
//   · 자동 '확정'은 아래 A조건을 모두 충족할 때만. 애매하면 candidate/none(관리자 확인).
//   · INSERT 는 유니크키(source_system,entity_type,legacy_id) 기준 ON CONFLICT DO NOTHING(중복 방지).
//   · 인물 단위 매핑(legacy_id = 과거 CRM 이름). 수행행을 중복 생성하지 않는다.
// ─────────────────────────────────────────────────────────────────────────────
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { decrypt } from "./encrypt";

export type AutoLinkStatus = "confirmed" | "exists" | "candidate" | "conflict" | "none" | "skipped";
export interface AutoLinkResult {
  status: AutoLinkStatus;
  legacyName?: string | null;     // 연결된(또는 후보) 과거 CRM 이름
  masterId?: number;              // 대상 Master user id
  pastRowCount?: number;          // 연결된 과거 '수행행' 수(지급건수 아님)
  reason?: string;                // candidate/conflict/skipped 사유(민감정보 미포함)
  candidates?: string[];          // 후보 과거 이름 목록(동명이인/별칭 등)
}

type Exec = typeof db;

function rrn13(s: string | null | undefined): string | null {
  const d = (s ?? "").replace(/[^0-9]/g, "");
  return d.length === 13 ? d : null;
}

// 주민번호 기반 자동 연결(단일 통번역사). exec 에 트랜잭션을 넘기면 그 안에서 실행(테스트 롤백 가능).
export async function autoLinkTranslatorByRrn(userId: number, exec: Exec = db): Promise<AutoLinkResult> {
  // 1) Master 로드(통번역사·미삭제) + 암호화 주민번호
  const mrow = (await exec.execute(sql`
    SELECT u.id, u.name, u.role::text AS role, u.deleted_at, ts.resident_number
    FROM users u LEFT JOIN translator_sensitive ts ON ts.translator_id = u.id
    WHERE u.id = ${userId} LIMIT 1`)).rows[0] as any;
  if (!mrow || mrow.deleted_at != null) return { status: "skipped", reason: "통번역사 Master 없음" };
  if (!["translator", "linguist"].includes(mrow.role)) return { status: "skipped", reason: "개인 통번역사 유형 아님" };

  let rrn: string | null = null;
  if (mrow.resident_number && String(mrow.resident_number).trim()) {
    try { rrn = rrn13(decrypt(String(mrow.resident_number))); } catch { rrn = null; }
  }
  if (!rrn) return { status: "skipped", masterId: userId, reason: "주민번호 없음/불완전 → 자동연결 불가(이름 후보는 재현화면에서 확인)" };

  // 2) 같은 주민번호를 가진 다른 Master 존재? (충돌 → 자동연결 금지)
  const others = (await exec.execute(sql`
    SELECT u.id, ts.resident_number FROM users u JOIN translator_sensitive ts ON ts.translator_id = u.id
    WHERE u.role IN ('translator','linguist') AND u.deleted_at IS NULL AND u.id <> ${userId}
      AND ts.resident_number IS NOT NULL AND btrim(ts.resident_number) <> ''`)).rows as any[];
  for (const o of others) {
    try { if (rrn13(decrypt(String(o.resident_number))) === rrn) return { status: "conflict", masterId: userId, reason: "동일 주민번호가 다른 Master와 중복" }; } catch { /* skip */ }
  }

  // 3) 과거 CRM(progress)에서 동일 주민번호를 가진 '이름' 수집 + 각 이름의 주민번호 가짓수
  const legRows = (await exec.execute(sql`
    WITH prog AS (
      SELECT nullif(btrim(source_raw->>'통번역사명'),'') AS nm,
             substring(regexp_replace(coalesce(source_raw->>'주민등록번호',''),'[^0-9]','','g') from 1 for 13) AS rrn13
      FROM legacy_archive_rows WHERE source_type='progress' AND is_effective=true
    )
    SELECT nm,
      count(*) FILTER (WHERE rrn13 = ${rrn})::int AS rows_this_rrn,
      count(DISTINCT rrn13) FILTER (WHERE length(rrn13)=13)::int AS distinct_rrn_of_name
    FROM prog WHERE nm IS NOT NULL
    GROUP BY nm
    HAVING count(*) FILTER (WHERE rrn13 = ${rrn}) > 0`)).rows as any[];

  if (legRows.length === 0) return { status: "none", masterId: userId, reason: "과거 CRM 동일 주민번호 없음" };
  if (legRows.length > 1) return { status: "candidate", masterId: userId, reason: "동일 주민번호가 과거 복수 이름(동명이인/별칭 확인 필요)", candidates: legRows.map(r => r.nm) };

  const legacyName: string = legRows[0].nm;
  if (Number(legRows[0].distinct_rrn_of_name) > 1) return { status: "candidate", masterId: userId, legacyName, reason: "과거 동일 이름에 복수 주민번호(동명이인 혼입) → 확인 필요" };

  // 4) 외주업체(vendor) 이름과 동일하면 자동연결 금지
  const vend = (await exec.execute(sql`SELECT bool_or(is_vendor) AS v FROM companies WHERE btrim(name) = ${legacyName}`)).rows[0] as any;
  if (vend?.v === true) return { status: "candidate", masterId: userId, legacyName, reason: "과거 이름이 외주업체 Master와 동일 → 통번역사 자동연결 금지" };

  // 5) 기존 매핑 충돌/중복 검사
  const exist = (await exec.execute(sql`
    SELECT entity_id FROM legacy_master_mappings
    WHERE source_system='old_crm' AND entity_type='translator' AND legacy_id = ${legacyName} LIMIT 1`)).rows[0] as any;
  const pastRowCount = Number(((await exec.execute(sql`
    SELECT count(*)::int AS n FROM legacy_archive_rows
    WHERE source_type='progress' AND is_effective=true AND nullif(btrim(source_raw->>'통번역사명'),'') = ${legacyName}`)).rows[0] as any)?.n ?? 0);
  if (exist) {
    if (Number(exist.entity_id) === userId) return { status: "exists", masterId: userId, legacyName, pastRowCount, reason: "이미 확정 연결됨(중복 생성 안 함)" };
    return { status: "conflict", masterId: userId, legacyName, pastRowCount, reason: `기존 확정 매핑이 다른 Master(#${exist.entity_id})에 존재 → 보존(변경 안 함)` };
  }

  // 6) 모든 조건 통과 → 확정 매핑 INSERT(유니크키 충돌 시 무시)
  await exec.execute(sql`
    INSERT INTO legacy_master_mappings (source_system, entity_type, legacy_id, entity_id, match_method, status, created_by, created_at)
    VALUES ('old_crm','translator', ${legacyName}, ${userId}, 'rrn', 'confirmed', NULL, now())
    ON CONFLICT (source_system, entity_type, legacy_id) DO NOTHING`);
  return { status: "confirmed", masterId: userId, legacyName, pastRowCount, reason: "주민번호 13자리 전체일치 자동 연결" };
}
