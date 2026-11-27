// @ts-nocheck — Excel·CSV 출력·다운로드 관리자 전용 회귀 테스트(pnpm run test:export-access)
//   ① 단위: 관리자 판정 공통 기준(lib/adminTier)
//   ② 정적 검사: 브라우저 Excel 저장은 공통 함수(writeWorkbookFile)만 사용 · Excel/CSV 응답 라우트는 requireAdminExport 적용
//   ③ 통합(TEST_API 기본 http://localhost:8090/api, 개발 DB): 관리자 허용 / PM·재무·열람·전체권한 직원 403(EXPORT_ADMIN_ONLY) · 업무 API 유지
//   운영 DB 에서는 실행하지 않는다. 테스트 계정·역할(export-test-*)은 끝에서 삭제.
import fs from "fs";
import path from "path";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { isAdminAccount } from "./lib/adminTier";
import { testSessionToken } from "./testing/sessionToken";

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: any = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✅" : "❌"} ${n}${ok ? "" : " — " + JSON.stringify(d)}`); };

console.log("\n[단위] 관리자 판정");
check("최고관리자·일반 관리자 허용", isAdminAccount("admin", null) && isAdminAccount("admin", "finance") && isAdminAccount("staff", "admin"));
check("PM·재무·열람·역할 없는 직원·외부 계정 금지", !isAdminAccount("staff", "pm") && !isAdminAccount("staff", "finance") && !isAdminAccount("staff", "viewer")
  && !isAdminAccount("staff", null) && !isAdminAccount("customer") && !isAdminAccount("translator"));

