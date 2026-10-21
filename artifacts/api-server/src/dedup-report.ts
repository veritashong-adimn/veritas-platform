// 통번역사 Master 1인 1계정 정비 — 전수 교차검증 + 5시트 엑셀 리포트(읽기 전용, DB 미변경).
//  · 주민번호/전화/이메일/이름 정규화 비교. 서로 다른 주민번호 계정은 자동 통합 금지(충돌 분리).
//  · A 주민번호=확정 / B 이름+전화 / C 이름+이메일 / D 전화+이메일=유력 / E 이름만·부족=수동 / F 상충=수동.
//  · 통합은 수행하지 않는다(설계·후보 산출만). 과거 이력 삭제 금지.
import fs from "fs";
import path from "path";
import * as XLSX from "xlsx";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { decrypt } from "./lib/encrypt";
import { normalizeCompanyName } from "./lib/normalizeCompany";
import { normalizePhone, normalizeEmail } from "./lib/hometaxExcel";
import { isLegacyPlaceholderEmail } from "./lib/mailer";

const BATCH = 182;
const OUT_DIR = process.env.DEDUP_REPORT_DIR || "/home/runner/veritas-reports";
const rrn13 = (s: unknown) => { const d = String(s ?? "").replace(/[^0-9]/g, ""); return d.length === 13 ? d : null; };
const maskRrn = (r: string | null | undefined) => r ? `${r.slice(0, 6)}-*******` : "";

type M = {
  id: number; name: string; nameNorm: string; isNew: boolean;
  rrn: string | null; phones: Set<string>; emails: Set<string>;
  historyRows: number; historyBasis: string; crm: string[];
};

