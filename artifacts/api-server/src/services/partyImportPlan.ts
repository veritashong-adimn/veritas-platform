// ─── 거래처·담당자 홈택스 최신화 — 판정 보정·고유 대상 집계·승인 토큰·배치 되돌리기 ──────────
// 기존 거래처/담당자 대량등록(analyzeCompanies/analyzeContacts) 결과를 그대로 쓰고, 아래만 보정한다.
//   · 개인 식별번호(13자리) 형태 값은 사업자등록번호로 쓰지 않고 '확인 필요'로 보류 + 화면·응답에서 마스킹.
//   · 같은 거래처(사업자번호)가 여러 행에 있고 행마다 값이 다르면 임의 선택하지 않고 '확인 필요'.
//   · 기존 담당자 일치 행의 연락처·부서·직책 변경을 감지해 '정보 수정'으로 분류(빈 셀은 덮어쓰지 않음).
//   · 담당자 오류 행을 A(성명 없음)·B(거래처 정보만)·C(개인 식별번호)·D(거래처 연결 불가)·E(형식 오류)로 분류.
//   · 화면은 행이 아니라 '고유 대상' 기준(거래처 1곳 = 1, 담당자 1명 = 1)으로 6개 항목만 집계.
// DB 구조 변경 없음. 변경 이력은 import_row_sources(batch 단위)에 before/after 로 남기고 되돌리기에 사용한다.
import crypto from "node:crypto";
import { sql, eq, and, inArray } from "drizzle-orm";
import { db, companiesTable, contactsTable, importBatchesTable, importRowSourcesTable } from "@workspace/db";
import { normalizeEmail, normalizePhone, normalizeName, normalizeCompanyNameKey } from "../lib/hometaxExcel";

export type PartyCategory = "same" | "new" | "update" | "review" | "individual" | "excluded";
export const PARTY_CATEGORY_LABEL: Record<PartyCategory, string> = { same: "기존 동일", new: "신규 등록", update: "정보 수정", review: "확인 필요", individual: "개인 고객 분리", excluded: "등록 제외" };

// 13자리 숫자(주민·외국인등록번호 형태) — 사업자등록번호(10자리)와 구분.
export function isPersonalIdLike(raw: string | null | undefined): boolean {
  return String(raw ?? "").replace(/\D/g, "").length === 13;
}
export function maskPersonalId(raw: string | null | undefined): string {
  const d = String(raw ?? "").replace(/\D/g, "");
  return d.length === 13 ? `${d.slice(0, 6)}-${d[6]}******` : String(raw ?? "");
}

type AnyRow = { rowNumber: number; status: string; reason?: string; existingId?: number | null; changes?: Record<string, { old: string; new: string }>;
  businessNumber: string; businessNumberNorm: string; category?: PartyCategory; categoryReason?: string; groupKey?: string };

// ── 거래처 ──────────────────────────────────────────────────────────────────
const COMPANY_GROUP_FIELDS = ["name", "representativeName", "industry", "businessCategory", "address"] as const;

