// @ts-nocheck — 격리 테스트 전용 하네스(앱 빌드 비포함, esbuild 번들로 실행).
// 통번역사 대량등록 통합 판정·승인·실행·되돌리기 검증. DATABASE_URL 이 임시 복제 DB(veritas_sync_scratch)일 때만 실행.
//   · 입력: 서버에 암호화 보관된 업로드 원본(TPLAN_SNAPSHOT_ID) + 메모리 합성 Excel. 디스크에 원본 저장 없음.
import ExcelJS from "exceljs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { readSnapshotBuffer } from "./lib/importSnapshot";
import { buildImportPlan, executeImportPlan, planImportRollback, executeImportRollback, planPage, saveReviewDecision, loadSavedDecisions, buildReviewDetail } from "./services/translatorImportPlan";
import { runRebuildExecute } from "./routes/bulkImport";

if (!/\/veritas_sync_scratch(\?|$)/.test(process.env.DATABASE_URL ?? "")) { console.error("임시 복제 DB(veritas_sync_scratch)에서만 실행합니다."); process.exit(1); }
const SNAP = process.env.TPLAN_SNAPSHOT_ID ?? "";
const buf = readSnapshotBuffer(SNAP);
if (!buf) { console.error("업로드 원본 스냅샷을 찾을 수 없습니다."); process.exit(1); }