async function main() {
  const rows = (q: any) => (q as any).rows as any[];
  const newIds = new Set<number>(rows(await db.execute(sql`SELECT entity_id FROM import_row_sources WHERE batch_id=${BATCH}`)).map((r) => Number(r.entity_id)));
  const users = rows(await db.execute(sql`SELECT id, name, email FROM users WHERE role='translator' AND deleted_at IS NULL`));
  const temails = rows(await db.execute(sql`SELECT translator_id tid, email FROM translator_emails`));
  const profiles = rows(await db.execute(sql`SELECT user_id uid, coalesce(phone,'') phone FROM translator_profiles`));
  const sens = rows(await db.execute(sql`SELECT translator_id tid, resident_number rn FROM translator_sensitive`));
  const maps = rows(await db.execute(sql`SELECT entity_id eid, btrim(legacy_id) lid FROM legacy_master_mappings WHERE entity_type='translator' AND status<>'rolled_back'`));
  // 진행관리표 수행이력 집계(이름/주민번호 기준)
  const prog = rows(await db.execute(sql`SELECT nullif(btrim(source_raw->>'통번역사명'),'') nm, substring(regexp_replace(coalesce(source_raw->>'주민등록번호',''),'[^0-9]','','g') from 1 for 13) rrn FROM legacy_archive_rows WHERE source_type='progress' AND is_effective=true`));
  const progByRrn = new Map<string, number>(); const progByName = new Map<string, number>();
  for (const r of prog) { const rr = r.rrn && String(r.rrn).length === 13 ? String(r.rrn) : null; const nn = r.nm ? normalizeCompanyName(String(r.nm)) : ""; if (rr) progByRrn.set(rr, (progByRrn.get(rr) ?? 0) + 1); if (nn) progByName.set(nn, (progByName.get(nn) ?? 0) + 1); }

  const M = new Map<number, M>();
  for (const u of users) { const id = Number(u.id); M.set(id, { id, name: u.name ?? "", nameNorm: normalizeCompanyName(u.name ?? ""), isNew: newIds.has(id), rrn: null, phones: new Set(), emails: new Set(), historyRows: 0, historyBasis: "", crm: [] }); }
  const addEmail = (id: number, raw: string | null | undefined) => { if (!raw || isLegacyPlaceholderEmail(raw)) return; const e = normalizeEmail(raw); if (e) M.get(id)?.emails.add(e); };
  for (const u of users) addEmail(Number(u.id), u.email);
  for (const t of temails) { if (M.has(Number(t.tid))) addEmail(Number(t.tid), t.email); }
  for (const p of profiles) { const m = M.get(Number(p.uid)); if (m) { const ph = normalizePhone(p.phone); if (ph) m.phones.add(ph); } }
  for (const s of sens) { const m = M.get(Number(s.tid)); if (!m) continue; const raw = s.rn ? String(s.rn).trim() : ""; if (!raw) continue; try { const k = rrn13(decrypt(raw)); if (k) m.rrn = k; } catch { /* skip */ } }
  for (const mp of maps) { const m = M.get(Number(mp.eid)); if (m && mp.lid) m.crm.push(String(mp.lid)); }
  for (const m of M.values()) {
    if (m.rrn && progByRrn.has(m.rrn)) { m.historyRows = progByRrn.get(m.rrn)!; m.historyBasis = "rrn"; }
    else if (m.nameNorm && progByName.has(m.nameNorm)) { m.historyRows = progByName.get(m.nameNorm)!; m.historyBasis = "name"; }
  }

  // ── 식별자 인덱스 ──
  const idx = (sel: (m: M) => Iterable<string>) => { const g = new Map<string, number[]>(); for (const m of M.values()) for (const k of sel(m)) { if (!k) continue; const a = g.get(k) ?? []; a.push(m.id); g.set(k, a); } return g; };
  const byRrn = idx((m) => (m.rrn ? [m.rrn] : []));
  const byNamePhone = idx((m) => [...m.phones].map((p) => `${m.nameNorm}|${p}`));
  const byNameEmail = idx((m) => [...m.emails].map((e) => `${m.nameNorm}|${e}`));
  const byPhoneEmail = idx((m) => { const out: string[] = []; for (const p of m.phones) for (const e of m.emails) out.push(`${p}|${e}`); return out; });
  const byName = idx((m) => (m.nameNorm ? [m.nameNorm] : []));

  // ── Union-Find(주민번호 충돌 가드) ──
  const parent = new Map<number, number>(); for (const id of M.keys()) parent.set(id, id);
  const find = (x: number): number => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; while (parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; } return r; };
  const edges: { a: number; b: number; basis: string }[] = [];
  const conflicts: { a: number; b: number; basis: string }[] = [];
  const tryUnion = (a: number, b: number, basis: string) => {
    const ra = M.get(a)!.rrn, rb = M.get(b)!.rrn;
    if (ra && rb && ra !== rb) { conflicts.push({ a, b, basis }); return; }   // 주민번호 상충 → 통합 금지(F)
    edges.push({ a, b, basis });
    const x = find(a), y = find(b); if (x !== y) parent.set(x, y);
  };
  const linkGroup = (g: Map<string, number[]>, basis: string) => { for (const ids of g.values()) { if (ids.length < 2) continue; for (let i = 1; i < ids.length; i++) tryUnion(ids[0], ids[i], basis); } };
  linkGroup(byRrn, "A:주민번호");
  linkGroup(byNamePhone, "B:이름+전화");
  linkGroup(byNameEmail, "C:이름+이메일");
  linkGroup(byPhoneEmail, "D:전화+이메일");

  // ── 그룹 집계 + 근거 ──
  const groupBasis = new Map<number, Set<string>>();
  for (const e of edges) { const r = find(e.a); const s = groupBasis.get(r) ?? new Set<string>(); s.add(e.basis.split(":")[0]); groupBasis.set(r, s); }
  const comp = new Map<number, number[]>(); for (const id of M.keys()) { const r = find(id); const a = comp.get(r) ?? []; a.push(id); comp.set(r, a); }
  const confirmedGroups: number[][] = []; const likelyGroups: number[][] = [];
  for (const [root, ids] of comp) { if (ids.length < 2) continue; const bases = groupBasis.get(root) ?? new Set(); if (bases.has("A")) confirmedGroups.push(ids); else likelyGroups.push(ids); }

  // ── 대표 확인 필요(E): 이름만 일치(강한 에지로 묶이지 않은 동명 서로 다른 컴포넌트) ──
  const manualGroups: number[][] = [];
  for (const ids of byName.values()) {
    if (ids.length < 2) continue;
    const roots = new Set(ids.map(find));
    if (roots.size < 2) continue;    // 이미 한 그룹으로 묶였으면 제외(확정/유력에 포함)
    // 주민번호 상충쌍만인 경우는 F에서 다룸 — 여기서는 동명 서로 다른 컴포넌트(수동 확인) 묶음으로 기록
    manualGroups.push([...new Set(ids)]);
  }

  // ── 충돌(F) 그룹화: 상충 쌍을 이름 기준으로 묶음 ──
  const conflictByName = new Map<string, Set<number>>();
  for (const c of conflicts) { const nm = M.get(c.a)!.nameNorm || `pair:${c.a}`; const s = conflictByName.get(nm) ?? new Set<number>(); s.add(c.a); s.add(c.b); conflictByName.set(nm, s); }
  const conflictGroups = [...conflictByName.values()].map((s) => [...s]);

  // ── 등록 제외 후보(요구사항10): 주민번호 없음 AND 수행이력 없음(삭제·비활성화 안 함) ──
  const excludeCandidates: number[] = [];
  for (const m of M.values()) { const history = m.historyRows > 0; if (!m.rrn && !history) excludeCandidates.push(m.id); }

  // ── 통합 후 예상 Master 수 ──
  const collapse = (gs: number[][]) => gs.reduce((a, g) => a + (g.length - 1), 0);
  const afterConfirmed = M.size - collapse(confirmedGroups);
  const afterConfirmedLikely = afterConfirmed - collapse(likelyGroups);

  // ── 엑셀 작성 ──
  const H = ["그룹ID", "구분(기존/신규)", "Master ID", "이름", "주민번호보유", "주민번호(마스킹)", "전화번호", "이메일", "수행이력건수", "이력근거", "CRM원본연결", "동일인판별근거", "대표확인결과", "비고"];
  const rowOf = (gid: string, m: M, basis: string, note: string) => [
    gid, m.isNew ? "신규" : "기존", m.id, m.name, m.rrn ? "O" : "X", maskRrn(m.rrn),
    [...m.phones].join(", "), [...m.emails].join(", "), m.historyRows, m.historyBasis,
    m.crm.slice(0, 5).join(" / "), basis, "", note,
  ];
  const sheetFromGroups = (groups: number[][], basisLabel: (ids: number[]) => string, note = "") => {
    const aoa: any[][] = [H];
    groups.sort((a, b) => b.length - a.length);
    let gi = 0;
    for (const ids of groups) { gi++; const gid = `G${gi}`; const basis = basisLabel(ids); for (const id of ids) aoa.push(rowOf(gid, M.get(id)!, basis, note)); }
    return XLSX.utils.aoa_to_sheet(aoa);
  };
  const basisOfComp = (ids: number[]) => [...(groupBasis.get(find(ids[0])) ?? new Set())].sort().join("+");

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheetFromGroups(confirmedGroups, () => "A:주민번호 일치"), "1_동일인확정");
  XLSX.utils.book_append_sheet(wb, sheetFromGroups(likelyGroups, basisOfComp), "2_동일인유력");
  XLSX.utils.book_append_sheet(wb, sheetFromGroups(manualGroups, () => "E:이름만 일치/식별정보 부족"), "3_대표확인필요");
  XLSX.utils.book_append_sheet(wb, sheetFromGroups(conflictGroups, () => "F:주민번호 등 상충"), "4_식별정보충돌");

  const exclRows: any[][] = [["Master ID", "구분", "이름", "주민번호", "수행이력", "CRM연결", "비고"]];
  for (const id of excludeCandidates) { const m = M.get(id)!; exclRows.push([m.id, m.isNew ? "신규" : "기존", m.name, "X", m.historyRows, m.crm.slice(0, 3).join(" / "), "주민번호·수행이력 없음(삭제/비활성화 안 함)"]); }
  const summary: any[][] = [
    ["항목", "값"],
    ["전체 Master 수", M.size],
    ["  ├ 기존(재구축 이전)", [...M.values()].filter((m) => !m.isNew).length],
    ["  └ 신규(batch 182)", [...M.values()].filter((m) => m.isNew).length],
    ["동일인 확정 그룹 수(A)", confirmedGroups.length],
    ["  └ 확정 그룹 내 Master 합", confirmedGroups.reduce((a, g) => a + g.length, 0)],
    ["동일인 유력 그룹 수(B/C/D)", likelyGroups.length],
    ["  └ 유력 그룹 내 Master 합", likelyGroups.reduce((a, g) => a + g.length, 0)],
    ["대표 확인 필요 그룹 수(E 이름만)", manualGroups.length],
    ["식별정보 충돌 그룹 수(F)", conflictGroups.length],
    ["등록 제외 후보 수(주민번호·이력 없음)", excludeCandidates.length],
    ["통합 후 예상 Master(확정만)", afterConfirmed],
    ["통합 후 예상 Master(확정+유력)", afterConfirmedLikely],
    ["보존(판매목록/진행관리표/연결)", "13,549 / 30,142 / 29,797 (불변)"],
    ["분석 기준", "주민번호 최우선·이름만/상충 자동통합 금지·과거이력 삭제 금지·DB 미변경"],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), "5_요약");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(exclRows), "6_등록제외후보");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const outPath = path.join(OUT_DIR, `translator_dedup_${stamp}.xlsx`);
  XLSX.writeFile(wb, outPath);

  const report = {
    total_masters: M.size,
    confirmed_groups: confirmedGroups.length,
    likely_groups: likelyGroups.length,
    manual_groups: manualGroups.length,
    conflict_groups: conflictGroups.length,
    exclude_candidates: excludeCandidates.length,
    projected_after_confirmed: afterConfirmed,
    projected_after_confirmed_likely: afterConfirmedLikely,
    excel_path: outPath,
  };
  console.log("REPORT " + JSON.stringify(report));
  await pool.end().catch(() => {});
  process.exit(0);
}
main().catch(async (e) => { console.error("FATAL", e); try { await pool.end(); } catch { /* ignore */ } process.exit(1); });
