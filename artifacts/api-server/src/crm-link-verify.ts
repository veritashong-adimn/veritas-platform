// 과거 CRM 진행관리표 ↔ 통번역사 Master 연결 검증 — 읽기 전용(요구사항 전항). DB 미변경.
//  · 주민번호 정확일치 우선. 주민번호 없으면 이름+식별정보로 '후보'만(동명이인 자동 동일인 처리 안 함).
//  · 재사용/비재사용(847) 재현은 batch 182 이전 '원본 Master'로 스코프(커밋으로 추가된 1,035명 제외).
//  · 주민번호 원문·13자리는 콘솔에 출력하지 않는다(건수·마스킹만).
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { decrypt } from "./lib/encrypt";
import { normalizeCompanyName } from "./lib/normalizeCompany";
import { parseWorkbook, buildColumnMap, getCell, isBlankRow, normalizeName, normalizePhone, normalizeEmail, TRANSLATOR_COLUMN_SYNONYMS } from "./lib/hometaxExcel";
import { isLegacyPlaceholderEmail } from "./lib/mailer";
import { getSnapshotMeta, readSnapshotBuffer } from "./lib/importSnapshot";

const SNAP = "ac784cc3235ffd0c808aadc0";
const BATCH = 182;
const rrn13 = (s: unknown) => { const d = String(s ?? "").replace(/[^0-9]/g, ""); return d.length === 13 ? d : null; };
const maskName = (n: string) => { const s = (n ?? "").trim(); return !s ? "(이름없음)" : s.length <= 1 ? "*" : s[0] + "*".repeat(s.length - 1); };
const maskRrn = (r: string | null) => r ? `${r.slice(0, 6)}-*******` : "(없음)";
const add = (m: Map<string, Set<number>>, k: string, id: number) => { if (!k) return; const s = m.get(k) ?? new Set<number>(); s.add(id); m.set(k, s); };