export function refineCompanyRows<R extends AnyRow & Record<string, any>>(rows: R[]): R[] {
  // ① 개인 식별번호 형태 → 사업자번호로 처리하지 않음 + 마스킹.
  //    거래처명이 없으면 개인 고객 자료로 분리(사업자 거래처 등록 제외·기존 개인 고객 자동 연결 없음). 거래처명이 있으면 확인 필요.
  for (const r of rows) {
    if (isPersonalIdLike(r.businessNumber)) {
      r.businessNumber = maskPersonalId(r.businessNumber); r.businessNumberNorm = ""; r.existingId = null; r.changes = undefined;
      if (!String(r.name ?? "").trim()) {
        r.status = "error"; r.reason = "개인 고객 자료로 분리 — 사업자 거래처 등록 제외(개인 식별번호 미저장·자동 연결 없음)";
        r.category = "individual"; r.categoryReason = "individual";
      } else {
        r.status = "needs_review"; r.reason = "개인 식별번호 형태 값 — 사업자등록번호로 처리하지 않음(확인 필요)";
        r.category = "review"; r.categoryReason = "personal_id";
      }
    }
  }
  // ② 같은 거래처(기존 일치 또는 파일 내 같은 사업자번호)의 여러 행 값 상이 → 임의 선택 금지(확인 필요)
  const groups = new Map<string, R[]>();
  for (const r of rows) {
    if (r.categoryReason === "personal_id" || r.categoryReason === "individual") continue;
    const k = r.existingId != null && (r.status === "update" || r.status === "identical") && r.businessNumberNorm ? `m:${r.existingId}` : r.businessNumberNorm ? `b:${r.businessNumberNorm}` : "";
    if (!k) continue;
    r.groupKey = k;
    const a = groups.get(k); if (a) a.push(r); else groups.set(k, [r]);
  }
  for (const [k, g] of groups) {
    if (g.length < 2) continue;
    // 최신 엑셀 내부에서 같은 사업자번호 행끼리 값이 실제로 다를 때만 충돌(표기 차이 — 공백·(주)·대소문자 — 는 같은 값)
    const nv = (f: string, v: unknown) => f === "name" ? normalizeCompanyNameKey(String(v ?? "")) : String(v ?? "").replace(/[\s,.()\-]/g, "").toLowerCase();
    const conflictFields = COMPANY_GROUP_FIELDS.filter(f => new Set(g.map(r => nv(f, r[f])).filter(Boolean)).size >= 2);
    if (conflictFields.length) {
      for (const r of g) {
        if (r.status === "error") continue;
        r.status = "needs_review"; r.reason = `같은 거래처 ${g.length}행의 값이 서로 다름(${conflictFields.join("·")}) — 임의 선택하지 않음`; r.changes = undefined;
      }
      continue;
    }
    if (k.startsWith("m:")) {
      // 값이 모두 같으면 수정은 1행만 반영, 나머지 행은 같은 거래처의 중복 행으로 표시
      const upd = g.filter(r => r.status === "update");
      upd.slice(1).forEach(r => { r.status = "duplicate_file"; r.reason = `같은 거래처의 중복 행(${upd[0].rowNumber}행 기준 반영)`; r.changes = undefined; });
    }
  }
  for (const r of rows) if (!r.category) r.category = mapCategory(r.status);
  return rows;
}

function mapCategory(status: string): PartyCategory {
  if (status === "identical") return "same";
  if (status === "new") return "new";
  if (status === "update") return "update";
  if (status === "needs_review" || status === "conflict") return "review";
  if (status === "duplicate_file") return "same";       // 대표 행과 같은 대상(고유 집계에서 제외)
  return "excluded";
}

// 고유 대상 집계 — 같은 거래처·같은 담당자의 여러 행은 1건. 우선순위: 확인 필요 > 정보 수정 > 신규 > 기존 동일 > 제외
const PRIO: PartyCategory[] = ["review", "update", "new", "same", "individual", "excluded"];
export function uniqueSummary(rows: AnyRow[], keyOf: (r: AnyRow) => string) {
  const g = new Map<string, PartyCategory>();
  const excludedReasons: Record<string, number> = {};
  for (const r of rows) {
    const c = r.category ?? mapCategory(r.status);
    const k = keyOf(r);
    const cur = g.get(k);
    if (!cur || PRIO.indexOf(c) < PRIO.indexOf(cur)) g.set(k, c);
  }
  const counts: Record<PartyCategory, number> = { same: 0, new: 0, update: 0, review: 0, individual: 0, excluded: 0 };
  for (const c of g.values()) counts[c]++;
  for (const r of rows) if ((r.category ?? mapCategory(r.status)) === "excluded") { const k = r.categoryReason ?? r.reason ?? "기타"; excludedReasons[k] = (excludedReasons[k] ?? 0) + 1; }
  return { uniqueTotal: g.size, counts, rows: rows.length, duplicateRows: rows.filter(r => r.status === "duplicate_file").length, excludedReasons };
}
export const companyKey = (r: AnyRow) => r.existingId != null && r.status !== "needs_review" ? `m:${r.existingId}` : r.businessNumberNorm ? `b:${r.businessNumberNorm}` : `r:${r.rowNumber}`;

