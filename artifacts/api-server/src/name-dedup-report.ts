// 통번역사 Master 동명(同名) 중복 20개 그룹 추출 — 읽기 전용(DB 미변경·통합/삭제 없음).
//  · 같은 이름이 2개 이상 Master ID에 등록된 그룹만 대상. 기존+신규가 함께 있는 그룹 우선 20개 선정.
//  · 그룹별로 모든 Master를 나란히 비교: 주민번호 보유/마스킹·전화·이메일·수행이력·CRM원본연결·등록출처.
//  · 그룹 분석: 주민번호/전화/이메일 일치, 동일인 가능성, 동명이인 가능성, 식별정보 부족 + 판단 근거.
//  · 주민번호 원문은 서버 내부 복호 후 "일치 비교"에만 사용, 출력은 YYMMDD-******* 마스킹만. 로그·화면 평문 노출 금지.
//  · 결과를 터미널 비교표로 출력 + Excel 파일 생성. 통합·수정·삭제·커밋은 하지 않는다.
import fs from "fs";
import path from "path";
import * as XLSX from "xlsx";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { decrypt } from "./lib/encrypt";
import { normalizeCompanyName } from "./lib/normalizeCompany";
import { normalizePhone, normalizeEmail } from "./lib/hometaxExcel";
import { isLegacyPlaceholderEmail } from "./lib/mailer";

const BATCH = 182;                       // 재구축 신규 Master batch (기존/신규 구분 기준)
const SAMPLE = 20;                        // 추출 그룹 수
const OUT_DIR = process.env.DEDUP_REPORT_DIR || "/home/runner/veritas-reports";
const rrn13 = (s: unknown) => { const d = String(s ?? "").replace(/[^0-9]/g, ""); return d.length === 13 ? d : null; };
const maskRrn = (r: string | null | undefined) => (r ? `${r.slice(0, 6)}-*******` : "");

type M = {
  id: number; name: string; nameNorm: string; isNew: boolean;
  rrn: string | null;                    // 서버 내부 복호값(출력 금지, 비교 전용)
  phones: Set<string>; emails: Set<string>;
  historyRows: number; historyBasis: string; crm: string[];
};

type GroupAnalysis = {
  rrnMatch: string; phoneMatch: string; emailMatch: string;
  samePerson: string; namesake: string; infoShort: boolean;
  basis: string;
};

function analyzeGroup(members: M[]): GroupAnalysis {
  // ── 주민번호 일치: 주민번호 보유 Master가 2명 이상일 때만 판정 ──
  const withRrn = members.filter((m) => m.rrn);
  const rrnSet = new Set(withRrn.map((m) => m.rrn!));
  const rrnMatch = withRrn.length < 2 ? "판단불가(보유<2)" : rrnSet.size === 1 ? "일치" : "불일치";

  // ── 전화/이메일 공유 여부 ──
  const phoneCount = new Map<string, number>();
  for (const m of members) for (const p of m.phones) phoneCount.set(p, (phoneCount.get(p) ?? 0) + 1);
  const withPhone = members.filter((m) => m.phones.size > 0).length;
  const sharedPhone = [...phoneCount.values()].some((c) => c >= 2);
  const phoneMatch = withPhone < 2 ? "판단불가(보유<2)" : sharedPhone ? "일치(공유)" : "불일치";

  const emailCount = new Map<string, number>();
  for (const m of members) for (const e of m.emails) emailCount.set(e, (emailCount.get(e) ?? 0) + 1);
  const withEmail = members.filter((m) => m.emails.size > 0).length;
  const sharedEmail = [...emailCount.values()].some((c) => c >= 2);
  const emailMatch = withEmail < 2 ? "판단불가(보유<2)" : sharedEmail ? "일치(공유)" : "불일치";

  // ── 식별정보 부족: 주민번호·전화·이메일이 전부 없는 Master가 하나라도 있으면 true ──
  const noIdCount = members.filter((m) => !m.rrn && m.phones.size === 0 && m.emails.size === 0).length;
  const infoShort = noIdCount > 0;

  // ── 동일인 / 동명이인 가능성 + 근거 ──
  const reasons: string[] = [];
  let samePerson: string; let namesake: string;
  if (rrnMatch === "일치") {
    samePerson = "높음"; namesake = "낮음"; reasons.push("주민번호 일치");
  } else if (rrnMatch === "불일치") {
    samePerson = "낮음"; namesake = "높음"; reasons.push("주민번호 상이(서로 다른 사람)");
  } else if (sharedPhone && sharedEmail) {
    samePerson = "높음"; namesake = "낮음"; reasons.push("전화+이메일 모두 공유");
  } else if (sharedPhone || sharedEmail) {
    samePerson = "중간"; namesake = "중간"; reasons.push(sharedPhone ? "전화 공유" : "이메일 공유");
  } else {
    samePerson = "판단보류"; namesake = "중간"; reasons.push("공유 식별자 없음(이름만 일치)");
  }
  if (noIdCount > 0) reasons.push(`식별정보 없는 Master ${noIdCount}명 포함`);
  if (withRrn.length > 0 && withRrn.length < members.length) reasons.push("일부만 주민번호 보유");

  return { rrnMatch, phoneMatch, emailMatch, samePerson, namesake, infoShort, basis: reasons.join("; ") };
}

