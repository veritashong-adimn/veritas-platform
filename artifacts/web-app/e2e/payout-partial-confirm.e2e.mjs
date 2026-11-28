// 지급확정·은행이체 — 지급대상 선택 지급확정 · 같은 지급일 추가 회차 · 실제 브라우저(헤드리스 Chrome · CDP) 검증. 브라우저 구동 헬퍼는 export-access.e2e.mjs 와 같다.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";

const require = createRequire(new URL("../../api-server/package.json", import.meta.url));
const jwt = require("jsonwebtoken"); const pg = require("pg");
if (!process.env.DATABASE_URL || process.env.DATABASE_URL === process.env.PROD_DATABASE_URL) { console.error("개발 DB 전용 테스트입니다."); process.exit(1); }
const WEB = process.env.TEST_WEB ?? "http://localhost:8090";
const SECRET = process.env.JWT_SECRET ?? "translation-platform-jwt-secret-dev";
const CHROME = process.env.CHROME_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const q1 = async (s, a = []) => (await pool.query(s, a)).rows[0];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✅" : "❌"} ${n}${ok ? "" : " — " + JSON.stringify(d)}`); };

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "export-e2e-"));
const PORT = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, "--window-size=1600,1000", "--renderer-process-limit=2", "--disable-extensions", "about:blank"], { stdio: "ignore" });
async function newTab() {
  for (let i = 0; i < 40; i++) { await sleep(250); try { await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { /* 기동 중 */ } }
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.addEventListener("open", r));
  let seq = 0; const pend = new Map(); const downloads = [];
  ws.addEventListener("message", e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    else if (m.method === "Page.downloadWillBegin") downloads.push(m.params.suggestedFilename); });
  const send = (method, params = {}) => new Promise((r, j) => { const id = ++seq; pend.set(id, m => m.error ? j(new Error(method + ": " + m.error.message)) : r(m.result)); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async expr => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
  const waitFor = async (expr, ms = 20000, label = expr) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* 이동 중 */ } await sleep(200); } throw new Error("대기 초과: " + label); };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: profile });
  return { ws, send, ev, waitFor, downloads, goto: async url => { await send("Page.navigate", { url }); await sleep(500); } };
}
const has = id => `!!document.querySelector('[data-testid="${id}"]')`;