let pass = 0, fail = 0; const T0 = Date.now(); const timings: string[] = [];
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} [${((Date.now() - T0) / 1000).toFixed(0)}s] ${n}${d ? ` — ${d}` : ""}`); };
const timed = async <R>(l: string, f: () => Promise<R>) => { const s = performance.now(); const r = await f(); timings.push(`${l}: ${((performance.now() - s) / 1000).toFixed(2)}s`); return r; };
const one = async (s: any) => ((await db.execute(s)).rows as any[])[0];
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

let MAXID = 0;
async function fp() {
  return one(sql`SELECT
    (SELECT count(*)::int FROM users WHERE role='translator' AND deleted_at IS NULL) alive,
    (SELECT md5(string_agg(id::text, ',' ORDER BY id)) FROM users WHERE role='translator' AND deleted_at IS NULL) alive_ids,
    (SELECT md5(string_agg(u.id||':'||coalesce(u.email,'')||':'||u.deleted_at||':'||u.is_active, ',' ORDER BY u.id)) FROM users u WHERE role='translator' AND deleted_at IS NOT NULL) excluded,
    (SELECT md5(string_agg(user_id||':'||coalesce(phone,'')||':'||coalesce(region,'')||':'||coalesce(language_pairs,'')||':'||coalesce(education,'')||':'||coalesce(major,'')||':'||coalesce(graduation_year::text,'')||':'||coalesce(grade,'')||':'||coalesce(md5(bio),''), ',' ORDER BY user_id)) FROM translator_profiles WHERE user_id <= ${MAXID}) profiles,
    (SELECT md5(string_agg(id||':'||coalesce(email,''), ',' ORDER BY id)) FROM users WHERE role='translator' AND deleted_at IS NULL) alive_emails,
    (SELECT md5(string_agg(id||':'||entity_id||':'||status, ',' ORDER BY id)) FROM legacy_master_mappings) mappings,
    (SELECT md5(string_agg(id||':'||status, ',' ORDER BY id)) FROM translator_merges) merges,
    (SELECT count(*)::int FROM legacy_archive_rows WHERE is_effective) archive,
    (SELECT count(*)::int FROM legacy_sales_progress_links) links,
    (SELECT (SELECT count(*) FROM settlements) + (SELECT count(*) FROM payments) + (SELECT count(*) FROM payout_rounds) + (SELECT count(*) FROM performance_assignments))::int finance`);
}
async function exec(buffer: Buffer, token: string, decisions: Record<string, string> = {}) {
  return db.transaction(async (tx) => executeImportPlan(tx, { buffer, fileName: "test.xls", snapshotId: SNAP, planToken: token, decisions, performerId: null }));
}

async function main() {
  MAXID = Number((await one(sql`SELECT max(id) m FROM users`)).m);
  const F0 = await fp();
  const ALIVE0 = ((await db.execute(sql`SELECT id FROM users WHERE role='translator' AND deleted_at IS NULL`)).rows as any[]).map(r => Number(r.id));
  console.log("기준선:", JSON.stringify({ alive: F0.alive }));

  // ── 1. 통합 판정 ──
  const p0 = await timed("통합 판정(2,049행)", () => buildImportPlan(db, buf));
  check("1 판정 합계 = 전체 행(중복 없음)", p0.totals.reconciled && p0.totals.rows === 2049 && new Set(p0.rows.map(r => r.rowNumber)).size === 2049, JSON.stringify(p0.counts));
  check("1 신규 안전: 동명 기존 Master 0 · 이메일 충돌 0 · 배치 내 이메일 중복 0", p0.checks.newRowsMatchingExisting === 0 && p0.checks.newRowsEmailCollision === 0 && p0.checks.newDuplicateEmailInBatch === 0, JSON.stringify(p0.checks));
  check("1 통합·제외 Master 와 일치하는 행은 신규·자동연결 없음", p0.rows.filter(r => r.reasonCode === "excluded_identity" || r.reasonCode === "same_name_excluded").every(r => r.category === "MANUAL" && !r.allowNew));
  check("1 이름만 일치(동명) 행은 자동 연결 없음", p0.rows.filter(r => r.reasonCode === "same_name_alive").every(r => r.category === "MANUAL" && r.masterId == null));
  check("1 판정 전후 DB 불변", same(await fp(), F0));
  check("1 미리보기 페이지: 유형별 정확한 건수", planPage(p0, "MANUAL", 1, 50).total === p0.counts.MANUAL && planPage(p0, "ALL", 41, 50).rows.length === 49);

  // ── 2. 승인 토큰 ──
  let rejected = ""; try { await exec(buf, "wrong"); } catch (e) { rejected = e.code; }
  check("2 승인 토큰 불일치 → 실행 거부·DB 불변", rejected === "PLAN_CHANGED" && same(await fp(), F0));

  // ── 3. 승인 실행(자동 신규·보완 + 수동 결정 3건) ──
  const linkRow = p0.rows.find(r => r.category === "MANUAL" && r.reasonCode === "same_name_alive" && r.allowLinkIds.length === 1);
  const newRow = p0.rows.find(r => r.category === "MANUAL" && r.allowNew);
  const exRow = p0.rows.find(r => r.category === "MANUAL" && r.reasonCode === "excluded_identity");
  const decisions = { [linkRow.rowNumber]: `link:${linkRow.allowLinkIds[0]}`, [newRow.rowNumber]: "new", [exRow.rowNumber]: "new" };
  const upd = p0.rows.find(r => r.category === "UPDATE");
  const updBefore = await one(sql`SELECT education, major, graduation_year::text gy, bio, phone, region FROM translator_profiles WHERE user_id=${upd.masterId}`);
  const r1 = await timed("승인 실행", () => exec(buf, p0.planToken, decisions));
  const F1 = await fp();
  const expCreated = p0.totals.expectedNew + 1;
  check("3 신규 = 자동 신규 + 수동 승인 신규(제외 Master 행 '신규' 요청은 무시)", r1.created === expCreated, `created ${r1.created}, 예상 ${expCreated}`);
  check("3 수동 승인 2·보류 나머지", r1.manualApproved === 2 && r1.manualHeld === p0.counts.MANUAL - 2, JSON.stringify({ a: r1.manualApproved, h: r1.manualHeld }));
  check("3 Master 수 = 이전 + 신규", F1.alive === F0.alive + expCreated && r1.aliveAfter === r1.aliveBefore + expCreated);
  const aliveAfterIds = new Set(((await db.execute(sql`SELECT id FROM users WHERE role='translator' AND deleted_at IS NULL`)).rows as any[]).map(r => Number(r.id)));
  check("3 기존 유효 Master ID 전원 유지(삭제·변경 없음)", ALIVE0.every(id => aliveAfterIds.has(id)) && aliveAfterIds.size === ALIVE0.length + expCreated);
  check("3 통합·제외 Master·수행이력 매핑·통합·과거CRM·연결·정산 불변", F1.excluded === F0.excluded && F1.mappings === F0.mappings && F1.merges === F0.merges && F1.archive === F0.archive && F1.links === F0.links && F1.finance === F0.finance);
  const updAfter = await one(sql`SELECT education, major, graduation_year::text gy, bio, phone, region FROM translator_profiles WHERE user_id=${upd.masterId}`);
  const filled = upd.fills.map(f => f.field);
  const colOf = { education: "education", major: "major", graduationYear: "gy", bio: "bio", phone: "phone", region: "region" };
  check("3 정보 보완은 공란만 채움(기존 값 불변)", filled.every(f => !updBefore[colOf[f]] && updAfter[colOf[f]]) && Object.keys(colOf).filter(f => !filled.includes(f)).every(f => updBefore[colOf[f]] === updAfter[colOf[f]]), JSON.stringify(filled));
  const created = (await db.execute(sql`SELECT u.id, u.email FROM users u WHERE u.id IN (SELECT entity_id FROM import_row_sources WHERE batch_id=${r1.batchId} AND status='new')`)).rows as any[];
  check("3 신규 Master 는 실제 이메일만(가짜 이메일 없음)", created.every(u => u.email && !/@crm-migrated\.invalid$/i.test(u.email)));
  const logs = await one(sql`SELECT count(*) FILTER (WHERE status='new')::int n, count(*) FILTER (WHERE status='update')::int u, count(*) FILTER (WHERE status='tplan_batch')::int b FROM import_row_sources WHERE batch_id=${r1.batchId}`);
  check("3 배치 변경 이력 기록(신규·보완)", logs.n === r1.created && logs.u === r1.updated && logs.b === 1, JSON.stringify(logs));
  check("3 미리보기 = 실제 저장(자동분)", r1.created - 1 === p0.totals.expectedNew && r1.updated >= p0.totals.expectedUpdate);

  // ── 4. 동일 파일 재업로드 2회 ──
  for (let k = 1; k <= 2; k++) {
    const p = await buildImportPlan(db, buf);
    const before = await fp();
    const r = await exec(buf, p.planToken);
    check(`4 동일 파일 재업로드 ${k}회: 신규 0·보완 0·no_change·Master 수 불변`, p.counts.NEW === 0 && p.counts.UPDATE === 0 && r.mode === "no_change" && same(await fp(), before), JSON.stringify(p.counts));
  }
  check("4 재업로드 시 앞서 만든 신규 Master 는 '기존 동일'로 인식", (await buildImportPlan(db, buf)).rows.filter(r => created.some(c => c.id === r.masterId)).every(r => r.category === "SAME"));

  // ── 5. 이메일 안전 처리(합성 파일) ──
  const cust = await one(sql`SELECT email FROM users WHERE role IN ('customer','client','staff') AND email IS NOT NULL LIMIT 1`);
  const prog = await one(sql`SELECT DISTINCT btrim(source_raw->>'통번역사명') nm FROM legacy_archive_rows WHERE source_type='progress' AND is_effective AND nullif(btrim(source_raw->>'통번역사명'),'') IS NOT NULL AND btrim(source_raw->>'통번역사명') NOT IN (SELECT name FROM users WHERE name IS NOT NULL) AND btrim(source_raw->>'통번역사명') NOT IN (SELECT btrim(legacy_id) FROM legacy_master_mappings) AND btrim(source_raw->>'통번역사명') NOT IN (SELECT alias_name FROM translator_aliases) LIMIT 1`);
  // 실데이터에 '매핑 없는 수행자명'이 없으면 임시 DB 에만 합성 수행행 1건을 넣어 B 기준을 실제로 검증(검증 후 삭제)
  let synthProgId: number | null = null;
  const histName = prog?.nm ?? "테스트수행이력전용인물";
  if (!prog) synthProgId = Number((await one(sql`INSERT INTO legacy_archive_rows (source_type, source_system, source_raw, row_hash, translator_name, is_current, is_effective, match_status, effective_version)
    VALUES ('progress', 'test', ${JSON.stringify({ "통번역사명": "테스트수행이력전용인물" })}::jsonb, 'tplan-test-hash', '테스트수행이력전용인물', false, true, 'new', 1) RETURNING id`)).id);
  // 대조: 수행이력이 이미 다른 Master 에 매핑된 이름 → 동일인 수동 확인
  const mappedName = await one(sql`SELECT btrim(m.legacy_id) nm FROM legacy_master_mappings m WHERE m.entity_type='translator' AND m.status<>'rolled_back' AND btrim(m.legacy_id) NOT IN (SELECT name FROM users WHERE name IS NOT NULL) AND btrim(m.legacy_id) NOT IN (SELECT alias_name FROM translator_aliases) LIMIT 1`);
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("통번역사");
  ws.addRow(["성명", "이메일", "휴대폰", "주민등록번호"]);
  ws.addRow(["테스트이메일사용중", cust.email, null, "9001011999901"]);        // 다른 계정 이메일 → 수동 확인
  ws.addRow(["테스트이메일없음", null, null, "9001011999902"]);                // 이메일 없음 → 보류(가짜 이메일 생성 금지)
  ws.addRow(["테스트신규정상", "tplan-new-ok@example.com", "010-1111-2222", "9001011999903"]);   // 신규
  ws.addRow(["테스트신규정상", "tplan-new-ok@example.com", "010-1111-2222", "9001011999903"]);   // 파일 내 중복 → 보류
  ws.addRow(["테스트이력없음", "tplan-no-hist@example.com", null, null]);      // 자격 미충족 → 보류
  ws.addRow([histName, "tplan-hist@example.com", null, null]); // 수행이력 이름(동명 Master·매핑 없음) → 신규(B)
  ws.addRow([mappedName?.nm ?? "테스트매핑", "tplan-mapped@example.com", null, null]); // 이력이 이미 다른 Master 에 연결 → 수동 확인
  const sbuf = Buffer.from(await wb.xlsx.writeBuffer());
  const ps = await buildImportPlan(db, sbuf);
  const cats = ps.rows.map(r => `${r.category}:${r.reasonCode}`);
  check("5 다른 계정 이메일 → 수동 확인(덮어쓰기·신규 금지)", cats[0] === "MANUAL:email_in_use", cats[0]);
  check("5 이메일 없음은 제외 사유 아님 → 신규 등록 가능(생성은 보류·가짜 이메일 미생성)", cats[1] === "NEW:new_rrn" && ps.rows[1].creatable === false, cats[1]);
  check("5 정상 신규(A) / 파일 내 중복 = 첫 행과 같은 판정·1회만 / 자격 미충족 → 등록 제외", cats[2] === "NEW:new_rrn" && cats[3] === "NEW:new_rrn" && ps.rows[3].firstRowOfDuplicate === ps.rows[2].rowNumber && cats[4] === "HOLD:not_eligible", cats.slice(2, 5).join(","));
  check("5 주민번호 없이 수행이력 '성명만' 일치 → 자동 확정 안 함(동일인 수동 확인·본인 이력 확인 가능)", cats[5] === "MANUAL:history_name_only" && ps.rows[5].allowOwnHistory === true, `${cats[5]}${synthProgId ? " (합성 수행행)" : ""}`);
  check("5 수행이력이 이미 다른 기존 Master 에 연결된 이름 → 동일인 수동 확인", !mappedName || cats[6] === "MANUAL:history_linked_to_other_master", cats[6]);
  // 관리자 판정: 본인 수행이력 확인 → 저장(감사로그) → 재분석 후에도 유지 → 실행 시 신규 생성
  const histRow = ps.rows[5];
  await db.transaction(async (tx) => saveReviewDecision(tx, { plan: ps, rowNumber: histRow.rowNumber, decision: "different_own_history", note: "test", snapshotId: SNAP, performerId: null }));
  const ps2 = await buildImportPlan(db, sbuf);
  const savedMap = await loadSavedDecisions(db);
  check("5 수동 판정 저장 → 재분석 시 같은 사람 판정 유지", savedMap.get(ps2.rows[5].personKey)?.decision === "different_own_history");
  const rs = await exec(sbuf, ps2.planToken);
  const creatable = ps2.rows.filter(r => r.category === "NEW" && r.creatable && !r.firstRowOfDuplicate).length;
  check("5 실행: 배치 실패 없이 생성 가능한 신규 + 본인 이력 확인 1명만 생성", rs.mode === "applied" && rs.created === creatable + 1 && creatable === 1, JSON.stringify({ created: rs.created, creatable }));
  await db.transaction(async (tx) => executeImportRollback(tx, rs.batchId, null));
  if (synthProgId) await db.execute(sql`DELETE FROM legacy_archive_rows WHERE id = ${synthProgId}`);   // 임시 DB 합성행 정리

  // ── 5b. 동일인 수동 확인 화면 데이터·판정 규칙 ──
  {
    const pr = await buildImportPlan(db, buf);
    const sameName = pr.rows.find(r => r.category === "MANUAL" && r.reasonCode === "same_name_alive" && r.allowLinkIds.length === 1 && !r.firstRowOfDuplicate);
    const det = await buildReviewDetail(db, buf, pr, sameName.rowNumber);
    check("5b 비교 상세: 업로드·후보 Master·수행이력·근거 제공", det.upload.name && det.candidates.length >= 1 && det.candidates.every(c => "history" in c && Array.isArray(c.agreements)) && typeof det.history.byName.n === "number");
    check("5b 비교 상세에 주민번호 원문 없음", !/\d{6}-?\d{7}/.test(JSON.stringify(det).replace(/"(phone|email)":"[^"]*"/g, "")));
    const conflictRow = pr.rows.find(r => r.category === "MANUAL" && (r.rrnConflictIds ?? []).length > 0);
    let blocked = "";
    if (conflictRow) { try { await db.transaction(async (tx) => saveReviewDecision(tx, { plan: pr, rowNumber: conflictRow.rowNumber, decision: `link:${conflictRow.rrnConflictIds[0]}`, snapshotId: SNAP, performerId: null })); } catch (e) { blocked = e.code; } }
    check("5b 주민번호 충돌 후보로는 연결 불가(자동·수동 통합 금지)", !conflictRow || blocked === "RRN_CONFLICT" || blocked === "INVALID_CANDIDATE", conflictRow ? `row ${conflictRow.rowNumber}: ${blocked}` : "해당 행 없음");
    const auditBefore = (await one(sql`SELECT count(*)::int n FROM import_row_sources WHERE status='review_decision'`)).n;
    await db.transaction(async (tx) => saveReviewDecision(tx, { plan: pr, rowNumber: sameName.rowNumber, decision: `link:${sameName.allowLinkIds[0]}`, note: "동일인 확인", snapshotId: SNAP, performerId: 10 }));
    check("5b 판정 감사로그 기록", (await one(sql`SELECT count(*)::int n FROM import_row_sources WHERE status='review_decision'`)).n === auditBefore + 1);
    const pr2 = await buildImportPlan(db, buf);
    const before = await fp();
    const rl = await exec(buf, pr2.planToken);   // 화면 결정 없이 실행 → 저장된 판정 적용
    check("5b 저장된 연결 판정이 실행에 적용(신규 생성 없이 기존 ID 연결)", rl.manualApproved >= 1 && rl.aliveAfter === rl.aliveBefore + rl.created && (await fp()).excluded === before.excluded, JSON.stringify({ approved: rl.manualApproved, created: rl.created }));
    if (rl.batchId) await db.transaction(async (tx) => executeImportRollback(tx, rl.batchId, null));
  }

  // ── 6. 되돌리기 ──
  const rp = await planImportRollback(db, r1.batchId);
  check("6 되돌리기 미리보기", rp.ok && rp.createdRollbackable === r1.created && rp.fieldsRestorable >= 1, JSON.stringify({ c: rp.createdRollbackable, f: rp.fieldsRestorable, k: rp.fieldsKept }));
  const rr = await timed("배치 되돌리기", () => db.transaction(async (tx) => executeImportRollback(tx, r1.batchId, null)));
  const F2 = await fp();
  check("6 되돌린 후 유효 Master·ID 집합·이메일·프로필 = 기준선", F2.alive === F0.alive && F2.alive_ids === F0.alive_ids && F2.alive_emails === F0.alive_emails && F2.profiles === F0.profiles, JSON.stringify({ alive: F2.alive, restored: rr.restored, soft: rr.softDeleted }));
  check("6 신규 Master 는 삭제하지 않고 비활성(소프트 삭제)", (await one(sql`SELECT count(*)::int n FROM users WHERE id IN (SELECT entity_id FROM import_row_sources WHERE batch_id=${r1.batchId} AND status='new') AND deleted_at IS NOT NULL`)).n === r1.created);
  check("6 매핑·통합·과거CRM·연결·정산 불변", F2.mappings === F0.mappings && F2.merges === F0.merges && F2.archive === F0.archive && F2.links === F0.links && F2.finance === F0.finance);
  check("6 같은 배치 재되돌리기 차단", !(await planImportRollback(db, r1.batchId)).ok);
  const pAfter = await buildImportPlan(db, buf);
  check("6 되돌린 뒤 재업로드: 비활성 처리된 인물은 재생성 안 함(수동 확인)", pAfter.rows.filter(r => r.rowNumber === newRow.rowNumber || (p0.rows.find(x => x.rowNumber === r.rowNumber)?.category === "NEW" && !p0.rows.find(x => x.rowNumber === r.rowNumber)?.firstRowOfDuplicate)).every(r => r.category === "MANUAL"), JSON.stringify(pAfter.counts));

  // ── 7. 기존 실행 경로 차단 ──
  const legacy = await runRebuildExecute(buf, { id: SNAP, filename: "x", createdAt: "" }, { id: 10, email: "" }, { commit: true, confirmToken: SNAP });
  check("7 재구축 실제 실행(commit) 차단", legacy.status === 409 && legacy.body.code === "USE_IMPORT_PLAN");
  const dry = await runRebuildExecute(buf, { id: SNAP, filename: "x", createdAt: "" }, { id: 10, email: "" }, { commit: false, confirmToken: "" });
  check("7 재구축 분석(DRY-RUN)은 유지", dry.status === 200 && dry.body.dryRun === true);

  console.log("\n[처리시간]\n  " + timings.join("\n  "));
  console.log(`\n결과: PASS ${pass} / FAIL ${fail} · ${((Date.now() - T0) / 1000).toFixed(1)}s`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error("테스트 오류:", e); process.exit(1); });
