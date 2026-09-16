// ─── 홈택스 거래처 중복 전수 진단 (SELECT / 분석 전용, DB 미변경) ───────────────
// 목적: "중복 검토 필요 658건"을 원인별로 un-mask 하여 §13 보고 수치를 산출한다.
//   앱 analyze 는 "파일 내부 사업자번호 중복" 검사가 DB 매칭보다 우선순위가 높아
//   DB 일치가 가려진다(masking). 이 스크립트는 그 가림을 풀어 각 원인을 독립 집계한다.
//
// 실행(2단계, 모두 SELECT/분석 전용):
//   1) 기존 거래처 JSON 내보내기 (psql, SELECT only):
//      psql "$DATABASE_URL" -tA -c "select coalesce(json_agg(json_build_object(
//        'biz', regexp_replace(coalesce(business_number,''),'[^0-9]','','g'),
//        'name', name, 'phone', coalesce(phone,''), 'email', coalesce(email,''))),'[]')
//        from companies where deleted_at is null;" > /tmp/veritas_existing_companies.json
//   2) 진단 실행:
//      cd artifacts/api-server
//      node --experimental-strip-types scripts/hometax-dup-diagnostic.mts "/경로/홈택스_804.xlsx" /tmp/veritas_existing_companies.json
//
// ⚠ DB 를 직접 열지 않는다(위 1단계 psql SELECT 결과 JSON 만 읽음). INSERT/UPDATE/DELETE 없음.
import {
  parseWorkbook, buildColumnMap, getCell, isBlankRow,
  normalizeBusinessNumber, isValidBusinessNumber, normalizeName, normalizeEmail,
  normalizePhone, normalizeCompanyNameKey, COMPANY_COLUMN_SYNONYMS,
} from "../src/lib/hometaxExcel.ts";

const filePath = process.argv[2];
const dbJsonPath = process.argv[3] ?? "/tmp/veritas_existing_companies.json";
if (!filePath) { console.error("사용법: node --experimental-strip-types scripts/hometax-dup-diagnostic.mts <xlsx경로> [기존거래처JSON경로]"); process.exit(1); }

const fs = await import("node:fs");
const buf = fs.readFileSync(filePath);

// ── 1) 파일 파싱(앱과 동일 함수) ──
const parsed = parseWorkbook(buf, COMPANY_COLUMN_SYNONYMS);
const colMap = buildColumnMap(parsed.headers, COMPANY_COLUMN_SYNONYMS);
type R = { row: number; biz: string; name: string; nameKey: string; rep: string; phone: string; email: string; addr: string; ind: string; cat: string; reg: string; validBiz: boolean };
const rows: R[] = [];
parsed.dataRows.forEach((raw, i) => {
  if (isBlankRow(raw)) return;
  const bizNorm = normalizeBusinessNumber(normalizeName(getCell(raw, colMap, "businessNumber")));
  const name = normalizeName(getCell(raw, colMap, "name"));
  rows.push({
    row: parsed.headerRowIndex + 2 + i,
    biz: bizNorm, validBiz: isValidBusinessNumber(bizNorm),
    name, nameKey: normalizeCompanyNameKey(name),
    rep: normalizeName(getCell(raw, colMap, "representativeName")),
    phone: normalizePhone(getCell(raw, colMap, "phone")),
    email: normalizeEmail(getCell(raw, colMap, "email")),
    addr: normalizeName(getCell(raw, colMap, "address")),
    ind: normalizeName(getCell(raw, colMap, "industry")),
    cat: normalizeName(getCell(raw, colMap, "businessCategory")),
    reg: normalizeName(getCell(raw, colMap, "registeredAt")),
  });
});

// ── 2) 기존 VERITAS 거래처(psql SELECT 결과 JSON) ──
const existing: { biz: string; name: string; phone: string; email: string }[] = JSON.parse(fs.readFileSync(dbJsonPath, "utf8"));
const dbBiz = new Set(existing.filter(e => /^[0-9]{10}$/.test(e.biz)).map(e => e.biz));
const dbNameKey = new Set(existing.map(e => normalizeCompanyNameKey(e.name)).filter(Boolean));
const dbPhone = new Set(existing.map(e => normalizePhone(e.phone)).filter(Boolean));
const dbEmail = new Set(existing.map(e => normalizeEmail(e.email)).filter(Boolean));

// ── 3) 파일 내부 사업자번호 그룹 ──
const byBiz = new Map<string, R[]>();
for (const r of rows) { if (r.biz) { const a = byBiz.get(r.biz); if (a) a.push(r); else byBiz.set(r.biz, [r]); } }
const dupGroups = [...byBiz.entries()].filter(([, a]) => a.length >= 2);
const uniqueInFile = [...byBiz.entries()].filter(([, a]) => a.length === 1).map(([, a]) => a[0]);
const noBiz = rows.filter(r => !r.biz);
const invalidBiz = rows.filter(r => r.biz && !r.validBiz);