// ── 담당자 ──────────────────────────────────────────────────────────────────
type ContactLike = AnyRow & { name: string; companyId: number | null; email: string; emailNorm: string; mobile: string; mobileNorm: string; officePhone: string; officePhoneNorm: string; department: string; position: string };
export const CONTACT_UPDATE_FIELDS = ["email", "mobile", "officePhone", "department", "position"] as const;

export async function refineContactRows<R extends ContactLike>(rows: R[], dbx: any = db): Promise<R[]> {
  // ① 오류 행 분류(A·B·C·D·E) + 개인 식별번호 마스킹
  for (const r of rows) {
    if (isPersonalIdLike(r.businessNumber)) {
      r.businessNumber = maskPersonalId(r.businessNumber); r.businessNumberNorm = "";
      if (r.status !== "error" || r.name) { r.status = "needs_review"; r.reason = "C. 개인 식별번호 형태 값 — 사업자등록번호로 자동 해석하지 않음"; r.existingId = null; r.category = "review"; r.categoryReason = "C_personal_id"; continue; }
    }
    if (r.status === "error" && !r.name) {
      const hasContact = !!(r.emailNorm || r.mobileNorm || r.officePhoneNorm || r.department || r.position);
      r.category = "excluded";
      r.categoryReason = hasContact ? "A_no_name" : "B_company_only";
      r.reason = hasContact ? "A. 담당자 성명 없음 — 담당자 등록 대상 아님" : "B. 거래처 정보만 있는 행 — 담당자 등록 제외(거래처 등록에서 처리)";
      continue;
    }
    if ((r.status === "error" || r.status === "needs_review") && r.companyId == null && r.name) {
      r.status = "needs_review"; r.category = "review"; r.categoryReason = "D_company_link";
      r.reason = `D. 거래처 연결 확인 필요 — ${r.reason ?? "거래처를 찾을 수 없음"}`;
      continue;
    }
    if (r.status === "error") { r.category = "excluded"; r.categoryReason = "E_error"; r.reason = `E. ${r.reason ?? "형식 오류"}`; }
  }
  // ② 기존 담당자 일치 행 → 변경 감지(빈 셀은 덮어쓰지 않음)
  const ids = [...new Set(rows.filter(r => r.status === "identical" && r.existingId != null).map(r => r.existingId!))];
  const ex = new Map<number, any>();
  for (let i = 0; i < ids.length; i += 2000) {
    const chunk = ids.slice(i, i + 2000);
    const rs = await dbx.select({ id: contactsTable.id, email: contactsTable.email, mobile: contactsTable.mobile, officePhone: contactsTable.officePhone, department: contactsTable.department, position: contactsTable.position })
      .from(contactsTable).where(inArray(contactsTable.id, chunk));
    for (const c of rs) ex.set(c.id, c);
  }
  for (const r of rows) {
    if (r.status !== "identical" || r.existingId == null) continue;
    const c = ex.get(r.existingId); if (!c) continue;
    const pairs: [string, string, string | null, (s: string) => string][] = [
      ["email", r.emailNorm, c.email, s => normalizeEmail(s)],
      ["mobile", r.mobileNorm, c.mobile, s => normalizePhone(s)],
      ["officePhone", r.officePhoneNorm, c.officePhone, s => normalizePhone(s)],
      ["department", r.department, c.department, s => normalizeName(s)],
      ["position", r.position, c.position, s => normalizeName(s)],
    ];
    const changes: Record<string, { old: string; new: string }> = {};
    for (const [k, xv, dv, n] of pairs) {
      const a = n(xv ?? ""); if (!a) continue;              // 엑셀 공란 → 기존 보존
      if (a === n(dv ?? "")) continue;
      changes[k] = { old: dv ?? "", new: xv };
    }
    if (Object.keys(changes).length) { r.status = "update"; r.reason = "기존 담당자 정보 변경(이메일·휴대폰·전화·부서·직책)"; r.changes = changes; }
  }
  // ③ 같은 기존 담당자를 가리키는 여러 행 — 값이 다르면 확인 필요, 같으면 1행만 반영
  const byEx = new Map<number, R[]>();
  for (const r of rows) if ((r.status === "update" || r.status === "identical") && r.existingId != null) { const a = byEx.get(r.existingId) ?? []; a.push(r); byEx.set(r.existingId, a); }
  for (const g of byEx.values()) {
    if (g.length < 2) continue;
    const sig = (r: R) => JSON.stringify(Object.entries(r.changes ?? {}).sort());
    const upd = g.filter(r => r.status === "update");
    if (new Set(upd.map(sig)).size >= 2) { for (const r of upd) { r.status = "needs_review"; r.reason = "같은 담당자의 여러 행 값이 서로 다름 — 확인 필요"; r.changes = undefined; } continue; }
    upd.slice(1).forEach(r => { r.status = "duplicate_file"; r.reason = `같은 담당자의 중복 행(${upd[0].rowNumber}행 기준 반영)`; r.changes = undefined; });
  }
  for (const r of rows) if (!r.category) r.category = mapCategory(r.status);
  return rows;
}
export const contactKey = (r: any) => r.existingId != null && r.status !== "needs_review" ? `c:${r.existingId}`
  : r.companyId != null ? `n:${r.companyId}|${r.emailNorm || r.mobileNorm || normalizeName(r.name)}` : `r:${r.rowNumber}`;

