// @ts-nocheck — 개발 DB → 운영 DB 확정 데이터 이관 실행기(1회성, 대표 승인 2026-10-26). esbuild 번들로 실행.
//   SRC_DATABASE_URL(개발, 읽기 전용) → DST_DATABASE_URL(운영 또는 리허설 복제본). 접속 문자열은 출력하지 않는다.
// 원칙: 운영 기존 ID·업무 데이터 보존(삭제·덮어쓰기 없음) · 신규는 운영에서 새 ID 발급 후 연결 재매핑 ·
//       기존 행은 개발 최신 값으로 '비어 있지 않고 다른' 항목만 업데이트 · 보류 대상 제외 · 단일 트랜잭션(오류 시 전체 롤백) ·
//       완료 표식(import_batches.module='dev_migration')이 있으면 재실행 거부(중복 방지).
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
neonConfig.webSocketConstructor = ws;

const SRC = process.env.SRC_DATABASE_URL, DST = process.env.DST_DATABASE_URL;
const MODE = process.argv[2] === "apply" ? "apply" : "dry";
if (!SRC || !DST || SRC === DST) { console.error("SRC/DST 접속정보가 없거나 같습니다."); process.exit(1); }
const src = new Pool({ connectionString: SRC }), dstPool = new Pool({ connectionString: DST });
const q = async (db, s, p = []) => (await db.query(s, p)).rows;
const log = (...a) => console.log(...a);

const nameKey = (s) => String(s ?? "").replace(/\s|\(주\)|㈜|주식회사|\(유\)|유한회사/g, "").toLowerCase();
const digits = (s) => String(s ?? "").replace(/\D/g, "");
const nn = (v) => v != null && String(v).trim() !== "";
const PLACEHOLDER = /@crm-migrated\.invalid$/i;

