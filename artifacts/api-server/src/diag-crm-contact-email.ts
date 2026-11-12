// ─── 과거 CRM 판매 담당자 이메일 정합성 진단 (읽기 전용) ─────────────────────────────
//
// 실행: DIAG_DB_URL=<접속 문자열 env> DIAG_OUT=<출력 폴더> pnpm run diag:crm-contact-email
//   · 하나의 연결에서 BEGIN TRANSACTION READ ONLY 로만 조회하고 마지막에 ROLLBACK 한다(쓰기 시 DB 가 거부).
//   · 접속 문자열은 화면·파일에 출력하지 않는다.
//
// 대상: 유효(is_effective) 과거 CRM 판매목록 행 전체. 운영 판매로 전환된 건(legacy_master_mappings 'sale')과
//       과거 CRM 보관 자료(미전환)를 구분한다.
//
// 비교 기준(코드와 같은 규칙)
//   · CRM 원본 담당자명 = 확정 연결된 진행관리표 '고객명'이 1명일 때(classifySales A)
//   · CRM 원본 이메일   = 진행관리표/판매목록에 이메일 칸이 없다. 진행관리표 '비고'에 원본 고객명과 함께 적힌 이메일만(saleContactInfo 와 같은 규칙)
//   · 담당자 Master    = 전환 판매: projects.contact_id / 미전환: legacy_master_mappings('sale_contact')
//   · 판매상세 이메일   = 전환 판매: 현재 견적 수신자(고정값 있으면 고정값, 없으면 Master) / 미전환: saleContactInfo.effectiveEmail(Master → 원본 → 거래처)
//   · 견적서 출력 이메일 = 전환 판매: 판매상세와 같은 API 값 / 미전환: 플랫폼 견적서 없음(null)
//
// 유형(한 판매건이 여러 유형에 해당할 수 있다)
//   A CRM 이메일 있음 + Master 이메일 공란            B CRM 이메일 ≠ Master 이메일
//   C 판매상세 이메일 ≠ Master 이메일(Master 연결 건)  D 표시 이메일이 같은 거래처의 다른 담당자 이메일과 같음
//   E 담당자 Master 연결 없음                          F 연결 Master 이름 ≠ 원본 고객명(확인) / 동명 연결이나 원본·Master 번호 불일치(의심)
//   G CRM 원본에 이메일 없음                           H 원본 고객명 미확정(없음·복수)으로 판단 불가
import { drizzle } from "drizzle-orm/neon-serverless";
import { sql } from "drizzle-orm";
import { pool as appPool } from "@workspace/db";
import * as fs from "node:fs";
import * as path from "node:path";
import { classifySales, personKey, normPhone, invalidCustomerName } from "./services/legacyContactRestore";

// @workspace/db 와 같은 드라이버(WebSocket 설정 포함)의 Pool 클래스로 진단 대상 DB 에 별도 연결한다(앱 기본 DB 는 사용하지 않음)
const Pool = appPool.constructor as new (o: { connectionString: string }) => typeof appPool;
const url = process.env.DIAG_DB_URL;
const outDir = process.env.DIAG_OUT;
if (!url || !outDir) { console.error("DIAG_DB_URL, DIAG_OUT 필요"); process.exit(2); }

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const em = (v: unknown) => { const s = String(v ?? "").trim().toLowerCase(); return s || null; };
const ids = (xs: number[]) => sql.join(xs.map(x => sql`${x}`), sql`, `);