// ── 승인 토큰(미리보기 이후 기준 데이터 변경 감지) ───────────────────────────────
export async function partyPlanToken(kind: "company" | "contact", fileBuf: Buffer): Promise<string> {
  const fh = crypto.createHash("sha256").update(fileBuf).digest("hex");
  const r = (await db.execute(kind === "company"
    ? sql`SELECT count(*)::int n, coalesce(max(id),0)::int m, md5(coalesce(string_agg(id||':'||coalesce(updated_at::text,'')||':'||coalesce(deleted_at::text,''), ',' ORDER BY id),'')) h FROM companies`
    : sql`SELECT count(*)::int n, coalesce(max(id),0)::int m, md5(coalesce(string_agg(id||':'||updated_at::text||':'||coalesce(deleted_at::text,'')||':'||is_active, ',' ORDER BY id),'')) h FROM contacts`)).rows[0] as any;
  const c2 = kind === "contact" ? ((await db.execute(sql`SELECT count(*)::int n, coalesce(max(id),0)::int m FROM companies WHERE deleted_at IS NULL`)).rows[0] as any) : { n: 0, m: 0 };
  return crypto.createHash("sha256").update(`${kind}|${fh}|${r.n}|${r.m}|${r.h}|${c2.n}|${c2.m}`).digest("hex").slice(0, 32);
}

