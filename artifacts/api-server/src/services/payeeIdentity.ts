// ─────────────────────────────────────────────────────────────────────────────
// 수행자 ↔ 실제 지급대상 신원 일치 점검(2026-11-28) — 지급준비점검·지급확정·은행이체 파일 공용.
//   · 수행정보의 수행자 신원(수행자 선택 시 저장된 주민번호 스냅샷 / 외주업체 사업자번호 스냅샷)과
//     실제 지급대상(통번역사 명부·외주업체 명부)의 신원정보를 대조한다. 이름보다 식별정보를 우선한다.
//       mismatch  = 식별정보가 서로 다름(확정 불일치) → 지급확정·은행이체 파일 생성 차단
//       name_diff = 식별정보 대조 불가 + 이름만 다름(개명·영문명·법인명 표기 차이 가능) → 참고 표시만(차단 안 함)
//       match / unverifiable = 정상 / 대조할 정보 없음(이름도 같음)
//   · 통번역사 Master 통합(translator_merges active)은 같은 사람으로 본다(대표·통합 Master 의 명부 주민번호 모두 인정).
//   · 주민번호·사업자번호 원문은 서버 메모리에서만 비교하고 결과·화면·로그에 넣지 않는다(이름·명부 id·사유만).
//   · 조회 전용 — 연결정보를 자동으로 바꾸지 않는다(정정은 판매관리 수행정보에서 수행자를 다시 선택해 저장).
// ─────────────────────────────────────────────────────────────────────────────
import { sql } from "drizzle-orm";
import { decrypt } from "../lib/encrypt";
import { loadSaleIdentities } from "./saleIdentity";