const distinct = (a: string[]) => new Set(a.filter(Boolean)).size;
let grpDiffPhone = 0, grpDiffEmail = 0, grpDiffName = 0, grpDiffRep = 0, grpDiffAddr = 0, grpDiffInd = 0, grpDiffCat = 0, grpDiffReg = 0;
let grpAlsoInDb = 0;
for (const [biz, a] of dupGroups) {
  if (distinct(a.map(r => r.phone)) >= 2) grpDiffPhone++;
  if (distinct(a.map(r => r.email)) >= 2) grpDiffEmail++;
  if (distinct(a.map(r => r.nameKey)) >= 2) grpDiffName++;
  if (distinct(a.map(r => r.rep)) >= 2) grpDiffRep++;
  if (distinct(a.map(r => r.addr)) >= 2) grpDiffAddr++;
  if (distinct(a.map(r => r.ind)) >= 2) grpDiffInd++;
  if (distinct(a.map(r => r.cat)) >= 2) grpDiffCat++;
  if (distinct(a.map(r => r.reg)) >= 2) grpDiffReg++;
  if (dbBiz.has(biz)) grpAlsoInDb++;
}

// ── 4) 기존 DB 매칭(가림 해제) ──
const allFileBiz = new Set(rows.filter(r => r.validBiz).map(r => r.biz));
const bizExactMatch = [...allFileBiz].filter(b => dbBiz.has(b)).length; // 파일의 고유 사업자번호 중 DB에도 있는 수
const uniqueRowsDbBiz = uniqueInFile.filter(r => r.validBiz && dbBiz.has(r.biz)).length;
const uniqueRowsDbPhoneEmailOnly = uniqueInFile.filter(r => r.validBiz && !dbBiz.has(r.biz) && (dbPhone.has(r.phone) || dbEmail.has(r.email))).length;
const uniqueRowsNew = uniqueInFile.filter(r => r.validBiz && !dbBiz.has(r.biz) && !dbPhone.has(r.phone) && !dbEmail.has(r.email)).length;
const nameOnlyMatch = rows.filter(r => !r.biz && r.nameKey && dbNameKey.has(r.nameKey)).length;

// ── 5) unique master 계산 ──
const distinctFileBiz = allFileBiz.size;
const newBizMasters = [...allFileBiz].filter(b => !dbBiz.has(b)).length;

console.log("════════ 홈택스 중복 전수 진단 ════════");
console.log("전체 데이터행:", rows.length, "| 헤더:", parsed.headers.join(" | "));
console.log("컬럼매핑 customerType →", colMap.customerType >= 0 ? parsed.headers[colMap.customerType] : "(unmapped)");
console.log("\n[행 구성]");
console.log("  사업자번호 없음:", noBiz.length, "| 형식오류:", invalidBiz.length);
console.log("  유효 사업자번호 보유 행:", rows.filter(r => r.validBiz).length);
console.log("  └ 파일 내 고유(1회):", uniqueInFile.length, "행");
console.log("  └ 파일 내 중복(≥2회):", dupGroups.reduce((s, [, a]) => s + a.length, 0), "행 →", dupGroups.length, "개 사업자 그룹");
console.log("\n[§13-1,2 중복 원인별]");
console.log("  파일 내부 동일 사업자번호(그룹):", dupGroups.length, "그룹 /", dupGroups.reduce((s, [, a]) => s + a.length, 0), "행");
console.log("  ↑ 그중 기존 DB에도 존재(가려짐):", grpAlsoInDb, "그룹");
console.log("  고유행이지만 DB 사업자번호 일치(→ 원래 identical):", uniqueRowsDbBiz);
console.log("  고유행 전화/이메일만 DB 일치(→ needs_review):", uniqueRowsDbPhoneEmailOnly);
console.log("  사업자번호 없음 + 거래처명 DB 일치:", nameOnlyMatch);
console.log("\n[§13-2,3,4 동일 사업자번호 그룹 내부 차이]");
console.log("  다른 전화번호 보유 그룹:", grpDiffPhone);
console.log("  다른 이메일 보유 그룹:", grpDiffEmail);
console.log("  다른 거래처명:", grpDiffName, "| 다른 대표자:", grpDiffRep, "| 다른 주소:", grpDiffAddr);
console.log("  다른 업태:", grpDiffInd, "| 다른 종목:", grpDiffCat, "| 다른 등록일:", grpDiffReg);
console.log("\n[§13-5,6,7,8 기존 535 대비]");
console.log("  사업자번호 exact match(파일 고유번호 기준):", bizExactMatch, "개");
console.log("  거래처명만 일치(사업자번호 없음):", nameOnlyMatch);
console.log("  자동병합 후보(그룹 내 거래처명 표기차만):", dupGroups.filter(([, a]) => distinct(a.map(r => r.nameKey)) === 1).length, "그룹");
console.log("  사람 검토(그룹 내 거래처명 상이):", grpDiffName, "그룹");
console.log("\n[§13-9 unique 거래처 Master 수]");
console.log("  파일 내 distinct 사업자번호:", distinctFileBiz);
console.log("  └ 기존 DB와 일치(신규 아님):", bizExactMatch);
console.log("  └ 신규 사업자 Master:", newBizMasters);
console.log(`  ▶ 804행 → 약 ${distinctFileBiz} unique 거래처 (신규 ${newBizMasters} + 기존일치 ${bizExactMatch}) + 사업자번호없음 ${noBiz.length}행 별도검토`);
process.exit(0);