// ── 배치 되돌리기 ───────────────────────────────────────────────────────────
// 신규: 이후 업무 연결(담당자·프로젝트·견적·의뢰 등)이 없을 때만 소프트 삭제. 수정: 현재 값이 이 배치가 넣은 값일 때만 이전 값 복원.
export async function planPartyRollback(batchId: number) {
  const [b] = await db.select().from(importBatchesTable).where(eq(importBatchesTable.id, batchId)).limit(1);
  const base = { ok: false, reason: "", batchId, module: b?.module ?? null, created: 0, createdRollbackable: 0, createdKept: 0, updated: 0, fieldsRestorable: 0, fieldsKept: 0 };
  if (!b || (b.module !== "company" && b.module !== "contact")) return { ...base, reason: "거래처·담당자 등록 배치가 아닙니다." };
  if (b.status === "rolled_back") return { ...base, reason: "이미 되돌린 배치입니다." };
  const logs = (await db.execute(sql`SELECT entity_id, status, source_raw FROM import_row_sources WHERE batch_id = ${batchId} AND status IN ('new','update')`)).rows as any[];
  const res = { ...base, ok: true, reason: "되돌리기 가능" };
  for (const l of logs) {
    if (l.status === "new") { res.created++; (await hasDependencies(b.module, Number(l.entity_id))) ? res.createdKept++ : res.createdRollbackable++; continue; }
    if (!l.source_raw?.fields) continue;
    res.updated++;
    const cur = await currentRow(b.module, Number(l.entity_id));
    for (const f of l.source_raw.fields) (String(cur?.[f.key] ?? "") === String(f.after ?? "")) ? res.fieldsRestorable++ : res.fieldsKept++;
  }
  if (res.createdKept || res.fieldsKept) res.reason = "되돌리기 가능(이후 연결·변경된 항목은 보존)";
  return res;
}
async function hasDependencies(module: string, id: number): Promise<boolean> {
  const q = module === "company"
    ? sql`SELECT (SELECT count(*) FROM contacts WHERE company_id = ${id} AND deleted_at IS NULL) + (SELECT count(*) FROM projects WHERE company_id = ${id}) +
        (SELECT count(*) FROM inquiries WHERE company_id = ${id}) + (SELECT count(*) FROM divisions WHERE company_id = ${id}) AS n`
    : sql`SELECT (SELECT count(*) FROM projects WHERE contact_id = ${id}) + (SELECT count(*) FROM inquiries WHERE contact_id = ${id}) AS n`;
  return Number(((await db.execute(q)).rows[0] as any).n) > 0;
}
async function currentRow(module: string, id: number): Promise<Record<string, unknown> | null> {
  const [r] = module === "company" ? await db.select().from(companiesTable).where(eq(companiesTable.id, id)).limit(1) : await db.select().from(contactsTable).where(eq(contactsTable.id, id)).limit(1);
  return (r as any) ?? null;
}
export async function executePartyRollback(batchId: number, performerId: number | null) {
  const plan = await planPartyRollback(batchId);
  if (!plan.ok) throw Object.assign(new Error(plan.reason), { status: 409 });
  const module = plan.module as "company" | "contact";
  const table: any = module === "company" ? companiesTable : contactsTable;
  return db.transaction(async (tx) => {
    const logs = (await tx.execute(sql`SELECT entity_id, status, source_raw FROM import_row_sources WHERE batch_id = ${batchId} AND status IN ('new','update') ORDER BY id DESC`)).rows as any[];
    let softDeleted = 0, restored = 0, kept = 0;
    for (const l of logs) {
      const id = Number(l.entity_id);
      if (l.status === "new") {
        if (await hasDependencies(module, id)) { kept++; continue; }
        const r = await tx.update(table).set({ deletedAt: new Date(), deletionReason: `대량등록 배치 #${batchId} 되돌리기` }).where(and(eq(table.id, id), sql`${table.deletedAt} IS NULL`)).returning({ id: table.id });
        softDeleted += r.length; continue;
      }
      const cur = await currentRow(module, id);
      const set: Record<string, unknown> = {};
      for (const f of (l.source_raw?.fields ?? [])) { if (String(cur?.[f.key] ?? "") === String(f.after ?? "")) set[f.key] = f.before == null || f.before === "" ? null : f.before; else kept++; }   // 원래 빈 값은 NULL 로 복원
      if (Object.keys(set).length) { await tx.update(table).set(set).where(eq(table.id, id)); restored += Object.keys(set).length; }
    }
    await tx.update(importBatchesTable).set({ status: "rolled_back" }).where(eq(importBatchesTable.id, batchId));
    await tx.insert(importRowSourcesTable).values({ batchId, module, entityId: null, rowKey: "rollback", status: "rolled_back", sourceRaw: { performerId, softDeleted, restored, kept, at: new Date().toISOString() } });
    return { ...plan, softDeleted, restored, kept };
  });
}
export async function listPartyBatches(module: "company" | "contact") {
  return (await db.execute(sql`
    SELECT b.id, b.original_filename, b.status, b.created_at,
      (SELECT count(*)::int FROM import_row_sources s WHERE s.batch_id = b.id AND s.status = 'new') AS created,
      (SELECT count(*)::int FROM import_row_sources s WHERE s.batch_id = b.id AND s.status = 'update') AS updated
    FROM import_batches b WHERE b.module = ${module} ORDER BY b.id DESC LIMIT 10`)).rows;
}