type Dbx = any;
const rows = async (dbx: Dbx, q: any) => (await dbx.execute(q)).rows as any[];
const digits = (v: unknown) => String(v ?? "").replace(/[^0-9]/g, "");
const dec13 = (v: unknown): string | null => {
  if (!v) return null;
  try { const d = digits(decrypt(String(v))); return d.length === 13 ? d : null; } catch { return null; }
};
const CORP = /\(\s*(주|유|사|재|합)\s*\)|㈜|주식회사|유한회사|유한책임회사|사단법인|재단법인/g;
const nameKey = (s: unknown) => String(s ?? "").replace(CORP, "").replace(/[\s.\-·,'"()]/g, "").toLowerCase();

export type IdentityTarget = { assignmentId: number; payeeType: "individual" | "vendor" | string | null; payeeId: number | null };
export type IdentityVerdict = {
  status: "match" | "mismatch" | "name_diff" | "unverifiable";
  basis: "resident_number" | "birth_date" | "business_number" | "name" | "none";
  performerName: string | null;       // 수행정보 수행자명(스냅샷)
  payeeName: string | null;           // 현재 연결된 지급대상(명부 이름)
  payeeId: number | null;
  identityOwner: { id: number; name: string | null }[];   // 수행자 식별정보와 일치하는 다른 명부(이름·id만)
  reason: string | null;              // 화면 표시용 사유(식별정보 원문 없음)
};

export async function checkPayeeIdentity(dbx: Dbx, targets: IdentityTarget[]): Promise<Map<number, IdentityVerdict>> {
  const out = new Map<number, IdentityVerdict>();
  const ts = targets.filter(t => t.assignmentId && t.payeeId != null && (t.payeeType === "individual" || t.payeeType === "vendor"));
  if (!ts.length) return out;
  const inList = (ids: number[]) => sql.join((ids.length ? ids : [-1]).map(i => sql`${i}`), sql`, `);
  const paIds = [...new Set(ts.map(t => t.assignmentId))];
  const pa = new Map((await rows(dbx, sql`SELECT id, performer_name_snapshot AS snap, identifier_snapshot_enc AS ienc, identifier_snapshot_masked AS imask
    FROM performance_assignments WHERE id IN (${inList(paIds)})`)).map(r => [Number(r.id), r]));

  // 개인 지급대상 — 같은 사람 묶음(Master 통합 대표·통합 Master) 단위로 명부 이름·별칭·주민번호
  const uids = [...new Set(ts.filter(t => t.payeeType === "individual").map(t => Number(t.payeeId)))];
  const merges = uids.length ? await rows(dbx, sql`SELECT merged_master_id AS m, representative_master_id AS r FROM translator_merges
    WHERE status = 'active' AND (merged_master_id IN (${inList(uids)}) OR representative_master_id IN (${inList(uids)}))`) : [];
  const groupOf = (uid: number) => {
    const rep = Number(merges.find(x => Number(x.m) === uid)?.r ?? uid);
    return [...new Set([uid, rep, ...merges.filter(x => Number(x.r) === rep).map(x => Number(x.m))])];
  };
  const groupIds = [...new Set(uids.flatMap(groupOf))];
  const uName = new Map((await rows(dbx, sql`SELECT id, name FROM users WHERE id IN (${inList(groupIds)})`)).map(r => [Number(r.id), r.name as string | null]));
  const uAlias = new Map<number, Set<string>>();
  for (const r of await rows(dbx, sql`SELECT translator_id, alias_name FROM translator_aliases WHERE translator_id IN (${inList(groupIds)})`)) {
    const s = uAlias.get(Number(r.translator_id)) ?? new Set<string>(); s.add(nameKey(r.alias_name)); uAlias.set(Number(r.translator_id), s);
  }
  const uRrn = new Map<number, string>();
  for (const r of await rows(dbx, sql`SELECT translator_id, resident_number FROM translator_sensitive WHERE translator_id IN (${inList(groupIds)}) AND coalesce(resident_number, '') <> ''`)) {
    const d = dec13(r.resident_number); if (d) uRrn.set(Number(r.translator_id), d);
  }
  // 수행자 주민번호와 일치하는 다른 명부(불일치 사유 표시용 — 이름·id만). 불일치 후보가 있을 때만 전체 명부를 조회한다.
  let rrnIndex: Map<string, number[]> | null = null;
  const ownersOf = async (rrn: string, exclude: number[]) => {
    if (!rrnIndex) {
      rrnIndex = new Map();
      for (const r of await rows(dbx, sql`SELECT ts.translator_id, ts.resident_number FROM translator_sensitive ts JOIN users u ON u.id = ts.translator_id AND u.deleted_at IS NULL
          WHERE coalesce(ts.resident_number, '') <> ''`)) {
        const d = dec13(r.resident_number); if (d) rrnIndex.set(d, [...(rrnIndex.get(d) ?? []), Number(r.translator_id)]);
      }
    }
    const ids = (rrnIndex.get(rrn) ?? []).filter(i => !exclude.includes(i));
    if (!ids.length) return [];
    const nm = new Map((await rows(dbx, sql`SELECT id, name FROM users WHERE id IN (${inList(ids)})`)).map(r => [Number(r.id), r.name as string | null]));
    return ids.map(i => ({ id: i, name: nm.get(i) ?? null }));
  };

  // 외주업체 지급대상 — 업체명·사업자번호
  const vids = [...new Set(ts.filter(t => t.payeeType === "vendor").map(t => Number(t.payeeId)))];
  const vRow = new Map((await rows(dbx, sql`SELECT id, name, business_number FROM companies WHERE id IN (${inList(vids)})`)).map(r => [Number(r.id), r]));

  for (const t of ts) {
    const p = pa.get(t.assignmentId); if (!p) continue;
    const performerName = (p.snap ?? null) as string | null;
    if (t.payeeType === "vendor") {
      const c = vRow.get(Number(t.payeeId));
      const snapBiz = digits(p.imask), coBiz = digits(c?.business_number);
      const v: IdentityVerdict = { status: "unverifiable", basis: "none", performerName, payeeName: c?.name ?? null, payeeId: Number(t.payeeId), identityOwner: [], reason: null };
      if (snapBiz.length === 10 && coBiz.length === 10) {
        v.basis = "business_number";
        if (snapBiz === coBiz) v.status = "match";
        else { v.status = "mismatch"; v.reason = `수행정보 외주업체(${performerName ?? "-"})의 사업자번호 ≠ 지급대상 업체(${c?.name ?? "-"}, #${t.payeeId}) 사업자번호`; }
      } else if (performerName && c?.name && nameKey(performerName) && nameKey(c.name) && !nameKey(c.name).includes(nameKey(performerName)) && !nameKey(performerName).includes(nameKey(c.name))) {
        v.status = "name_diff"; v.basis = "name"; v.reason = `업체명 표기 차이(수행정보 ${performerName} · 지급대상 ${c.name}) — 사업자번호 대조 불가`;
      } else if (performerName && c?.name) { v.status = "match"; v.basis = "name"; }
      out.set(t.assignmentId, v); continue;
    }
    const uid = Number(t.payeeId); const grp = groupOf(uid);
    const v: IdentityVerdict = { status: "unverifiable", basis: "none", performerName, payeeName: uName.get(uid) ?? null, payeeId: uid, identityOwner: [], reason: null };
    const snapRrn = dec13(p.ienc);
    const rosterRrns = grp.map(i => uRrn.get(i)).filter((x): x is string => !!x);
    const snapBirth = digits(String(p.imask ?? "").slice(0, 6));
    if (snapRrn && rosterRrns.length) {
      v.basis = "resident_number";
      if (rosterRrns.includes(snapRrn)) v.status = "match";
      else {
        v.status = "mismatch"; v.identityOwner = await ownersOf(snapRrn, grp);
        v.reason = `수행자 ${performerName ?? "-"}의 주민번호(수행정보) ≠ 지급대상 ${v.payeeName ?? "-"}(명부 #${uid}) 주민번호`
          + (v.identityOwner.length ? ` — 수행자 주민번호는 ${v.identityOwner.map(o => `${o.name ?? "-"}(명부 #${o.id})`).join(", ")} 명부와 일치` : "");
      }
    } else if (snapBirth.length === 6 && rosterRrns.length) {
      v.basis = "birth_date";
      if (rosterRrns.some(r => r.startsWith(snapBirth))) v.status = "match";
      else { v.status = "mismatch"; v.reason = `수행자 ${performerName ?? "-"}의 생년월일(수행정보) ≠ 지급대상 ${v.payeeName ?? "-"}(명부 #${uid}) 생년월일`; }
    }
    if (v.status === "unverifiable" && performerName) {
      const ok = grp.some(i => nameKey(uName.get(i)) === nameKey(performerName) || uAlias.get(i)?.has(nameKey(performerName)));
      v.basis = "name";
      if (ok) v.status = "match";
      else { v.status = "name_diff"; v.reason = `수행자명(${performerName}) ≠ 지급대상 명부명(${v.payeeName ?? "-"}, #${uid}) — 주민번호 대조 불가(개명·영문명·대리 지급 여부 확인)`; }
    }
    out.set(t.assignmentId, v);
  }
  return out;
}

// 지급확정·은행이체 파일 차단용 — 확정 불일치(mismatch)만 모아 화면 표시 항목과 함께 돌려준다.
export async function identityMismatchesOf(dbx: Dbx, targets: (IdentityTarget & { gross?: number | null; net?: number | null })[]) {
  const ver = await checkPayeeIdentity(dbx, targets);
  const bad = targets.filter(t => ver.get(t.assignmentId)?.status === "mismatch");
  if (!bad.length) return [];
  const inList = sql.join(bad.map(t => sql`${t.assignmentId}`), sql`, `);
  const info = new Map((await rows(dbx, sql`SELECT pa.id, pa.project_id,
      coalesce(nullif(btrim(p.company_name_snapshot), ''), nullif(btrim(c.name), '')) AS client
    FROM performance_assignments pa LEFT JOIN projects p ON p.id = pa.project_id LEFT JOIN companies c ON c.id = p.company_id
    WHERE pa.id IN (${inList})`)).map(r => [Number(r.id), r]));
  const pids = [...new Set([...info.values()].map(r => Number(r.project_id)).filter(Boolean))];
  const idn = pids.length ? await loadSaleIdentities(dbx, pids) : new Map();
  return bad.map(t => {
    const v = ver.get(t.assignmentId)!; const r = info.get(t.assignmentId);
    return { assignmentId: t.assignmentId, client: r?.client ?? null, saleNo: r?.project_id != null ? ((idn.get(Number(r.project_id)) as any)?.saleNumber ?? null) : null,
      performerName: v.performerName, payeeName: v.payeeName, payeeId: v.payeeId, gross: t.gross ?? null, net: t.net ?? null, reason: v.reason };
  });
}