console.log("\n[정적 검사] 출력 경로 공통 기준");
const ROOT = path.resolve(process.cwd(), "..");   // artifacts/
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.name === "node_modules" ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const webFiles = walk(path.join(ROOT, "web-app/src")).filter(f => /\.(ts|tsx)$/.test(f));
const rawWrites = webFiles.filter(f => !f.endsWith("exportAccess.ts") && /\b(XLSX|xlsx)\.writeFile(XLSX)?\(/.test(fs.readFileSync(f, "utf8")));
check("브라우저 Excel 저장은 writeWorkbookFile(관리자 확인)만 사용", rawWrites.length === 0, rawWrites.map(f => path.relative(ROOT, f)));
const routeDir = path.join(ROOT, "api-server/src/routes");
const unguarded: string[] = [];
for (const f of fs.readdirSync(routeDir).filter(n => n.endsWith(".ts"))) {
  const src = fs.readFileSync(path.join(routeDir, f), "utf8");
  const starts = [...src.matchAll(/router\.(get|post|put|patch|delete)\(/g)].map(m => m.index!);
  starts.forEach((st, i) => {
    const body = src.slice(st, starts[i + 1] ?? src.length);
    if (/(spreadsheetml\.sheet|text\/csv)/.test(body) && !/setHeader\("Content-Type",\s*mime/.test(body) && !/requireAdminExport/.test(body.slice(0, 400)))
      unguarded.push(`${f}: ${body.slice(0, 90).replace(/\s+/g, " ")}`);
  });
}
check("Excel·CSV 를 응답하는 서버 라우트는 모두 requireAdminExport", unguarded.length === 0, unguarded);

if (!process.env.DATABASE_URL || process.env.DATABASE_URL === process.env.PROD_DATABASE_URL) { console.error("\n개발 DB 전용 통합 테스트입니다(운영 DB 거부)."); process.exit(1); }
const B = process.env.TEST_API ?? "http://localhost:8090/api";
const call = async (tok: string, m: string, p: string, body?: any) => {
  const r = await fetch(B + p, { method: m, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get("content-type") ?? "";
  const json = ct.includes("json") ? await r.json().catch(() => null) : (await r.body?.cancel().catch(() => {}), null);
  return { status: r.status, ct, body: json };
};
const one = async (q: any) => ((await db.execute(q)).rows as any[])[0];
const tag = Date.now().toString(36);
let roleId: number | null = null;
try {
  // 전체 권한 직원 역할 — 권한키로는 모두 허용돼도 관리자가 아니면 출력만 막히는지 확인
  roleId = (await one(sql`INSERT INTO roles (name, description) VALUES (${`export-test-all-${tag}`}, 'export test — 모든 권한 직원') RETURNING id`)).id;
  await db.execute(sql`INSERT INTO role_permissions (role_id, permission_id) SELECT ${roleId}, id FROM permissions`);
  const admin = (await one(sql`SELECT id FROM users WHERE role='admin' AND role_id IS NULL AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1`)).id;
  const project = (await one(sql`SELECT id FROM projects ORDER BY id DESC LIMIT 1`))?.id ?? 1;
  const T = {
    admin: await testSessionToken(db, admin),
    pm: await testSessionToken(db, { role: "staff", roleName: "pm" }),
    finance: await testSessionToken(db, { role: "staff", roleName: "finance" }),
    viewer: await testSessionToken(db, { role: "staff", roleName: "viewer" }),
    allPerm: await testSessionToken(db, { role: "staff", roleName: `export-test-all-${tag}` }),
  };

  console.log("\n[통합] 권한 응답(canExport)");
  for (const [k, t] of Object.entries(T)) {
    const r = await call(t, "GET", "/auth/permissions");
    check(`${k}: canExport ${k === "admin"}`, r.status === 200 && r.body.canExport === (k === "admin"), r.body?.canExport);
  }

  console.log("\n[통합] 출력 API — 관리자만");
  const EXPORTS: [string, string, any?][] = [
    ["GET", "/admin/projects/export?page=1&pageSize=1"],
    ["GET", "/admin/export/projects"],
    ["GET", "/admin/export/settlements"],
    ["GET", "/admin/settlements/export"],
    ["GET", "/admin/quotes/bulk-import/export"],
    ["GET", "/admin/products/export"],
    ["GET", "/admin/products/template"],
    ["GET", "/admin/translators/sample-excel"],
    ["GET", `/admin/projects/${project}/performances/import-template`],
    ["GET", "/admin/legacy-archive/export-estimate?type=sales_list&scope=search&q=__export_test_none__"],
    ["GET", "/admin/legacy-archive/export?type=sales_list&scope=search&q=__export_test_none__"],
    ["GET", "/admin/legacy-archive/files/999999999/download"],
    ["POST", "/admin/payout-rounds/999999999/transfers/ibk-file"],
    ["POST", "/admin/payout-unified/readiness/resident-numbers", { translatorIds: [] }],
  ];
  for (const [m, p, body] of EXPORTS) {
    const a = await call(T.admin, m, p, body);
    check(`관리자 ${m} ${p.split("?")[0]} → ${a.status} (403 아님)`, a.status !== 403 && a.status !== 401, a);
    for (const k of ["pm", "finance", "viewer", "allPerm"] as const) {
      const r = await call(T[k], m, p, body);
      // 기존부터 관리자 역할 전용인 라우트(과거 CRM 원본 파일)는 역할 검사에서 먼저 403 — 그 외는 출력 공통 기준(EXPORT_ADMIN_ONLY)으로 403
      const adminRoleOnly = p.startsWith("/admin/legacy-archive/files/");
      check(`${k} ${m} ${p.split("?")[0]} → 403`, r.status === 403 && (k !== "allPerm" || adminRoleOnly || r.body?.code === "EXPORT_ADMIN_ONLY"), r);
    }
  }

  console.log("\n[통합] 직원 업무 기능 유지(전체 권한 직원)");
  for (const p of ["/admin/projects?page=1&pageSize=1", "/admin/quotes?page=1&pageSize=1", "/admin/companies?page=1&pageSize=1", "/admin/payout-rounds", "/admin/payout-unified/rounds?page=1&pageSize=1"]) {
    const r = await call(T.allPerm, "GET", p);
    check(`조회 ${p.split("?")[0]} → 200`, r.status === 200, r.status);
  }
} finally {
  await db.execute(sql`DELETE FROM user_sessions WHERE user_agent = 'automated-test'`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE 'session-test-%@test.local'`);
  if (roleId) { await db.execute(sql`DELETE FROM role_permissions WHERE role_id = ${roleId}`); await db.execute(sql`DELETE FROM roles WHERE id = ${roleId}`); }
}
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