async function main() {
  const pool = new Pool({ connectionString: url! });
  const client = await pool.connect();
  await client.query("BEGIN TRANSACTION READ ONLY");
  const dbx = drizzle(client as any);
  const q = async (s: any) => (await dbx.execute(s)).rows as any[];
  try {
    const [ro] = await q(sql`SELECT current_setting('transaction_read_only') ro`);
    if (ro.ro !== "on") throw new Error("읽기 전용 트랜잭션이 아닙니다 — 중단");

    const list = await classifySales(dbx as any);
    // 원본 '비고' 이메일(판매별 · 원본 고객명 행만)
    const memoRows = await q(sql`SELECT s.id sale_row_id, btrim(p.source_raw->>'고객명') cust, p.source_raw->>'비고' memo
      FROM legacy_archive_rows s JOIN legacy_sales_progress_links l ON l.sale_row_id = s.id AND l.decision = 'confirmed'
      JOIN legacy_archive_rows p ON p.id = l.progress_row_id AND p.is_effective
      WHERE s.source_type = 'sales_list' AND s.is_effective AND p.source_raw->>'비고' ~ '@'`);
    const memoBySale = new Map<number, any[]>();
    for (const m of memoRows) (memoBySale.get(Number(m.sale_row_id)) ?? memoBySale.set(Number(m.sale_row_id), []).get(Number(m.sale_row_id))!).push(m);
    const [progMemoEmailRows] = await q(sql`SELECT count(*) n FROM legacy_archive_rows WHERE source_type='progress' AND is_effective AND source_raw->>'비고' ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}'`);
    const [progTotal] = await q(sql`SELECT count(*) n FROM legacy_archive_rows WHERE source_type='progress' AND is_effective`);

    // 전환 판매 + 현재 견적 수신자
    const acts = new Map((await q(sql`SELECT m.legacy_id, p.id pid, p.contact_id, p.company_id,
        q.id qid, q.quote_number, q.issue_date, q.customer_contact_email, q.customer_contact_name,
        (q.customer_company_name IS NOT NULL OR q.customer_contact_name IS NOT NULL OR q.customer_contact_position IS NOT NULL OR q.customer_contact_department IS NOT NULL
          OR q.customer_contact_phone IS NOT NULL OR q.customer_contact_mobile IS NOT NULL OR q.customer_contact_email IS NOT NULL) fixed
      FROM legacy_master_mappings m JOIN projects p ON p.id = m.entity_id
      LEFT JOIN LATERAL (SELECT * FROM quotes qq WHERE qq.project_id = p.id AND qq.deleted_at IS NULL ORDER BY qq.is_current DESC, qq.id DESC LIMIT 1) q ON true
      WHERE m.source_system='old_crm' AND m.entity_type='sale' AND m.status='active'`)).map(a => [String(a.legacy_id), a]));
    const mapVia = new Map((await q(sql`SELECT legacy_id, match_method FROM legacy_master_mappings WHERE source_system='old_crm' AND entity_type='sale_contact' AND status='active'`)).map(m => [String(m.legacy_id), String(m.match_method)]));
    const contacts = new Map((await q(sql`SELECT id, company_id, name, email, phone, mobile, office_phone, deleted_at, memo FROM contacts`)).map(c => [Number(c.id), c]));
    const emailOwners = new Map<string, number[]>();   // company|email → contact ids
    for (const c of contacts.values()) { const e = em(c.email); if (e && !c.deleted_at) { const k = `${c.company_id}|${e}`; (emailOwners.get(k) ?? emailOwners.set(k, []).get(k)!).push(Number(c.id)); } }
    const companies = new Map((await q(sql`SELECT id, name, email FROM companies`)).map(c => [Number(c.id), c]));
    // 회사 이메일이 같은 거래처 담당자 개인 이메일인 경우
    const coEmailIsPerson = (coId: number | null) => { if (!coId) return null; const e = em(companies.get(coId)?.email); if (!e) return null; return emailOwners.get(`${coId}|${e}`) ?? null; };

    const out: any[] = [];
    for (const r of list) {
      const act = r.saleNo ? acts.get(r.saleNo) : undefined;
      const converted = !!act;
      const companyId = act?.company_id ? Number(act.company_id) : (r.companyId ?? null);
      const linkedId = act ? (act.contact_id ? Number(act.contact_id) : null) : (r.linkedContactId ?? null);
      const m = linkedId ? contacts.get(linkedId) : null;
      const restored = r.cls === "A" ? r.customerName ?? null : null;
      // 원본 이메일(비고) — 원본 고객명과 함께 적힌 것만
      const srcEmails = restored ? [...new Set((memoBySale.get(r.saleRowId) ?? []).filter(x => !invalidCustomerName(x.cust) && personKey(x.cust) === personKey(restored)
        && EMAIL_RE.test(x.memo) && String(x.memo).replace(/\s/g, "").includes(restored.replace(/\s/g, "")) && !/(페이팔|paypal|메일변경|원천세)/i.test(x.memo))
        .map(x => String(x.memo).match(EMAIL_RE)![0].toLowerCase()))] : [];
      const srcEmail = srcEmails[0] ?? null;
      const masterEmail = m && !m.deleted_at ? em(m.email) : null;
      const coEmail = companyId ? em(companies.get(companyId)?.email) : null;
      let detailEmail: string | null, detailFrom: string | null, printEmail: string | null;
      if (converted) {
        detailEmail = act.qid ? (act.fixed ? em(act.customer_contact_email) : masterEmail) : null;
        detailFrom = !act.qid ? "no_quote" : act.fixed ? "quote_fixed" : "master_live";
        printEmail = detailEmail;
      } else {
        detailEmail = masterEmail ?? srcEmail ?? coEmail;
        detailFrom = masterEmail ? "master" : srcEmail ? "source" : coEmail ? "company" : null;
        printEmail = null;
      }
      const flags: string[] = [];
      if (srcEmail && m && !masterEmail) flags.push("A");
      if (srcEmail && masterEmail && srcEmail !== masterEmail) flags.push("B");
      if (m && (detailEmail ?? "") !== (masterEmail ?? "")) flags.push("C");
      let dOwner: number[] = [];
      if (detailEmail && companyId) { dOwner = (emailOwners.get(`${companyId}|${detailEmail}`) ?? []).filter(id => id !== linkedId); if (dOwner.length && !(masterEmail && masterEmail === detailEmail)) flags.push("D"); }
      if (!linkedId) flags.push("E");
      let fKind: string | null = null;
      if (m && restored && personKey(m.name) !== personKey(restored)) { flags.push("F"); fKind = "name_mismatch"; }
      else if (m && restored) {
        const mNums = [m.phone, m.mobile, m.office_phone].map(normPhone).filter((t: string) => t.length >= 7);
        const pTels = r.personalTels ?? [];
        if (pTels.length && mNums.length && !pTels.some(t => mNums.includes(t))) { flags.push("F?"); fKind = "same_name_phone_mismatch"; }
      }
      if (!srcEmail) flags.push("G");
      if (r.cls !== "A") flags.push("H");
      const via = act ? "project" : (r.saleNo ? mapVia.get(r.saleNo) ?? null : null);
      out.push({
        saleNo: r.saleNo, saleRowId: r.saleRowId, scope: converted ? "운영전환" : "과거CRM보관",
        quoteNumber: act?.quote_number ?? null, quoteId: act?.qid ?? null, projectId: act?.pid ?? null,
        company: r.company, companyId, crmContactName: restored, crmCandidates: r.cls === "B" ? (r.candidates ?? []).join("/") : null,
        crmEmail: srcEmail, crmPhones: (r.tels ?? []).join("/"),
        masterId: linkedId, masterName: m?.name ?? null, masterEmail, masterPhone: m ? [m.mobile, m.phone, m.office_phone].filter(Boolean).join("/") : null,
        masterCreatedBy: m?.memo && String(m.memo).startsWith("과거 CRM 자동 등록") ? "auto_name_created" : null, linkVia: via,
        detailEmail, detailFrom, printEmail, companyEmail: coEmail,
        companyEmailIsContact: coEmailIsPerson(companyId)?.join("/") ?? null,
        otherOwnerOfShownEmail: dOwner.join("/") || null, fKind,
        // 연결 담당자가 원본 개인번호로 확인되는지(이름만 같은 자동 연결 구분용)
        phoneVerified: linkedId ? (r.master === "exact" && r.contactId === linkedId) : null, cls: r.cls, reason: r.reason, flags: flags.join(","),
      });
    }

    // 요약
    const by = (scope: string | null) => out.filter(o => !scope || o.scope === scope);
    const cnt = (xs: any[], f: string) => xs.filter(o => o.flags.split(",").includes(f)).length;
    const summary: any = { total: out.length, converted: by("운영전환").length, archive: by("과거CRM보관").length,
      progressRowsTotal: Number(progTotal.n), progressRowsWithEmailInMemo: Number(progMemoEmailRows.n), byType: {} };
    for (const f of ["A", "B", "C", "D", "E", "F", "F?", "G", "H"])
      summary.byType[f] = { total: cnt(out, f), 운영전환: cnt(by("운영전환"), f), 과거CRM보관: cnt(by("과거CRM보관"), f) };
    summary.detail = {
      archiveShownCompanyEmail: out.filter(o => o.scope === "과거CRM보관" && o.detailFrom === "company").length,
      archiveShownCompanyEmailWithLinkedMaster: out.filter(o => o.scope === "과거CRM보관" && o.detailFrom === "company" && o.masterId).length,
      archiveShownCompanyEmailThatIsAnotherContacts: out.filter(o => o.scope === "과거CRM보관" && o.detailFrom === "company" && o.otherOwnerOfShownEmail).length,
      convertedQuoteFixed: out.filter(o => o.scope === "운영전환" && o.detailFrom === "quote_fixed").length,
      convertedQuoteEmailEqualsCompanyEmail: out.filter(o => o.scope === "운영전환" && o.detailEmail && o.detailEmail === o.companyEmail && o.detailEmail !== o.masterEmail).length,
      masterLinkedTotal: out.filter(o => o.masterId).length,
      masterLinkedNoEmail: out.filter(o => o.masterId && !o.masterEmail).length,
      masterAutoCreatedLinked: out.filter(o => o.masterCreatedBy).length,
      linkVia: out.reduce((a: any, o) => { const k = o.linkVia ?? "none"; a[k] = (a[k] ?? 0) + 1; return a; }, {}),
      clsCounts: { A: out.filter(o => o.cls === "A").length, B: out.filter(o => o.cls === "B").length, C: out.filter(o => o.cls === "C").length },
      linkedNameOnlyNotPhoneVerified: out.filter(o => (o.linkVia === "auto_name" || o.linkVia === "auto_name_created") && o.phoneVerified === false).length,
      eWithSingleName: out.filter(o => o.flags.includes("E") && o.cls === "A").length,
      clean: out.filter(o => o.masterId && o.masterEmail && !/[ABCDF]/.test(o.flags.replace("F?", ""))).length,
    };
    fs.mkdirSync(outDir!, { recursive: true });
    const cols = Object.keys(out[0] ?? {});
    const csvCell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    fs.writeFileSync(path.join(outDir!, "crm_contact_email_diag.csv"), "﻿" + [cols.join(","), ...out.map(o => cols.map(c => csvCell(o[c])).join(","))].join("\n"));
    fs.writeFileSync(path.join(outDir!, "crm_contact_email_diag_summary.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await pool.end();
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e?.message ?? e); process.exit(1); });