async function main() {
  const rows = (q: any) => (q as any).rows as any[];

  // ── Master(현재 2,337) 인덱스 + batch182 신규 식별 ──
  const newIds = new Set<number>(rows(await db.execute(sql`SELECT entity_id FROM import_row_sources WHERE batch_id=${BATCH}`)).map((r) => Number(r.entity_id)));
  const users = rows(await db.execute(sql`SELECT id, name, email FROM users WHERE role='translator' AND deleted_at IS NULL`));
  const aliases = rows(await db.execute(sql`SELECT translator_id tid, normalized_alias na FROM translator_aliases`));
  const temails = rows(await db.execute(sql`SELECT translator_id tid, email FROM translator_emails`));
  const profiles = rows(await db.execute(sql`SELECT user_id uid, coalesce(phone,'') phone, coalesce(region,'')||coalesce(language_pairs,'')||coalesce(grade,'') prof FROM translator_profiles`));
  const sens = rows(await db.execute(sql`SELECT translator_id tid, resident_number rn, coalesce(nullif(btrim(bank_account),''), nullif(btrim(bank_account_enc),'')) acct FROM translator_sensitive`));
  const rates = rows(await db.execute(sql`SELECT translator_id tid, count(*)::int c FROM translator_rates GROUP BY 1`));

  const allIds = new Set<number>(users.map((u) => Number(u.id)));
  const masterName = new Map<number, string>();
  const nameToIds = new Map<string, Set<number>>();
  const emailToIds = new Map<string, Set<number>>();
  const phoneToIds = new Map<string, Set<number>>();
  const rrnToIds = new Map<string, Set<number>>();
  const rrnById = new Map<number, string>();
  const hasAcct = new Set<number>(); const hasRates = new Set<number>(); const hasProfile = new Set<number>();
  for (const u of users) { const id = Number(u.id); masterName.set(id, u.name ?? ""); const nn = normalizeCompanyName(u.name ?? ""); if (nn) add(nameToIds, nn, id); const em = normalizeEmail(u.email); if (em && !isLegacyPlaceholderEmail(u.email)) add(emailToIds, em, id); }
  for (const a of aliases) { if (allIds.has(Number(a.tid)) && a.na) add(nameToIds, String(a.na), Number(a.tid)); }
  for (const t of temails) { const id = Number(t.tid); if (allIds.has(id) && t.email && !isLegacyPlaceholderEmail(t.email)) { const em = normalizeEmail(t.email); if (em) add(emailToIds, em, id); } }
  for (const p of profiles) { const id = Number(p.uid); const ph = normalizePhone(p.phone); if (ph) add(phoneToIds, ph, id); if ((p.phone || "").trim() || (p.prof || "").trim()) hasProfile.add(id); }
  for (const s of sens) { const id = Number(s.tid); if (!allIds.has(id)) continue; if ((s.acct || "").trim()) hasAcct.add(id); const raw = s.rn ? String(s.rn).trim() : ""; if (!raw) continue; let k: string | null = null; try { k = rrn13(decrypt(raw)); } catch { k = null; } if (k) { add(rrnToIds, k, id); if (!rrnById.has(id)) rrnById.set(id, k); } }
  for (const r of rates) { if (allIds.has(Number(r.tid))) hasRates.add(Number(r.tid)); }

  // ── 진행관리표(30,142 effective) ──
  const prog = rows(await db.execute(sql`SELECT nullif(btrim(source_raw->>'통번역사명'),'') nm, substring(regexp_replace(coalesce(source_raw->>'주민등록번호',''),'[^0-9]','','g') from 1 for 13) rrn FROM legacy_archive_rows WHERE source_type='progress' AND is_effective=true`));

  // 성명이 RRN행에 등장하는지 집합(이름-그룹/실인원 구분용) + 이름→진행관리표 주민번호 집합(브리지용)
  const namesWithRrn = new Set<string>();
  const progNameToRrns = new Map<string, Set<string>>();
  for (const r of prog) { if (r.rrn && String(r.rrn).length === 13) { const nn = r.nm ? normalizeCompanyName(String(r.nm)) : ""; if (nn) { namesWithRrn.add(nn); const s = progNameToRrns.get(nn) ?? new Set<string>(); s.add(String(r.rrn)); progNameToRrns.set(nn, s); } } }

  // ── 행 단위 연결 분류 + 수행자(식별자) 단위 집계 ──
  let rowConfirmed = 0, rowCandidate = 0, rowUnconnected = 0, rowNoName = 0;
  const perfRrnConfirmed = new Set<string>();   // rrn ∈ master
  const perfRrnUnmatched = new Set<string>();   // rrn 있으나 master 없음
  const nameOnlyCandidate = new Set<string>();  // rrn 없는 이름그룹, 이름 매칭 master 존재
  const nameOnlyUnconnected = new Set<string>();// rrn 없는 이름그룹, 매칭 없음
  const rrnConfirmedNameDiff = new Set<string>();  // rrn 일치하나 이름 상이(충돌/확인)
  const nameMatchRrnDiff = new Set<string>();      // 이름 일치 master가 다른 주민번호 보유(귀화/동명이인)
  const homonym = new Set<string>();               // 이름이 복수 master와 일치
  const allRrn13 = new Set<string>();
  const sampleUnmatchedRrn = new Map<string, string>();      // rrn → 진행관리표 이름(마스킹 전)
  const sampleRrnNameDiff: { prog: string; rrn: string; master: string }[] = [];
  const sampleNameRrnDiff: { prog: string; rrn: string }[] = [];

  for (const r of prog) {
    const nm = r.nm ? String(r.nm) : "";
    const nmNorm = nm ? normalizeCompanyName(nm) : "";
    const rr = r.rrn && String(r.rrn).length === 13 ? String(r.rrn) : null;
    if (!nm && !rr) { rowNoName++; continue; }
    if (rr) allRrn13.add(rr);
    const nameIds = nmNorm ? (nameToIds.get(nmNorm) ?? new Set<number>()) : new Set<number>();

    if (rr && rrnToIds.has(rr)) {
      rowConfirmed++; perfRrnConfirmed.add(rr);
      // 이름 일치 여부(RRN은 확정이나 이름 상이 시 확인 표시)
      const rrnIds = rrnToIds.get(rr)!;
      const nameConsistent = [...rrnIds].some((id) => nameIds.has(id));
      if (nmNorm && !nameConsistent) { if (!rrnConfirmedNameDiff.has(`${nmNorm}|${rr}`) && sampleRrnNameDiff.length < 10) sampleRrnNameDiff.push({ prog: nm, rrn: rr, master: masterName.get([...rrnIds][0]) ?? "" }); rrnConfirmedNameDiff.add(`${nmNorm}|${rr}`); }
    } else {
      // 비확정 — 이름 기반 후보/미연결
      if (nameIds.size >= 1) {
        rowCandidate++;
        if (rr) { // rrn 있으나 master에 없음 + 이름은 매칭 → 동일 이름 master가 다른 rrn 보유?
          perfRrnUnmatched.add(rr); if (!sampleUnmatchedRrn.has(rr)) sampleUnmatchedRrn.set(rr, nm);
          const nameHasRrn = [...nameIds].some((id) => rrnById.has(id));
          if (nameHasRrn) { if (!nameMatchRrnDiff.has(`${nmNorm}|${rr}`) && sampleNameRrnDiff.length < 10) sampleNameRrnDiff.push({ prog: nm, rrn: rr }); nameMatchRrnDiff.add(`${nmNorm}|${rr}`); }
        } else {
          nameOnlyCandidate.add(nmNorm);
        }
        if (nameIds.size >= 2) homonym.add(nmNorm);
      } else {
        rowUnconnected++;
        if (rr) { perfRrnUnmatched.add(rr); if (!sampleUnmatchedRrn.has(rr)) sampleUnmatchedRrn.set(rr, nm); } else if (nmNorm) nameOnlyUnconnected.add(nmNorm);
      }
    }
  }

  // ── legacy_master_mappings 점검(entity_type='translator') ──
  const maps = rows(await db.execute(sql`SELECT id, btrim(legacy_id) legacy_id, entity_id, status, match_method FROM legacy_master_mappings WHERE entity_type='translator'`));
  const progNames = new Set<string>(prog.map((r) => (r.nm ? normalizeCompanyName(String(r.nm)) : "")).filter(Boolean));
  let mapOk = 0, mapNameMismatch = 0, mapOrphan = 0, mapRolledBack = 0, mapLegacyNotInProgress = 0;
  for (const m of maps) {
    if (m.status === "rolled_back") { mapRolledBack++; continue; }
    const eid = Number(m.entity_id);
    if (!allIds.has(eid)) { mapOrphan++; continue; }           // 연결 Master가 없거나 삭제됨
    const lid = normalizeCompanyName(m.legacy_id ?? "");
    const nm = normalizeCompanyName(masterName.get(eid) ?? "");
    const aliasOk = (nameToIds.get(lid) ?? new Set()).has(eid);
    if (lid && (lid === nm || aliasOk)) mapOk++; else mapNameMismatch++;   // legacy_id(이름) ↔ Master 이름/별칭 정합
    if (lid && !progNames.has(lid)) mapLegacyNotInProgress++;
  }

  // ── 재사용(455) / 비재사용(847) 재현: batch182 이전 '원본 Master'만으로 CRM 명부 매칭 ──
  const origIds = new Set<number>([...allIds].filter((id) => !newIds.has(id)));
  const oName = new Map<string, Set<number>>(), oEmail = new Map<string, Set<number>>(), oPhone = new Map<string, Set<number>>(), oRrn = new Map<string, Set<number>>();
  for (const [k, s] of nameToIds) { const f = new Set([...s].filter((id) => origIds.has(id))); if (f.size) oName.set(k, f); }
  for (const [k, s] of emailToIds) { const f = new Set([...s].filter((id) => origIds.has(id))); if (f.size) oEmail.set(k, f); }
  for (const [k, s] of phoneToIds) { const f = new Set([...s].filter((id) => origIds.has(id))); if (f.size) oPhone.set(k, f); }
  for (const [k, s] of rrnToIds) { const f = new Set([...s].filter((id) => origIds.has(id))); if (f.size) oRrn.set(k, f); }

  const buf = readSnapshotBuffer(SNAP); const meta = getSnapshotMeta(SNAP);
  if (!buf || !meta) throw new Error("snapshot missing");
  const parsed = parseWorkbook(buf, TRANSLATOR_COLUMN_SYNONYMS);
  const colMap = buildColumnMap(parsed.headers, TRANSLATOR_COLUMN_SYNONYMS);
  const reuseIds = new Set<number>();
  const listNameNorms = new Set<string>(); const listRrns = new Set<string>(); const listEmails = new Set<string>(); const listPhones = new Set<string>();
  for (const raw of parsed.dataRows) {
    if (isBlankRow(raw)) continue;
    const name = normalizeName(getCell(raw, colMap, "name")); if (!name) continue;
    const nmNorm = normalizeCompanyName(name); listNameNorms.add(nmNorm);
    const rr = rrn13(normalizeName(getCell(raw, colMap, "residentNumber"))); if (rr) listRrns.add(rr);
    const emailRaw = normalizeName(getCell(raw, colMap, "email"));
    const emailReal = isLegacyPlaceholderEmail(emailRaw) ? "" : normalizeEmail(emailRaw); if (emailReal) listEmails.add(emailReal);
    const phone = normalizePhone(getCell(raw, colMap, "phone")); if (phone) listPhones.add(phone);
    const nameSet = oName.get(nmNorm) ?? new Set<number>();
    const cands = new Set<number>();
    if (rr) for (const id of (oRrn.get(rr) ?? [])) if (nameSet.has(id)) cands.add(id);
    if (emailReal) for (const id of (oEmail.get(emailReal) ?? [])) if (nameSet.has(id)) cands.add(id);
    if (phone) for (const id of (oPhone.get(phone) ?? [])) if (nameSet.has(id)) cands.add(id);
    if (cands.size === 1) reuseIds.add([...cands][0]);
  }
  const notReused = [...origIds].filter((id) => !reuseIds.has(id));

  // ── 중복 Master 분석: 847 원본 ↔ 1,035 신규(요구사항1·2). 주민번호 일치 최우선·이름만/상충은 자동통합 금지. ──
  let dupSafeMerge = 0, dupRrnNameConflict = 0, dupNameOnly = 0, dupNameRrnConflict = 0, dupNone = 0, rrnBridgeConfirmable = 0;
  const safeNewIds = new Set<number>();      // 주민번호+이름 모두 일치 → 안전 통합 가능(신규측 중복 id)
  const manualNewIds = new Set<number>();    // 수동 확인 대상 신규 중복 id
  const dupNameOnlySamples: { orig: string; count: number }[] = [];
  for (const id of notReused) {
    const nn = normalizeCompanyName(masterName.get(id) ?? "");
    const origRrn = rrnById.get(id) ?? null;
    const nameNew = new Set<number>([...(nameToIds.get(nn) ?? [])].filter((x) => newIds.has(x)));
    const rrnNew = origRrn ? new Set<number>([...(rrnToIds.get(origRrn) ?? [])].filter((x) => newIds.has(x))) : new Set<number>();
    if (rrnNew.size > 0) {
      const bothAgree = [...rrnNew].some((x) => nameNew.has(x));
      if (bothAgree) { dupSafeMerge++; for (const x of rrnNew) if (nameNew.has(x)) safeNewIds.add(x); }
      else { dupRrnNameConflict++; for (const x of rrnNew) manualNewIds.add(x); }   // 주민번호 일치하나 이름 상충 → 수동
    } else if (nameNew.size > 0) {
      let conflict = false;
      if (origRrn) for (const x of nameNew) { const xr = rrnById.get(x); if (xr && xr !== origRrn) conflict = true; }
      if (conflict) dupNameRrnConflict++; else { dupNameOnly++; if (dupNameOnlySamples.length < 10) dupNameOnlySamples.push({ orig: maskName(masterName.get(id) ?? ""), count: nameNew.size }); }
      // 진행관리표 RRN 브리지: 원본 이름이 progress에서 보유한 RRN이 name-twin 신규 Master의 RRN과 일치 → 동일인 강한 근거(수동 확정 우선순위).
      const progRrns = progNameToRrns.get(nn);
      if (progRrns && progRrns.size > 0) { for (const x of nameNew) { const xr = rrnById.get(x); if (xr && progRrns.has(xr)) { rrnBridgeConfirmable++; break; } } }
      for (const x of nameNew) manualNewIds.add(x);
    } else dupNone++;
  }

  // ── 요구사항6: 주민번호 없고 수행이력도 없는 사람만 정리 대상. CRM/업무 데이터도 확인. ──
  let cleanupNoRrnNoHistory = 0;
  for (const id of notReused) {
    const nn = normalizeCompanyName(masterName.get(id) ?? ""); const rrn = rrnById.get(id) ?? null;
    const history = (nn && progNames.has(nn)) || (rrn && allRrn13.has(rrn));
    if (!rrnById.has(id) && !history) cleanupNoRrnNoHistory++;
  }
  const idList = sql.raw(notReused.length ? notReused.join(",") : "-1");   // 신뢰된 정수 id(내부 생성) 인라인
  const bizRow = rows(await db.execute(sql`
    SELECT
      (SELECT count(DISTINCT translator_id) FROM settlements WHERE translator_id IN (${idList}))::int settlements,
      (SELECT count(DISTINCT translator_id) FROM tasks WHERE translator_id IN (${idList}))::int tasks,
      (SELECT count(DISTINCT translator_id) FROM translation_units WHERE translator_id IN (${idList}))::int units,
      (SELECT count(DISTINCT translator_id) FROM translator_documents WHERE translator_id IN (${idList}))::int docs,
      (SELECT count(DISTINCT entity_id) FROM legacy_master_mappings WHERE entity_type='translator' AND status<>'rolled_back' AND entity_id IN (${idList}))::int mappings`))[0] as any;

  // ── 847(비재사용 원본) 특성 분류 ──
  let nr_inList = 0, nr_history = 0, nr_rrn = 0, nr_acct = 0, nr_rates = 0, nr_profile = 0, nr_noneOfPII = 0;
  for (const id of notReused) {
    const nn = normalizeCompanyName(masterName.get(id) ?? "");
    const rrn = rrnById.get(id) ?? null;
    const inList = (nn && listNameNorms.has(nn)) || (rrn && listRrns.has(rrn));   // 명부에 (이름/주민번호) 등장
    const history = (nn && progNames.has(nn)) || (rrn && allRrn13.has(rrn));      // 진행관리표 수행이력(이름/주민번호)
    const pii = rrnById.has(id) || hasAcct.has(id) || hasRates.has(id) || hasProfile.has(id);
    if (inList) nr_inList++;
    if (history) nr_history++;
    if (rrnById.has(id)) nr_rrn++;
    if (hasAcct.has(id)) nr_acct++;
    if (hasRates.has(id)) nr_rates++;
    if (hasProfile.has(id)) nr_profile++;
    if (!pii) nr_noneOfPII++;
  }

  // ── 보존 상태(요구사항7) ──
  const preserve = rows(await db.execute(sql`
    SELECT 'progress' k, count(*) c FROM legacy_archive_rows WHERE source_type='progress'
    UNION ALL SELECT 'sales', count(*) FROM legacy_archive_rows WHERE source_type='sales_list'
    UNION ALL SELECT 'links', count(*) FROM legacy_sales_progress_links`));

  const report = {
    scope: { snapshot: SNAP, masters_current: allIds.size, masters_new_batch182: newIds.size, masters_original: origIds.size },
    progress_rows: { total: prog.length, no_name: rowNoName, distinct_names: progNames.size, distinct_rrn13: allRrn13.size },
    connection_rows: { confirmed_exact: rowConfirmed, candidate: rowCandidate, unconnected: rowUnconnected, no_name: rowNoName },
    connection_performers: {
      rrn_confirmed: perfRrnConfirmed.size,
      rrn_unmatched: perfRrnUnmatched.size,
      name_only_candidate: nameOnlyCandidate.size,
      name_only_unconnected: nameOnlyUnconnected.size,
      names_total_groups: progNames.size,
      names_appearing_with_rrn: namesWithRrn.size,
    },
    conflicts: { rrn_confirmed_name_diff: rrnConfirmedNameDiff.size, name_match_rrn_diff: nameMatchRrnDiff.size, homonym_name_groups: homonym.size },
    mappings_1529: { total: maps.length, ok: mapOk, name_mismatch: mapNameMismatch, orphan_entity_missing: mapOrphan, rolled_back: mapRolledBack, legacy_not_in_progress: mapLegacyNotInProgress },
    reuse_reproduction: { reused_original_masters: reuseIds.size, not_reused: notReused.length },
    not_reused_847: { total: notReused.length, in_crm_list: nr_inList, has_work_history: nr_history, has_rrn: nr_rrn, has_account: nr_acct, has_rates: nr_rates, has_profile: nr_profile, no_pii_at_all: nr_noneOfPII },
    dedup_847_vs_1035: {
      real_duplicate_confirmed_rrn_and_name: dupSafeMerge,     // 실제 동일인 확정(주민번호+이름 일치)
      safe_auto_mergeable_new_masters: safeNewIds.size,        // 안전 자동 통합 가능(신규측)
      manual_name_only: dupNameOnly,                           // 이름만 일치 → 수동(자동통합 금지)
      manual_rrn_name_conflict: dupRrnNameConflict,            // 주민번호 일치·이름 상충 → 수동
      manual_name_rrn_conflict: dupNameRrnConflict,            // 이름 일치·주민번호 상충 → 수동
      no_duplicate: dupNone,                                   // 신규측 중복 없음(고유 원본)
      rrn_bridge_confirmable_name_only: rrnBridgeConfirmable,  // 진행관리표 RRN 브리지로 동일인 강한 근거(수동 확정 우선)
      manual_review_new_masters: manualNewIds.size,            // 수동 확인 필요 신규 중복 id 수
      name_only_samples: dupNameOnlySamples,
    },
    cleanup_target_req6: { no_rrn_and_no_history: cleanupNoRrnNoHistory, business_linkage_of_847: bizRow },
    projected_masters: {
      current: allIds.size,
      after_safe_auto_merge: allIds.size - safeNewIds.size,
      after_all_manual_confirmed_upper_bound: allIds.size - safeNewIds.size - manualNewIds.size,
    },
    preservation: Object.fromEntries(preserve.map((r) => [r.k, Number(r.c)])),
    samples_masked: {
      rrn_unmatched: [...sampleUnmatchedRrn.entries()].slice(0, 10).map(([rr, nm]) => ({ name: maskName(nm), rrn: maskRrn(rr) })),
      rrn_confirmed_name_diff: sampleRrnNameDiff.map((s) => ({ progress_name: maskName(s.prog), master_name: maskName(s.master), rrn: maskRrn(s.rrn) })),
      name_match_rrn_diff: sampleNameRrnDiff.map((s) => ({ name: maskName(s.prog), rrn: maskRrn(s.rrn) })),
    },
  };
  console.log("REPORT " + JSON.stringify(report));
  await pool.end().catch(() => {});
  process.exit(0);
}
main().catch(async (e) => { console.error("FATAL", e); try { await pool.end(); } catch { /* ignore */ } process.exit(1); });