async function cols(db, table) { return (await q(db, `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table])); }
// 다중행 INSERT(500행 단위). rows: 객체 배열(컬럼명 키). returning id 순서 = 입력 순서.
async function insertMany(db, table, rows, colInfo, { returning = "id", conflict = "" } = {}) {
  if (!rows.length) return [];
  const names = colInfo.map(c => c.column_name).filter(c => c !== "id");
  const isJson = new Set(colInfo.filter(c => c.data_type === "jsonb" || c.data_type === "json").map(c => c.column_name));
  const out = [];
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500); const params = []; const tuples = [];
    for (const r of chunk) { tuples.push(`(${names.map(n => { const v = r[n] === undefined ? null : r[n]; params.push(isJson.has(n) && v != null && typeof v !== "string" ? JSON.stringify(v) : v); return `$${params.length}`; }).join(",")})`); }
    const res = await db.query(`INSERT INTO ${table} (${names.map(n => `"${n}"`).join(",")}) VALUES ${tuples.join(",")} ${conflict} ${returning ? `RETURNING ${returning}` : ""}`, params);
    out.push(...res.rows);
  }
  return out;
}
const pick = (row, colInfo, over = {}) => { const o = {}; for (const c of colInfo) if (c.column_name !== "id") o[c.column_name] = c.column_name in over ? over[c.column_name] : row[c.column_name]; return o; };

async function main() {
  const t0 = Date.now();
  const dst = await dstPool.connect();
  const done = await q(dst, `SELECT id FROM import_batches WHERE module='dev_migration' AND status='completed' LIMIT 1`);
  if (done.length) { log(`이미 이관 완료된 배치 #${done[0].id} 가 있어 재실행하지 않습니다(중복 방지).`); process.exit(2); }
  const report = { tables: {}, held: {}, links: {}, errors: [] };
  const add = (t, k, n = 1) => { report.tables[t] = report.tables[t] ?? { inserted: 0, updated: 0, matched: 0 }; report.tables[t][k] += n; };

  // ── 개발 원천(읽기 전용) ──
  const S = {};
  for (const t of ["companies", "contacts", "company_aliases", "company_name_history", "company_sensitive", "company_vendor_profiles", "divisions",
    "users", "translator_profiles", "translator_emails", "translator_aliases", "translator_sensitive", "translator_rates", "translator_merges",
    "import_batches", "legacy_archive_rows", "legacy_sales_progress_links", "legacy_master_mappings"]) S[t] = await q(src, `SELECT * FROM ${t}`);
  log("개발 원천 적재:", Object.fromEntries(Object.entries(S).map(([k, v]) => [k, v.length])));

  if (MODE === "apply") await dst.query("BEGIN");
  try {
    const C = {}; for (const t of Object.keys(S)) C[t] = await cols(dst, t);
    const [mig] = MODE === "apply" ? await q(dst, `INSERT INTO import_batches (module, import_type, original_filename, total_rows, success_rows, status, source_system, is_current)
      VALUES ('dev_migration','dev_to_prod','개발DB 확정 데이터 이관(2026-10-26 승인)',0,0,'running','veritas_dev',false) RETURNING id`) : [{ id: 0 }];
    const mapLogs = [];
    const mark = (table, devId, prodId, status) => mapLogs.push({ batch_id: mig.id, module: "dev_migration", entity_id: prodId, row_key: `${table}:${devId}`, status, source_system: "veritas_dev", legacy_id: String(devId) });

    // ── 1. 거래처 ──
    const P_comp = await q(dst, `SELECT id, business_number, name, representative_name, address, industry, business_category, deleted_at FROM companies`);
    const pBiz = new Map(), pName = new Map();
    for (const p of P_comp) { if (p.deleted_at) continue; const b = digits(p.business_number); const k = b ? `b:${b}` : `n:${nameKey(p.name)}`; const m = b ? pBiz : pName; const a = m.get(k) ?? []; a.push(p); m.set(k, a); }
    const compMap = new Map(); const newComps = [];
    for (const d of S.companies.filter(c => !c.deleted_at)) {
      const b = digits(d.business_number); const cand = b ? (pBiz.get(`b:${b}`) ?? []) : (pName.get(`n:${nameKey(d.name)}`) ?? []);
      if (cand.length > 1) { report.held.companies_ambiguous = (report.held.companies_ambiguous ?? 0) + 1; continue; }
      if (cand.length === 1) {
        const p = cand[0]; compMap.set(d.id, p.id); add("companies", "matched");
        const set = {}; for (const f of ["name", "representative_name", "address", "industry", "business_category"]) if (nn(d[f]) && String(d[f]).trim() !== String(p[f] ?? "").trim()) set[f] = d[f];
        if (Object.keys(set).length) {
          if (MODE === "apply") {
            const keys = Object.keys(set);
            await dst.query(`UPDATE companies SET ${keys.map((k, i) => `"${k}"=$${i + 1}`).join(",")}, updated_at=now() WHERE id=$${keys.length + 1}`, [...keys.map(k => set[k]), p.id]);
            if (set.name) {
              await dst.query(`UPDATE company_name_history SET valid_to=current_date::text, name_type='previous' WHERE company_id=$1 AND name_type='current'`, [p.id]);
              await dst.query(`INSERT INTO company_name_history (company_id, company_name, name_type, valid_from, reason) VALUES ($1,$2,'current',current_date::text,'개발DB 이관(홈택스 최신)')`, [p.id, set.name]);
            }
          }
          add("companies", "updated"); mark("companies", d.id, p.id, "updated");
        }
      } else newComps.push(d);
    }
    if (MODE === "apply") {
      const ins = await insertMany(dst, "companies", newComps.map(d => pick(d, C.companies, { deleted_by: null })), C.companies);
      newComps.forEach((d, i) => { compMap.set(d.id, ins[i].id); mark("companies", d.id, ins[i].id, "inserted"); });
      const newIds = new Set(newComps.map(d => d.id));
      for (const [t, conflict] of [["company_aliases", "ON CONFLICT DO NOTHING"], ["company_name_history", ""], ["company_sensitive", ""], ["company_vendor_profiles", ""]]) {
        let rows = S[t].filter(r => newIds.has(r.company_id));
        if (t === "company_sensitive" || t === "company_vendor_profiles") {   // 기존 거래처는 운영에 없을 때만
          const have = new Set((await q(dst, `SELECT company_id FROM ${t}`)).map(r => r.company_id));
          rows = S[t].filter(r => compMap.has(r.company_id) && !have.has(compMap.get(r.company_id)));
        }
        const r2 = await insertMany(dst, t, rows.map(r => pick(r, C[t], { company_id: compMap.get(r.company_id), ...("changed_by" in r ? { changed_by: null } : {}), ...("deleted_by" in r ? { deleted_by: null } : {}) })), C[t], { conflict });
        add(t, "inserted", r2.length);
      }
    }
    add("companies", "inserted", newComps.length);

    // ── 2. 부서(division) 매핑 ──
    const P_div = MODE === "apply" ? await q(dst, `SELECT id, company_id, name FROM divisions`) : [];
    const divMap = new Map();
    for (const d of S.divisions) {
      const pc = compMap.get(d.company_id); if (!pc) continue;
      const ex = P_div.find(p => p.company_id === pc && nameKey(p.name) === nameKey(d.name));
      if (ex) { divMap.set(d.id, ex.id); continue; }
      if (MODE === "apply") { const [r] = await insertMany(dst, "divisions", [pick(d, C.divisions, { company_id: pc })], C.divisions); divMap.set(d.id, r.id); }
      add("divisions", "inserted");
    }

    // ── 3. 담당자 ──
    const P_cont = await q(dst, `SELECT id, company_id, email, mobile, department, position, office_phone, deleted_at, is_active FROM contacts`);
    const pk = new Map();
    for (const p of P_cont) { if (p.deleted_at || !p.is_active) continue; for (const k of [p.email && `e:${p.company_id}:${String(p.email).trim().toLowerCase()}`, p.mobile && `m:${p.company_id}:${digits(p.mobile)}`]) if (k) { const a = pk.get(k) ?? []; a.push(p); pk.set(k, a); } }
    const newConts = [];
    for (const d of S.contacts.filter(c => !c.deleted_at && c.is_active)) {
      const pc = compMap.get(d.company_id); if (!pc) { report.held.contacts_company_unmapped = (report.held.contacts_company_unmapped ?? 0) + 1; continue; }
      const cand = new Map(); for (const k of [d.email && `e:${pc}:${String(d.email).trim().toLowerCase()}`, d.mobile && `m:${pc}:${digits(d.mobile)}`]) if (k) for (const p of pk.get(k) ?? []) cand.set(p.id, p);
      if (cand.size > 1) { report.held.contacts_ambiguous = (report.held.contacts_ambiguous ?? 0) + 1; continue; }
      if (cand.size === 1) {
        const p = [...cand.values()][0]; add("contacts", "matched");
        const set = {}; for (const f of ["email", "mobile", "department", "position", "office_phone"]) { const dv = f === "mobile" || f === "office_phone" ? digits(d[f]) : String(d[f] ?? "").trim(); const pv = f === "mobile" || f === "office_phone" ? digits(p[f]) : String(p[f] ?? "").trim(); if (dv && dv !== pv) set[f] = d[f]; }
        if (Object.keys(set).length) {
          if (MODE === "apply") { const keys = Object.keys(set); await dst.query(`UPDATE contacts SET ${keys.map((k, i) => `"${k}"=$${i + 1}`).join(",")}, updated_at=now() WHERE id=$${keys.length + 1}`, [...keys.map(k => set[k]), p.id]); }
          add("contacts", "updated"); mark("contacts", d.id, p.id, "updated");
        }
      } else newConts.push(d);
    }
    if (MODE === "apply") {
      const ins = await insertMany(dst, "contacts", newConts.map(d => pick(d, C.contacts, { company_id: compMap.get(d.company_id), division_id: d.division_id ? (divMap.get(d.division_id) ?? null) : null, deleted_by: null })), C.contacts);
      newConts.forEach((d, i) => mark("contacts", d.id, ins[i].id, "inserted"));
    }
    add("contacts", "inserted", newConts.length);

    // ── 4. 통번역사 Master(유효 + 통합·제외) ──
    const P_users = await q(dst, `SELECT u.id, u.name, lower(btrim(u.email)) em, u.role, regexp_replace(coalesce(p.phone,''),'[^0-9]','','g') ph FROM users u LEFT JOIN translator_profiles p ON p.user_id=u.id`);
    const pEmailAny = new Set(P_users.map(u => u.em).filter(Boolean));
    const pt = P_users.filter(u => u.role === "translator");
    const idx = new Map(); const addI = (k, id) => { if (!k) return; const s = idx.get(k) ?? new Set(); s.add(id); idx.set(k, s); };
    for (const u of pt) { addI(`n:${nameKey(u.name)}`, u.id); if (u.em && !PLACEHOLDER.test(u.em)) addI(`e:${u.em}`, u.id); if (u.ph) addI(`p:${u.ph}`, u.id); }
    const dProf = new Map(S.translator_profiles.map(p => [p.user_id, p]));
    const userMap = new Map(); const newUsers = [];
    for (const d of S.users.filter(u => u.role === "translator")) {
      const em = String(d.email ?? "").trim().toLowerCase(); const ph = digits(dProf.get(d.id)?.phone);
      const nameSet = idx.get(`n:${nameKey(d.name)}`) ?? new Set();
      const ids = new Set([...(em && !PLACEHOLDER.test(em) ? idx.get(`e:${em}`) ?? [] : []), ...(ph ? idx.get(`p:${ph}`) ?? [] : [])].filter(id => nameSet.has(id)));
      if (!d.deleted_at && ids.size === 1) { const pid = [...ids][0]; userMap.set(d.id, pid); add("users(translator)", "matched"); mark("users", d.id, pid, "matched"); continue; }
      if (ids.size > 1) { report.held.translators_ambiguous = (report.held.translators_ambiguous ?? 0) + 1; continue; }
      if (!d.deleted_at && nameSet.size > 0) { report.held.translators_same_name_unconfirmed = (report.held.translators_same_name_unconfirmed ?? 0) + 1; continue; }   // 이름만 같음 → 보류
      if (em && pEmailAny.has(em)) { report.held.translators_email_in_use = (report.held.translators_email_in_use ?? 0) + 1; continue; }
      newUsers.push(d);
    }
    if (MODE === "apply") {
      const ins = await insertMany(dst, "users", newUsers.map(d => pick(d, C.users, { role_id: null, company_id: null, deleted_by: null, invite_token: null })), C.users);
      newUsers.forEach((d, i) => { userMap.set(d.id, ins[i].id); mark("users", d.id, ins[i].id, "inserted"); });
      const newIds = new Set(newUsers.map(d => d.id));
      // 부속: 신규 Master 는 전부, 기존 일치 Master 는 운영에 없는 이메일·별칭만(덮어쓰기 없음)
      const prof = await insertMany(dst, "translator_profiles", S.translator_profiles.filter(p => newIds.has(p.user_id))
        .map(p => pick(p, C.translator_profiles, { user_id: userMap.get(p.user_id), affiliated_company_id: p.affiliated_company_id ? (compMap.get(p.affiliated_company_id) ?? null) : null })), C.translator_profiles);
      add("translator_profiles", "inserted", prof.length);
      for (const t of ["translator_emails", "translator_aliases"]) {
        const r = await insertMany(dst, t, S[t].filter(x => userMap.has(x.translator_id)).map(x => pick(x, C[t], { translator_id: userMap.get(x.translator_id) })), C[t], { conflict: "ON CONFLICT DO NOTHING" });
        add(t, "inserted", r.length);
      }
      const haveSens = new Set((await q(dst, `SELECT translator_id FROM translator_sensitive`)).map(r => r.translator_id));
      const sens = await insertMany(dst, "translator_sensitive", S.translator_sensitive.filter(x => userMap.has(x.translator_id) && !haveSens.has(userMap.get(x.translator_id)))
        .map(x => pick(x, C.translator_sensitive, { translator_id: userMap.get(x.translator_id) })), C.translator_sensitive);
      add("translator_sensitive", "inserted", sens.length);
      const rates = await insertMany(dst, "translator_rates", S.translator_rates.filter(x => newIds.has(x.translator_id)).map(x => pick(x, C.translator_rates, { translator_id: userMap.get(x.translator_id) })), C.translator_rates);
      add("translator_rates", "inserted", rates.length);
      const merges = await insertMany(dst, "translator_merges", S.translator_merges.filter(m => userMap.has(m.merged_master_id) && userMap.has(m.representative_master_id))
        .map(m => pick(m, C.translator_merges, { merged_master_id: userMap.get(m.merged_master_id), representative_master_id: userMap.get(m.representative_master_id), performed_by: null, reverted_by: null })), C.translator_merges);
      add("translator_merges", "inserted", merges.length);
    }
    add("users(translator)", "inserted", newUsers.length);

    // ── 5. 과거 CRM(배치·원본행·판매-진행 연결·수행이력 매핑) ──
    const legBatches = S.import_batches.filter(b => b.module === "legacy_archive");
    const batchMap = new Map(); const rowMap = new Map();
    if (MODE === "apply") {
      const bi = await insertMany(dst, "import_batches", legBatches.map(b => pick(b, C.import_batches, { created_by: null })), C.import_batches);
      legBatches.forEach((b, i) => batchMap.set(b.id, bi[i].id));
      const rows = S.legacy_archive_rows;
      const ri = await insertMany(dst, "legacy_archive_rows", rows.map(r => pick(r, C.legacy_archive_rows, { import_batch_id: r.import_batch_id ? (batchMap.get(r.import_batch_id) ?? null) : null, superseded_by_id: null })), C.legacy_archive_rows);
      rows.forEach((r, i) => rowMap.set(r.id, ri[i].id));
      const sup = rows.filter(r => r.superseded_by_id && rowMap.has(r.superseded_by_id));
      for (const r of sup) await dst.query(`UPDATE legacy_archive_rows SET superseded_by_id=$1 WHERE id=$2`, [rowMap.get(r.superseded_by_id), rowMap.get(r.id)]);
      report.links.superseded_remapped = sup.length;
      const links = S.legacy_sales_progress_links.filter(l => rowMap.has(l.sale_row_id) && rowMap.has(l.progress_row_id));
      const li = await insertMany(dst, "legacy_sales_progress_links", links.map(l => pick(l, C.legacy_sales_progress_links, { sale_row_id: rowMap.get(l.sale_row_id), progress_row_id: rowMap.get(l.progress_row_id) })), C.legacy_sales_progress_links, { conflict: "ON CONFLICT DO NOTHING" });
      add("legacy_sales_progress_links", "inserted", li.length);
      const maps = S.legacy_master_mappings.filter(m => m.entity_type !== "translator" || userMap.has(m.entity_id));
      report.held.mappings_translator_unmapped = S.legacy_master_mappings.length - maps.length;
      const mi = await insertMany(dst, "legacy_master_mappings", maps.map(m => pick(m, C.legacy_master_mappings, { entity_id: m.entity_type === "translator" ? userMap.get(m.entity_id) : m.entity_id, import_batch_id: m.import_batch_id ? (batchMap.get(m.import_batch_id) ?? null) : null, created_by: null })), C.legacy_master_mappings, { conflict: "ON CONFLICT DO NOTHING" });
      add("legacy_master_mappings", "inserted", mi.length);
    }
    add("import_batches(legacy)", "inserted", legBatches.length);
    add("legacy_archive_rows", "inserted", S.legacy_archive_rows.length);
    if (MODE === "dry") { add("legacy_sales_progress_links", "inserted", S.legacy_sales_progress_links.length); add("legacy_master_mappings", "inserted", S.legacy_master_mappings.length); }

    // ── 6. 매핑 기록 + 검증 + 커밋 ──
    if (MODE === "apply") {
      for (const r of [...rowMap.entries()]) mapLogs.push({ batch_id: mig.id, module: "dev_migration", entity_id: r[1], row_key: `legacy_archive_rows:${r[0]}`, status: "inserted", source_system: "veritas_dev", legacy_id: String(r[0]) });
      const irsCols = (await cols(dst, "import_row_sources")).filter(c => ["batch_id", "module", "entity_id", "row_key", "status", "source_system", "legacy_id"].includes(c.column_name));
      await insertMany(dst, "import_row_sources", mapLogs, irsCols, { returning: "" });
      const v = (await q(dst, `SELECT
        (SELECT count(*) FROM legacy_sales_progress_links l WHERE NOT EXISTS (SELECT 1 FROM legacy_archive_rows r WHERE r.id=l.sale_row_id) OR NOT EXISTS (SELECT 1 FROM legacy_archive_rows r WHERE r.id=l.progress_row_id))::int orphan_links,
        (SELECT count(*) FROM legacy_master_mappings m WHERE m.entity_type='translator' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id=m.entity_id))::int orphan_maps,
        (SELECT count(*) FROM contacts k WHERE NOT EXISTS (SELECT 1 FROM companies c WHERE c.id=k.company_id))::int orphan_contacts,
        (SELECT count(*) FROM translator_profiles p WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id=p.user_id))::int orphan_profiles,
        (SELECT count(*) FROM (SELECT logical_group_key FROM legacy_archive_rows WHERE is_effective AND logical_group_key IS NOT NULL GROUP BY 1 HAVING count(*)>1) x)::int dup_effective_groups`))[0];
      report.verify = v;
      if (Object.values(v).some(n => Number(n) > 0)) throw new Error(`검증 실패: ${JSON.stringify(v)} — 전체 롤백`);
      await dst.query(`UPDATE import_batches SET status='completed', success_rows=$1, total_rows=$1 WHERE id=$2`, [mapLogs.length, mig.id]);
      await dst.query("COMMIT");
      report.migrationBatchId = mig.id;
    }
  } catch (e) {
    if (MODE === "apply") await dst.query("ROLLBACK");
    report.errors.push(String(e?.message ?? e));
  }
  dst.release();
  report.mode = MODE; report.seconds = (Date.now() - t0) / 1000;
  console.log(JSON.stringify(report, null, 1));
  await src.end(); await dstPool.end();
  process.exit(report.errors.length ? 1 : 0);
}
main().catch(e => { console.error("실행기 오류:", e?.message ?? e); process.exit(1); });