// ─── 지급확정·은행이체 — 지급대상 선택 지급확정 + 같은 지급일 추가 회차(2026-11-28) · 개발 DB 전용 · TEST_WEB(기본 :8090) ───
//   ① [지급회차 생성] → 지급대상별 요약 체크박스 기본 전체 선택 ② 외주업체 체크 해제 → 선택 집계(인원·건수·금액) 갱신
//   ③ 지급대상 검색 필터 변경으로 선택 상태 불변 ④ [선택 N명 지급확정] → 제외 업체는 미지급·미배정
//   ⑤ [추가 지급회차 생성] → 제외 업체만 수집 → 지급확정 ⑥ 두 회차 확정 스냅샷 중복 없음. fixture 는 끝나면 삭제.
import crypto from "node:crypto";
const SHOT_DIR = process.env.SHOT_DIR ?? os.tmpdir();
const TAG = "[E2E-PART]", PAYDATE = "2031-09-30";
const encKey = crypto.scryptSync(process.env.SENSITIVE_ENCRYPT_KEY ?? "dev-fallback-key-change-in-prod-!!", "translator-sensitive-v1", 32);
const enc = (t) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv("aes-256-gcm", encKey, iv); const e = Buffer.concat([c.update(t, "utf8"), c.final()]); return `${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${e.toString("hex")}`; };
const shot = async (tab, name) => { const r = await tab.send("Page.captureScreenshot", { format: "png" }); const f = path.join(SHOT_DIR, `partial-confirm-${name}.png`); fs.writeFileSync(f, Buffer.from(r.data, "base64")); console.log("     📷", f); };
const bodyHas = (t) => `document.body.innerText.includes(${JSON.stringify(t)})`;
const txt = (id) => `(document.querySelector('[data-testid="${id}"]')?.innerText ?? '')`;
const checked = (id) => `!!document.querySelector('[data-testid="${id}"]')?.checked`;
const typeInto = (id, v) => `(() => { const el = document.querySelector('[data-testid="${id}"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
async function cleanup() {
  const pids = (await pool.query(`SELECT id FROM projects WHERE title LIKE $1`, [TAG + "%"])).rows.map(r => r.id);
  const rids = (await pool.query(`SELECT id FROM payout_rounds WHERE payment_date = $1`, [PAYDATE])).rows.map(r => r.id);
  const uids = (await pool.query(`SELECT id FROM users WHERE name LIKE $1`, [TAG + "%"])).rows.map(r => r.id);
  const cids = (await pool.query(`SELECT id FROM companies WHERE name LIKE $1`, [TAG + "%"])).rows.map(r => r.id);
  await pool.query(`DELETE FROM payout_transfers WHERE payout_round_id = ANY($1)`, [rids]);
  await pool.query(`DELETE FROM payout_round_items WHERE payout_round_id = ANY($1)`, [rids]);
  await pool.query(`DELETE FROM logs WHERE entity_type = 'project' AND entity_id = ANY($1)`, [pids]);
  await pool.query(`DELETE FROM performance_assignments WHERE project_id = ANY($1)`, [pids]);
  await pool.query(`DELETE FROM payout_rounds WHERE id = ANY($1)`, [rids]);
  await pool.query(`DELETE FROM projects WHERE id = ANY($1)`, [pids]);
  await pool.query(`DELETE FROM translator_sensitive WHERE translator_id = ANY($1)`, [uids]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [uids]);
  await pool.query(`DELETE FROM company_sensitive WHERE company_id = ANY($1)`, [cids]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [cids]);
}
const sids2 = [];
async function session2(u) {
  const sid = randomUUID(); sids2.push(sid);
  await pool.query(`INSERT INTO user_sessions (user_id, session_id, role_type, login_at, last_activity_at, user_agent, is_online, date_key)
    VALUES ($1,$2,$3,now(),now(),'automated-test',true,to_char(now(),'YYYY-MM-DD'))`, [u.id, sid, u.role]);
  return jwt.sign({ id: u.id, email: u.email, role: u.role, roleId: u.role_id, sessionId: sid }, SECRET, { expiresIn: "1h" });
}
let tab;
try {
  await cleanup();
  const admin = await q1(`SELECT id, email, role, role_id, name FROM users WHERE role='admin' AND role_id IS NULL AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1`);
  const mkT = async (name, rrn, acct) => { const u = await q1(`INSERT INTO users (email, name, role, is_active) VALUES ($1,$2,'translator',true) RETURNING id`, [`e2e-part-${randomUUID().slice(0, 8)}@test.local`, name]);
    await pool.query(`INSERT INTO translator_sensitive (translator_id, resident_number, payment_method, bank_name, bank_account_enc, account_holder) VALUES ($1,$2,'domestic_withholding','기업은행',$3,$4)`, [u.id, enc(rrn), enc(acct), name]); return u.id; };
  const A = await mkT(`${TAG}갑통역사`, "8001011000001", "11122233344"), Bt = await mkT(`${TAG}을통역사`, "8102022000002", "22233344455");
  const vendor = await q1(`INSERT INTO companies (name, is_vendor, company_type, business_number) VALUES ($1, true, 'vendor', '1234567890') RETURNING id`, [TAG + "장비업체"]);
  await pool.query(`INSERT INTO company_sensitive (company_id, bank_name, bank_account_enc, account_holder) VALUES ($1,'기업은행',$2,$3)`, [vendor.id, enc("33344455566"), TAG + "장비업체"]);
  const co = await q1(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [TAG + "거래처"]);
  const pj = await q1(`INSERT INTO projects (user_id, title, company_id, company_name_snapshot) VALUES ($1,$2,$3,$4) RETURNING id`, [admin.id, TAG + "판매", co.id, TAG + "거래처"]);
  const mkPa = async (seq, cat, uid, vid, name, rrn, mask, cost) => (await q1(`INSERT INTO performance_assignments
      (project_id, sequence, performer_category, cost_type, payee_type, individual_user_id, vendor_company_id, performer_name_snapshot, identifier_snapshot_enc, identifier_snapshot_masked,
       status, service_type, product_name_snapshot, delivery_date, delivery_confirmed, expected_payment_date, withholding_treatment, residency_type, purchase_evidence_type,
       is_direct_amount, direct_amount, base_performance_fee, cost_total, payment_status, line_category)
    VALUES ($1,$2,$3::text::performance_performer_category,$3::text::performance_cost_type,$3::text,$4,$5,$6,$7,$8,'completed','interpretation','통역','2031-09-10',true,$9,$10,$11,$12,true,$13,$13,$13,'unpaid',$14) RETURNING id`,
    [pj.id, seq, cat, uid, vid, name, rrn ? enc(rrn) : null, mask, PAYDATE, cat === "individual" ? "domestic_3_3" : null, cat === "individual" ? "domestic_resident" : null,
     cat === "vendor" ? "tax_invoice" : null, cost, cat === "individual" ? "통번역사" : "장비업체"])).id;
  await mkPa(1, "individual", A, null, `${TAG}갑통역사`, "8001011000001", "800101-*******", 680000);
  await mkPa(2, "individual", A, null, `${TAG}갑통역사`, "8001011000001", "800101-*******", 85000);
  await mkPa(3, "individual", Bt, null, `${TAG}을통역사`, "8102022000002", "810202-*******", 680000);
  const v1 = await mkPa(4, "vendor", null, vendor.id, `${TAG}장비업체`, null, "1234567890", 500000);
  const v2 = await mkPa(5, "vendor", null, vendor.id, `${TAG}장비업체`, null, "1234567890", 20000);
  const VK = `v:${vendor.id}`;
  const TA = await session2(admin);
  const user = { id: admin.id, email: admin.email, role: "admin", roleId: null, name: admin.name };
  tab = await newTab();
  await tab.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await tab.goto(WEB + "/");
  await tab.ev(`localStorage.setItem('auth_token', ${JSON.stringify(TA)}); localStorage.setItem('auth_user', ${JSON.stringify(JSON.stringify(user))}); sessionStorage.setItem('veritasRestoreTab', 'settlements'); true`);
  await tab.goto(WEB + "/");
  await tab.waitFor(has(`pu-round-${PAYDATE}`), 30000, "지급회차 목록 " + PAYDATE);
  await tab.ev(`document.querySelector('[data-testid="pu-round-${PAYDATE}"]').click(), true`);
  await tab.waitFor(has("pd-tab-operational"), 20000, "지급회차 상세");
  await tab.ev(`document.querySelector('[data-testid="pd-tab-operational"]').click(), true`);

  console.log("\n[1] 지급회차 생성 → 지급대상별 요약 체크박스 기본 전체 선택");
  await tab.waitFor(has("pd-op-create"), 20000, "지급회차 생성 버튼");
  await tab.ev(`document.querySelector('[data-testid="pd-op-create"]').click(), true`);
  await tab.waitFor(has("payout-new-submit"), 8000, "생성 대화상자");
  await tab.ev(`document.querySelector('[data-testid="payout-new-submit"]').click(), true`);
  await tab.waitFor(has(`payout-select-${VK}`), 25000, "지급대상 체크박스");
  const allOn = await tab.ev(`[...document.querySelectorAll('input[data-testid^="payout-select-"]')].filter(e => e.dataset.testid !== 'payout-select-all').every(e => e.checked)`);
  check("체크박스 기본 전체 선택 · 헤더 전체 선택", allOn && await tab.ev(checked("payout-select-all")));
  check("선택 집계: 3명 · 5건 · 실지급 1,969,315원", /3명/.test(await tab.ev(txt("payout-selection-summary"))) && (await tab.ev(txt("payout-selection-summary"))).includes("1,969,315"), await tab.ev(txt("payout-selection-summary")));

  console.log("\n[2] 외주업체 체크 해제 → 선택 집계 갱신");
  await tab.ev(`document.querySelector('[data-testid="payout-select-${VK}"]').click(), true`); await sleep(300);
  const sumTxt = await tab.ev(txt("payout-selection-summary"));
  check("선택 2명 · 3건 · 세전 1,445,000 · 원천세 47,685 · 부가세 0 · 실지급 1,397,315 · 제외 1명", /2명/.test(sumTxt) && sumTxt.includes("3건") && sumTxt.includes("1,445,000") && sumTxt.includes("47,685") && sumTxt.includes("부가세 0") && sumTxt.includes("1,397,315") && sumTxt.includes("제외 1명"), sumTxt);
  check("확정 버튼 = '선택 2명 지급확정'", (await tab.ev(txt("payout-confirm"))).includes("선택 2명 지급확정"), await tab.ev(txt("payout-confirm")));
  check("헤더 체크 = 일부 선택(indeterminate)", await tab.ev(`document.querySelector('[data-testid="payout-select-all"]').indeterminate === true`));
  await shot(tab, "1-vendor-unchecked");

  console.log("\n[3] 지급대상 검색 필터 변경 → 선택 상태 불변");
  await tab.ev(typeInto("payout-filter-payee", "갑통역사")); await sleep(400);
  check("필터: 갑통역사만 표시 · 체크 유지 · 선택 집계 그대로(2명)", await tab.ev(has(`payout-summary-row-i:${A}`)) && !(await tab.ev(has(`payout-summary-row-${VK}`))) && await tab.ev(checked(`payout-select-i:${A}`)) && /2명/.test(await tab.ev(txt("payout-selection-summary"))));
  await tab.ev(typeInto("payout-filter-payee", "장비업체")); await sleep(400);
  check("필터: 장비업체만 표시 · 체크 해제 상태 유지", await tab.ev(has(`payout-summary-row-${VK}`)) && !(await tab.ev(checked(`payout-select-${VK}`))));
  await tab.ev(typeInto("payout-filter-payee", "")); await sleep(400);
  check("필터 해제 후 선택 상태 그대로(외주업체만 해제 · 2명)", !(await tab.ev(checked(`payout-select-${VK}`))) && await tab.ev(checked(`payout-select-i:${A}`)) && await tab.ev(checked(`payout-select-i:${Bt}`)) && /2명/.test(await tab.ev(txt("payout-selection-summary"))));

  console.log("\n[4] 선택 2명 지급확정 → 외주업체 제외");
  await tab.ev(`document.querySelector('[data-testid="payout-confirm"]').click(), true`);
  await tab.waitFor(has("dialog-confirm"), 8000, "확인 대화상자");
  check("확인 창에 제외 안내(1명·미지급 유지)", await tab.ev(bodyHas("제외 1명")) && await tab.ev(bodyHas("미지급")));
  await tab.ev(`document.querySelector('[data-testid="dialog-confirm"]').click(), true`);
  await tab.waitFor(bodyHas("제외 1명은 미지급으로 남았습니다"), 20000, "확정 완료 안내");
  const r1 = await q1(`SELECT id, status, total_payees, net_amount FROM payout_rounds WHERE payment_date=$1 ORDER BY id LIMIT 1`, [PAYDATE]);
  const vRows = (await pool.query(`SELECT payout_round_id, payment_status FROM performance_assignments WHERE id = ANY($1)`, [[v1, v2]])).rows;
  check("회차 confirmed · 2명 · 실지급 1,397,315", r1.status === "confirmed" && Number(r1.total_payees) === 2 && Math.round(Number(r1.net_amount)) === 1397315, r1);
  check("외주업체 2건 = 미배정 · 미지급", vRows.every(r => r.payout_round_id == null && r.payment_status === "unpaid"), vRows);
  await shot(tab, "2-confirmed-partial");

  console.log("\n[5] 같은 지급일 추가 지급회차 → 외주업체만 → 지급확정");
  await tab.waitFor(`${txt("pd-op-create")}.includes('추가 지급회차 생성') && ${txt("pd-op-create")}.includes('미배정 2건')`, 20000, "추가 회차 생성 버튼");
  await shot(tab, "3-add-round-button");
  await tab.ev(`document.querySelector('[data-testid="pd-op-create"]').click(), true`);
  await tab.waitFor(has("payout-new-submit"), 8000, "생성 대화상자");
  await tab.ev(`document.querySelector('[data-testid="payout-new-submit"]').click(), true`);
  await tab.waitFor(`${has(`payout-summary-row-${VK}`)} && !${has(`payout-summary-row-i:${A}`)}`, 25000, "추가 회차 지급대상");
  check("추가 회차 지급대상 = 외주업체만 · 체크 · 1명 572,000원", await tab.ev(checked(`payout-select-${VK}`)) && /1명/.test(await tab.ev(txt("payout-selection-summary"))) && (await tab.ev(txt("payout-selection-summary"))).includes("572,000"));
  check("확정 버튼 = '지급확정'(제외 없음)", (await tab.ev(txt("payout-confirm"))).trim() === "지급확정", await tab.ev(txt("payout-confirm")));
  await tab.ev(`document.querySelector('[data-testid="payout-confirm"]').click(), true`);
  await tab.waitFor(has("dialog-confirm"), 8000, "확인 대화상자");
  await tab.ev(`document.querySelector('[data-testid="dialog-confirm"]').click(), true`);
  await tab.waitFor(bodyHas("지급확정되었습니다."), 20000, "확정 완료");
  await sleep(500);
  const rounds = (await pool.query(`SELECT id, status, total_payees, net_amount FROM payout_rounds WHERE payment_date=$1 ORDER BY id`, [PAYDATE])).rows;
  check("같은 지급일 회차 2개 모두 confirmed · 합계 1,969,315", rounds.length === 2 && rounds.every(r => r.status === "confirmed") && Math.round(rounds.reduce((s, r) => s + Number(r.net_amount), 0)) === 1969315, rounds);
  const snaps = (await pool.query(`SELECT payout_round_id, performance_assignment_id FROM payout_round_items WHERE payout_round_id = ANY($1)`, [rounds.map(r => r.id)])).rows;
  const dup = snaps.filter((s, i) => snaps.findIndex(x => x.performance_assignment_id === s.performance_assignment_id) !== i);
  check("확정 스냅샷 5건 · 중복 없음", snaps.length === 5 && dup.length === 0, { n: snaps.length, dup });
  check("더 수집할 건 없음 → 추가 회차 생성 버튼 없음", !(await tab.ev(has("pd-op-create"))));
  await shot(tab, "4-second-round-confirmed");
} catch (e) { fail++; console.log("  ❌ 중단:", e.message); try { if (tab) await shot(tab, "error"); } catch { /* */ } }
finally {
  try { tab?.ws.close(); } catch { /* 무시 */ }
  chrome.kill("SIGTERM"); await sleep(600); try { chrome.kill("SIGKILL"); } catch { /* 무시 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 무시 */ }
  try { await cleanup(); if (sids2.length) await pool.query(`DELETE FROM user_sessions WHERE session_id = ANY($1)`, [sids2]);
    const left = await q1(`SELECT (SELECT count(*) FROM users WHERE name LIKE $1)::int u, (SELECT count(*) FROM payout_rounds WHERE payment_date = $2)::int r`, [TAG + "%", PAYDATE]);
    console.log(`\n정리 완료 — 남은 테스트 데이터: 통번역사 ${left.u} · 회차 ${left.r}`); } catch (e) { console.log("정리 실패", e.message); fail++; }
  await pool.end();
}
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