// ── 거래처 '확인 필요' 검토: 기존 거래처 비교 정보 + 관리자 결정(등록/수정/보류) ─────────────────
//   · 비교: 기존 거래처 ID가 있으면 기존 등록정보와 업로드 정보를 나란히 표시.
//   · 허용 동작: 수정 = 기존 거래처 ID가 있을 때만 / 등록 = 같은 사업자번호의 기존 거래처가 없을 때만(중복 생성 방지).
//   · 결정이 없으면 보류(반영 안 함). 같은 거래처에 '수정' 2행 이상, 같은 사업자번호에 '등록' 2행 이상은 거부.
const REVIEW_FIELDS = ["name", "representativeName", "industry", "businessCategory", "address"] as const;
export async function attachCompanyReviewInfo(rows: any[]) {
  const review = rows.filter(r => r.status === "needs_review" || r.status === "conflict");
  if (!review.length) return;
  const ids = [...new Set(review.map(r => r.existingId).filter((x: any) => x != null))] as number[];
  const ex = new Map<number, any>();
  if (ids.length) for (const c of await db.select({ id: companiesTable.id, name: companiesTable.name, businessNumber: companiesTable.businessNumber, representativeName: companiesTable.representativeName,
    industry: companiesTable.industry, businessCategory: companiesTable.businessCategory, address: companiesTable.address }).from(companiesTable).where(inArray(companiesTable.id, ids))) ex.set(c.id, c);
  const bizSet = new Set(((await db.execute(sql`SELECT regexp_replace(coalesce(business_number,''),'[^0-9]','','g') b FROM companies WHERE deleted_at IS NULL AND coalesce(business_number,'') <> ''`)).rows as any[]).map(r => r.b));
  for (const r of review) {
    const e = r.existingId != null ? ex.get(r.existingId) : null;
    r.review = {
      existing: e ? Object.fromEntries(["id", ...REVIEW_FIELDS, "businessNumber"].map(k => [k, e[k] ?? null])) : null,
      upload: Object.fromEntries(REVIEW_FIELDS.map(k => [k, r[k] || null])),
      allowUpdate: !!e,
      allowNew: !e && !(r.businessNumberNorm && bizSet.has(r.businessNumberNorm)),
    };
  }
}

export function applyCompanyReviewDecisions(rows: any[], decisions: Record<string, string>, existingById: Map<number, any>): string | null {
  const updTargets = new Set<number>(), newBiz = new Set<string>();
  for (const r of rows) {
    if (r.status !== "needs_review" && r.status !== "conflict") continue;
    const d = decisions[String(r.rowNumber)];
    if (!d || d === "hold") continue;
    if (d === "update") {
      const e = r.existingId != null ? existingById.get(r.existingId) : null;
      if (!e) return `${r.rowNumber}행: 기존 거래처가 없어 '수정'을 선택할 수 없습니다.`;
      if (updTargets.has(e.id)) return `기존 거래처 #${e.id} 에 '수정'이 2행 이상 선택되었습니다. 1행만 선택하세요.`;
      updTargets.add(e.id);
      const changes: Record<string, { old: string; new: string }> = {};
      for (const k of REVIEW_FIELDS) { const v = String(r[k] ?? "").trim(); if (v && v !== String(e[k] ?? "").trim()) changes[k] = { old: e[k] ?? "", new: v }; }   // 빈 셀은 덮어쓰지 않음
      r.status = Object.keys(changes).length ? "update" : "identical"; r.changes = changes; r.reason = "관리자 결정: 기존 거래처 수정";
    } else if (d === "new") {
      if (r.existingId != null) return `${r.rowNumber}행: 기존 거래처와 연결된 행은 '등록'할 수 없습니다(중복 생성 방지).`;
      if (r.businessNumberNorm) { if (newBiz.has(r.businessNumberNorm)) return `같은 사업자등록번호에 '등록'이 2행 이상 선택되었습니다. 1행만 선택하세요.`; newBiz.add(r.businessNumberNorm); }
      if (r.categoryReason === "personal_id") r.businessNumber = "";   // 개인 식별번호는 사업자번호로 저장하지 않음
      r.status = "new"; r.reason = "관리자 결정: 신규 등록";
    }
  }
  return null;
}