async function main() {
  const rows = (q: any) => (q as any).rows as any[];
  const newIds = new Set<number>(
    rows(await db.execute(sql`SELECT entity_id FROM import_row_sources WHERE batch_id=${BATCH}`)).map((r) => Number(r.entity_id)),
  );
  const users = rows(await db.execute(sql`SELECT id, name, email FROM users WHERE role='translator' AND deleted_at IS NULL`));
  const temails = rows(await db.execute(sql`SELECT translator_id tid, email FROM translator_emails`));
  const profiles = rows(await db.execute(sql`SELECT user_id uid, coalesce(phone,'') phone FROM translator_profiles`));
  const sens = rows(await db.execute(sql`SELECT translator_id tid, resident_number rn FROM translator_sensitive`));
  const maps = rows(await db.execute(sql`SELECT entity_id eid, btrim(legacy_id) lid FROM legacy_master_mappings WHERE entity_type='translator' AND status<>'rolled_back'`));
  // 진행관리표 수행이력 집계(주민번호 → 이름 순 매칭)
  const prog = rows(await db.execute(sql`SELECT nullif(btrim(source_raw->>'통번역사명'),'') nm, substring(regexp_replace(coalesce(source_raw->>'주민등록번호',''),'[^0-9]','','g') from 1 for 13) rrn FROM legacy_archive_rows WHERE source_type='progress' AND is_effective=true`));
  const progByRrn = new Map<string, number>(); const progByName = new Map<string, number>();
  for (const r of prog) {
    const rr = r.rrn && String(r.rrn).length === 13 ? String(r.rrn) : null;
    const nn = r.nm ? normalizeCompanyName(String(r.nm)) : "";
    if (rr) progByRrn.set(rr, (progByRrn.get(rr) ?? 0) + 1);
    if (nn) progByName.set(nn, (progByName.get(nn) ?? 0) + 1);
  }

  const M = new Map<number, M>();
  for (const u of users) {
    const id = Number(u.id);
    M.set(id, { id, name: u.name ?? "", nameNorm: normalizeCompanyName(u.name ?? ""), isNew: newIds.has(id), rrn: null, phones: new Set(), emails: new Set(), historyRows: 0, historyBasis: "", crm: [] });
  }
  const addEmail = (id: number, raw: string | null | undefined) => { if (!raw || isLegacyPlaceholderEmail(raw)) return; const e = normalizeEmail(raw); if (e) M.get(id)?.emails.add(e); };
  for (const u of users) addEmail(Number(u.id), u.email);
  for (const t of temails) { if (M.has(Number(t.tid))) addEmail(Number(t.tid), t.email); }
  for (const p of profiles) { const m = M.get(Number(p.uid)); if (m) { const ph = normalizePhone(p.phone); if (ph) m.phones.add(ph); } }
  for (const s of sens) { const m = M.get(Number(s.tid)); if (!m) continue; const raw = s.rn ? String(s.rn).trim() : ""; if (!raw) continue; try { const k = rrn13(decrypt(raw)); if (k) m.rrn = k; } catch { /* skip */ } }
  for (const mp of maps) { const m = M.get(Number(mp.eid)); if (m && mp.lid) m.crm.push(String(mp.lid)); }
  for (const m of M.values()) {
    if (m.rrn && progByRrn.has(m.rrn)) { m.historyRows = progByRrn.get(m.rrn)!; m.historyBasis = "주민번호"; }
    else if (m.nameNorm && progByName.has(m.nameNorm)) { m.historyRows = progByName.get(m.nameNorm)!; m.historyBasis = "이름"; }
  }

  // ── 이름 기준 그룹핑(정규화 이름이 2개 이상 Master에 등록) ──
  const byName = new Map<string, number[]>();
  for (const m of M.values()) { if (!m.nameNorm) continue; const a = byName.get(m.nameNorm) ?? []; a.push(m.id); byName.set(m.nameNorm, a); }
  const dupGroups = [...byName.entries()].filter(([, ids]) => ids.length >= 2);

  // ── 선정: 기존+신규 혼합 그룹 우선, 그 다음 규모 큰 순 ──
  const groupMeta = dupGroups.map(([nameNorm, ids]) => {
    const members = ids.map((id) => M.get(id)!);
    const hasNew = members.some((m) => m.isNew);
    const hasOld = members.some((m) => !m.isNew);
    return { nameNorm, ids, members, mixed: hasNew && hasOld, size: ids.length, name: members[0].name };
  });
  const totalDupGroups = groupMeta.length;
  const totalMixedGroups = groupMeta.filter((g) => g.mixed).length;
  groupMeta.sort((a, b) => {
    if (a.mixed !== b.mixed) return a.mixed ? -1 : 1;          // 혼합 우선
    if (b.size !== a.size) return b.size - a.size;             // 규모 큰 순
    return a.name.localeCompare(b.name, "ko");                 // 안정 정렬
  });
  const selected = groupMeta.slice(0, SAMPLE);

  // ── Excel 작성 ──
  const H = ["그룹", "통번역사명", "동일인가능성", "동명이인가능성", "Master ID", "기존/신규", "주민번호보유", "주민번호(마스킹)", "전화번호", "이메일", "통번역언어이력근거", "수행이력건수", "CRM원본연결", "등록출처"];
  const compareAoa: any[][] = [H];
  const analysisAoa: any[][] = [["그룹", "통번역사명", "Master수", "기존수", "신규수", "주민번호일치", "전화일치", "이메일일치", "동일인가능성", "동명이인가능성", "식별정보부족", "판단근거"]];

  const termLines: string[] = [];
  let gi = 0;
  for (const g of selected) {
    gi++;
    const gid = `G${gi}`;
    const a = analyzeGroup(g.members);
    const oldN = g.members.filter((m) => !m.isNew).length;
    const newN = g.members.filter((m) => m.isNew).length;

    // 비교표 시트 — 그룹의 모든 Master 나란히
    for (const m of g.members) {
      compareAoa.push([
        gid, m.name, a.samePerson, a.namesake, m.id, m.isNew ? "신규" : "기존",
        m.rrn ? "O" : "X", maskRrn(m.rrn),
        [...m.phones].join(", "), [...m.emails].join(", "), m.historyBasis,
        m.historyRows, m.crm.slice(0, 5).join(" / "), m.isNew ? `신규(batch${BATCH})` : "기존",
      ]);
    }
    analysisAoa.push([gid, g.name, g.members.length, oldN, newN, a.rrnMatch, a.phoneMatch, a.emailMatch, a.samePerson, a.namesake, a.infoShort ? "있음" : "없음", a.basis]);

    // 터미널 비교표
    termLines.push("");
    termLines.push(`═══ ${gid}  이름: ${g.name}  (Master ${g.members.length}명 · 기존 ${oldN}/신규 ${newN}${g.mixed ? " · 혼합" : ""}) ═══`);
    termLines.push(`  동일인가능성: ${a.samePerson}   동명이인가능성: ${a.namesake}   식별정보부족: ${a.infoShort ? "있음" : "없음"}`);
    termLines.push(`  일치: 주민번호[${a.rrnMatch}] 전화[${a.phoneMatch}] 이메일[${a.emailMatch}]`);
    termLines.push(`  근거: ${a.basis}`);
    termLines.push(`  ${"ID".padEnd(7)}${"구분".padEnd(5)}${"주민(마스킹)".padEnd(16)}${"전화".padEnd(14)}${"이력".padEnd(6)}이메일 / CRM`);
    for (const m of g.members) {
      const idc = String(m.id).padEnd(7);
      const gu = (m.isNew ? "신규" : "기존").padEnd(4);
      const rn = (m.rrn ? maskRrn(m.rrn) : "-").padEnd(16);
      const ph = ([...m.phones][0] ?? "-").padEnd(14);
      const hist = `${m.historyRows}`.padEnd(6);
      const em = [...m.emails][0] ?? "-";
      const crm = m.crm.length ? ` / CRM:${m.crm.slice(0, 3).join(",")}` : "";
      termLines.push(`  ${idc}${gu} ${rn}${ph}${hist}${em}${crm}`);
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(compareAoa), "1_그룹비교표");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(analysisAoa), "2_그룹분석");
  const summary: any[][] = [
    ["항목", "값"],
    ["전체 Master 수", M.size],
    ["  ├ 기존(재구축 이전)", [...M.values()].filter((m) => !m.isNew).length],
    ["  └ 신규(batch 182)", [...M.values()].filter((m) => m.isNew).length],
    ["동명 중복 그룹 총수(이름 2개 이상 Master)", totalDupGroups],
    ["  └ 기존+신규 혼합 그룹 수", totalMixedGroups],
    ["추출 샘플 그룹 수", selected.length],
    ["  └ 그 중 혼합 그룹", selected.filter((g) => g.mixed).length],
    ["추출 그룹 내 Master 합계", selected.reduce((a, g) => a + g.members.length, 0)],
    ["선정 기준", "기존+신규 혼합 우선 → 그룹 규모 큰 순 → 이름 가나다순"],
    ["주민번호 처리", "서버 내부 복호 후 일치 비교만, 출력은 YYMMDD-******* 마스킹"],
    ["작업 성격", "읽기 전용 · DB 미변경 · 통합/수정/삭제/커밋 없음"],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), "3_요약");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const outPath = path.join(OUT_DIR, `translator_name_dedup_${stamp}.xlsx`);
  XLSX.writeFile(wb, outPath);

  // ── 터미널 출력 ──
  console.log("");
  console.log("════════════════════════════════════════════════════════════════════");
  console.log(" VERITAS 통번역사 동명(同名) 중복 20개 그룹 — 읽기 전용 보고서");
  console.log("════════════════════════════════════════════════════════════════════");
  console.log(` 전체 Master ${M.size}명 (기존 ${[...M.values()].filter((m) => !m.isNew).length} / 신규 ${[...M.values()].filter((m) => m.isNew).length})`);
  console.log(` 동명 중복 그룹 총 ${totalDupGroups}개 (혼합 ${totalMixedGroups}개) → 샘플 ${selected.length}개 추출(혼합 우선)`);
  console.log(termLines.join("\n"));
  console.log("");
  console.log(`[Excel] ${outPath}`);

  const report = {
    total_masters: M.size,
    dup_name_groups: totalDupGroups,
    mixed_groups: totalMixedGroups,
    sampled_groups: selected.length,
    sampled_mixed: selected.filter((g) => g.mixed).length,
    sampled_master_count: selected.reduce((a, g) => a + g.members.length, 0),
    excel_path: outPath,
  };
  console.log("REPORT " + JSON.stringify(report));
  await pool.end().catch(() => {});
  process.exit(0);
}
main().catch(async (e) => { console.error("FATAL", e); try { await pool.end(); } catch { /* ignore */ } process.exit(1); });
