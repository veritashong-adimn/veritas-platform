// 이력서 AI 분석 — 학력·대학원 종류·전공 추출 회귀 테스트 (DB 쓰기 없음).
//   [U] 후처리 단위 검증 (OpenAI 불필요): 최종 학력 선택, 대학원명 보존, 주전공/제2전공 분리, 통번역대학원 오분류 방지
//   [E] 실제 파이프라인 검증 (OpenAI 키 필요): DOCX 생성 → extractDocText → 프롬프트 → GPT → buildResumeDto
//       A 김용규 / B 김나빈 / C 김혜진 (실제 오류 사례 재현 원문) + D 통번역대학원 졸업자(기존 정상 동작 유지)
//       E 복수 통번역대학원 석사 / F 동일 대학원 석사·박사 (가상 테스트 데이터 — DB에 생성하지 않음)
//   [L] 목록 학력 표시 규칙(web-app/src/lib/educationDisplay) 및 저장(직렬화) → 표시 일관성
// 실행: pnpm run test:resume-education
import { crc32 } from "node:zlib";
import OpenAI from "openai";
import { extractDocText, buildResumePromptMessages, buildResumeDto } from "./routes/translators";
import {
  sanitizeEducationHistory, pickFinalEducation, formatEducationName, normalizeEducationName, serializeEducationHistory,
  formatEducationSummary as serverSummary,
} from "./lib/resumeEducation";
import { educationDisplay, formatEducationSummary, formatEducationLines } from "../../web-app/src/lib/educationDisplay";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra === undefined ? "" : JSON.stringify(extra)); }
}

// ── 최소 DOCX 생성기 (무압축 ZIP) ───────────────────────────────────────────
type Block = string | string[][]; // 문단 또는 표(행×셀)
function esc(s: string) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function para(s: string) { return `<w:p><w:r><w:t xml:space="preserve">${esc(s)}</w:t></w:r></w:p>`; }
function table(rows: string[][]) {
  return `<w:tbl>${rows.map(r => `<w:tr>${r.map(c => `<w:tc>${c.split("\n").map(para).join("")}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
}
function zip(files: Array<[string, string]>): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, "utf8"); const nameBuf = Buffer.from(name, "utf8"); const crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, data); centrals.push(ch, nameBuf); offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
function makeDocx(blocks: Block[]): Buffer {
  const body = blocks.map(b => typeof b === "string" ? para(b) : table(b)).join("");
  return zip([
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ["word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`],
  ]);
}

// ── 실제 오류 사례 재현 원문 (연락처는 가상 값) ─────────────────────────────
const CASES: Record<string, Block[]> = {
  A: [
    "이 력 서", "성명: 김용규", "휴대폰: 010-1234-0001", "이메일: yk.kim@example.com", "주소: 서울특별시 강남구",
    "학력사항",
    [["기간", "학교명", "학과", "구분"],
     ["1979.03 ~ 1983.02", "한국외국어대학교", "영어과", "졸업"],
     ["1985.03 ~ 1987.08", "한국외국어대학교 경영정보대학원", "경영정보학과", "졸업"]],
    "1987년 8월 한국외국어대학교 경영정보대학원 경영정보학과에서 경영학 석사 학위를 취득하였습니다.",
    "경력사항",
    [["기간", "내용"],
     ["1990 ~ 현재", "프리랜서 영한·한영 통번역 (기업 IR, 금융, IT 계약서 번역 및 비즈니스 미팅 통역)"],
     ["1983 ~ 1990", "삼성물산 해외영업부 근무"]],
  ],
  B: [
    "자기소개서 및 이력서", "이름: 김나빈", "연락처: 010-1234-0002", "E-mail: nabin.kim@example.com",
    "[학력]",
    [["학교", "한국외국어대학교 (2007.03 ~ 2011.02 졸업예정)"],
     ["주전공", "스페인어과"],
     ["제2전공", "영어통번역학"]],
    "[경력 및 활동]",
    "- 2010 부산국제영화제 스페인어 통역 자원봉사",
    "- 스페인어·영어 웹사이트 번역 프리랜서 (2009~)",
    "[어학] DELE C1, TOEIC 975",
  ],
  C: [
    "RESUME", "김혜진 (Kim Hyejin)", "Mobile: 010-1234-0003", "Email: hj.kim@example.com",
    "■ 학력",
    [["졸업연도", "학교", "계열/전공", "학위"],
     ["1994", "이화여자대학교", "영어영문학", "학사 졸업"],
     ["1997", "이화여자대학교", "어문학계열 영문학", "석사 졸업"]],
    "석사 논문: 미국희곡 연구 — 테네시 윌리엄스 작품의 여성 인물 분석 (세부 전공: 미국희곡)",
    "■ 통번역 경력 (20년)",
    "- 국제회의 동시통역 및 순차통역 다수 (외교부, 산업통상자원부 행사)",
    "- 영한/한영 출판 번역 및 기업 문서 번역",
  ],
  D: [
    "이력서", "성명: 박지수", "휴대폰: 010-1234-0004", "이메일: jisoo.park@example.com",
    "학력",
    [["기간", "학교", "전공", "학위"],
     ["2008 ~ 2012", "고려대학교", "영어영문학과", "학사 졸업"],
     ["2013 ~ 2015", "한국외국어대학교 통번역대학원", "한영과", "통번역학 석사 졸업"]],
    "경력: 국제회의 동시통역사 10년, 의료·제약 GMP 문서 번역",
  ],
  E: [
    "이력서", "성명: 테스트갑", "휴대폰: 010-1234-0005",
    "학력",
    [["기간", "학교", "전공", "학위"],
     ["2005 ~ 2009", "연세대학교", "중어중문학과", "학사 졸업"],
     ["2010 ~ 2012", "서울외국어대학원대학교 통번역대학원", "한중통번역학과", "석사 졸업"],
     ["2013 ~ 2015", "한국외국어대학교 통번역대학원", "한중과", "석사 졸업"]],
    "경력: 한중 순차·동시통역 8년",
  ],
  F: [
    "이력서", "성명: 테스트을", "휴대폰: 010-1234-0006",
    "학력",
    [["기간", "학교", "전공", "학위"],
     ["2000 ~ 2004", "서울대학교", "불어불문학과", "학사 졸업"],
     ["2005 ~ 2007", "한국외국어대학교 통번역대학원", "한불과", "석사 졸업"],
     ["2010 ~ 2016", "한국외국어대학교 통번역대학원", "통번역학과", "박사 졸업"]],
    "경력: 한불 국제회의 통역 15년",
  ],
};

const LABEL: Record<string, string> = {
  "한국외국어대학교 통번역대학원": "한국외대 통번역대학원",
  "서울외국어대학원대학교 통번역대학원": "서울외대 통번역대학원",
  "이화여자대학교 통역번역대학원": "이화여대 통번역대학원",
};
const labelOf = (v: string) => LABEL[v] ?? v;
/** 승인·저장(직렬화) 후 목록에 표시될 학력 — 팝업 결과와 동일 출처 */
const listEdu = (d: ReturnType<typeof buildResumeDto>) =>
  educationDisplay(serializeEducationHistory(d.educationHistory), d.education, d.major, labelOf);

function show(tag: string, d: ReturnType<typeof buildResumeDto>) {
  console.log(`    [${tag}] 목록 학력="${listEdu(d)}"`);
  console.log(`    [${tag}] education="${d.education}" | major="${d.major}" | 졸업연도=${d.graduationYear} | 상태=${d.graduationStatus}`);
  console.log(`    [${tag}] 상세 학력이력: ${formatEducationLines(d.educationHistory ?? []).join(" ‖ ")}`);
  console.log(`    [${tag}] name=${d.name} 언어=${d.languagePairs} 세부유형=${d.profileSubTypes}`);
}
const noTI = (s: string | null) => !/통번역대학원|통역번역대학원/.test(s ?? "");

function unitTests() {
  console.log("\n[U] 후처리 단위 검증");
  const histA = sanitizeEducationHistory([
    { school: "한국외국어대학교", department: "영어과", degree: "학사", status: "졸업", graduationYear: 1983 },
    { school: "한국외국어대학교", graduateSchool: "경영정보대학원", department: "경영정보학과", degree: "석사", degreeName: "경영학 석사", status: "졸업", graduationYear: 1987 },
  ]);
  const fA = pickFinalEducation(histA)!;
  check("U-A 최종 학력 = 석사", fA.degree === "석사");
  check("U-A 대학원명 원문 유지", normalizeEducationName(formatEducationName(fA)) === "한국외국어대학교 경영정보대학원", formatEducationName(fA));
  check("U-A 대학원 종류 = 특수·전문대학원", fA.graduateSchoolType === "특수·전문대학원", fA.graduateSchoolType);
  const dA = buildResumeDto({ educationHistory: histA });
  check("U-A 전공 = 경영정보학과(경영학 석사) / 학부 영어과", dA.major === "경영정보학과(경영학 석사) / 학부 영어과", dA.major);

  const dB = buildResumeDto({ educationHistory: [
    { school: "한국외국어대학교", department: "영어통번역학", majorType: "제2전공", degree: "학사", status: "졸업예정" },
    { school: "한국외국어대학교", department: "스페인어과", majorType: "주전공", degree: "학사", status: "졸업예정", graduationYear: 2011 },
  ] });
  check("U-B 전공 = 스페인어과 / 제2전공 영어통번역학", dB.major === "스페인어과 / 제2전공 영어통번역학", dB.major);
  check("U-B 졸업예정 유지", dB.graduationStatus === "졸업예정");

  const dC = buildResumeDto({ educationHistory: [
    { school: "이화여자대학교", department: "영어영문학", degree: "학사", status: "졸업", graduationYear: 1994 },
    { school: "이화여자대학교", department: "어문학계열 영문학", majorDetail: "미국희곡", degree: "석사", degreeName: "석사", status: "졸업", graduationYear: 1997 },
  ], profileSubTypes: "일반번역, 순차통역" });
  check("U-C 통역번역대학원으로 바꾸지 않음", dC.education === "이화여자대학교 영문학 석사", dC.education);
  check("U-C 전공 = 영문학(미국희곡) / 학부 영어영문학 (학위 중복 없음)", dC.major === "영문학(미국희곡) / 학부 영어영문학", dC.major);
  check("U-C 일반번역 제거 안 함(통번역대학원 아님)", /일반번역/.test(dC.profileSubTypes ?? ""));

  check("U 학교 별칭만으로 통번역대학원 매핑 금지", normalizeEducationName("한국외대") === "한국외대");
  check("U 통번역대학원 명시 시 표준명 매핑 유지", normalizeEducationName("한국외대 통번역대학원") === "한국외국어대학교 통번역대학원");
  const legacy = buildResumeDto({ education: "서울외대 통번역대학원", major: "Conference Interpretation", graduationStatus: "졸업" });
  check("U educationHistory 없을 때 기존 단일 필드 경로 유지", legacy.education === "서울외국어대학원대학교 통번역대학원" && legacy.major === "국제회의통역" && legacy.educationHistory === null, legacy);
  check("U 대학원 종류 도출: 일반대학원", sanitizeEducationHistory([{ school: "한국외국어대학교", graduateSchool: "일반대학원", department: "영문학과", degree: "석사" }])[0].graduateSchoolType === "일반대학원");
  check("U 직렬화: 빈 배열 → null", serializeEducationHistory([]) === null && serializeEducationHistory("") === null);
}

const hist0 = () => serializeEducationHistory([{ school: "한국외국어대학교", department: "스페인어과", degree: "학사", status: "졸업예정" }]);

function listDisplayTests() {
  console.log("\n[L] 목록 학력 표시 규칙");
  const H = (arr: object[]) => sanitizeEducationHistory(arr);
  const cases: Array<[string, object[], string]> = [
    ["A 단일 석사", [{ school: "한국외국어대학교", graduateSchool: "통번역대학원", department: "한영과", degree: "석사", status: "졸업" }], "한국외국어대학교 통번역대학원 한영과 석사"],
    ["B 서로 다른 대학원 석사 2개", [
      { school: "서울외국어대학원대학교", graduateSchool: "통번역대학원", department: "한영통번역학과", degree: "석사", status: "졸업" },
      { school: "한국외국어대학교", graduateSchool: "통번역대학원", department: "한영과", degree: "석사", status: "졸업" }], "서울외국어대학원대학교 통번역대학원 한영통번역학과 석사 / 한국외국어대학교 통번역대학원 한영과 석사"],
    ["C 동일 대학원 석사·박사", [
      { school: "한국외국어대학교", graduateSchool: "통번역대학원", department: "한영과", degree: "석사", status: "졸업" },
      { school: "한국외국어대학교", graduateSchool: "통번역대학원", department: "통번역학과", degree: "박사", status: "졸업" }], "한국외국어대학교 통번역대학원 석사·박사"],
    ["D 일반대학원 영문학 석사", [
      { school: "이화여자대학교", department: "영어영문학", degree: "학사", status: "졸업" },
      { school: "이화여자대학교", department: "영문학", degree: "석사", status: "졸업" }], "이화여자대학교 영문학 석사"],
    ["E 경영정보대학원 석사", [
      { school: "한국외국어대학교", department: "영어과", degree: "학사", status: "졸업" },
      { school: "한국외국어대학교", graduateSchool: "경영정보대학원", department: "경영정보학과", degree: "석사", status: "졸업" }], "한국외국어대학교 경영정보대학원 경영정보학과 석사"],
    ["F 학부 졸업", [{ school: "한국외국어대학교", department: "스페인어과", degree: "학사", status: "졸업" }], "한국외국어대학교 스페인어과 학사"],
    ["G 졸업예정 + 제2전공 제외", [
      { school: "한국외국어대학교", department: "스페인어과", majorType: "주전공", degree: "학사", status: "졸업예정" },
      { school: "한국외국어대학교", department: "영어통번역학", majorType: "제2전공", degree: "학사", status: "졸업예정" }], "한국외국어대학교 스페인어과 학사(졸업예정)"],
    ["수료는 취득과 구분", [{ school: "한국외국어대학교", graduateSchool: "통번역대학원", department: "한영과", degree: "석사", status: "수료" }], "한국외국어대학교 통번역대학원 한영과 석사(수료)"],
    ["동일 학력 중복 제거", [
      { school: "한국외국어대학교", graduateSchool: "통번역대학원", department: "한영과", degree: "석사", status: "졸업" },
      { school: "한국외국어대학교", graduateSchool: "한국외국어대학교 통번역대학원", department: "한영과", degree: "석사", status: "졸업" }], "한국외국어대학교 통번역대학원 한영과 석사"],
  ];
  for (const [label, arr, expected] of cases) {
    const got = formatEducationSummary(H(arr));
    check(`L-${label} → "${expected}"`, got === expected, got);
    check(`L-${label} 팝업(서버)·목록(웹) 표시 규칙 일치`, serverSummary(H(arr)) === got, serverSummary(H(arr)));
  }
  // 기존 등록자(educationHistory 없음): 기존 값으로 대체 표시, 재분류 없음
  check("L 기존 등록자: 표준명 라벨 그대로", educationDisplay(null, "한국외국어대학교 통번역대학원", "한영과", labelOf) === "한국외대 통번역대학원");
  check("L 기존 등록자: 전공에 적힌 석사 보충 표시", educationDisplay(null, "이화여자대학교 어문학계열 석사", "영문학", labelOf) === "이화여자대학교 어문학계열 석사"
    && educationDisplay(null, "한국외국어대학교 경영정보대학원", "경영정보학과 · 경영학 석사", labelOf) === "한국외국어대학교 경영정보대학원 석사");
  check("L 기존 등록자: 전공의 '석사과정 수료' → 석사(수료)", educationDisplay(null, "고려대학교 대학원", "영문학 석사과정 수료", labelOf) === "고려대학교 대학원 석사(수료)");
  check("L 기존 등록자: '석사 재학중' → 석사(재학)", educationDisplay(null, "고려대학교 대학원", "영문학 석사 재학중", labelOf) === "고려대학교 대학원 석사(재학)");
  check("L 기존 등록자: 상태 불명 '석사과정' → 학위 보충 안 함", educationDisplay(null, "고려대학교 대학원", "영문학 석사과정", labelOf) === "고려대학교 대학원");
  check("L 기존 등록자: 학위 정보 없음 → 학위 생성 안 함", educationDisplay(null, "한국외국어대학교", "스페인어과", labelOf) === "한국외국어대학교");
  check("L 학력 이력에 학위 미기재 → 학위 생성 안 함", formatEducationSummary(sanitizeEducationHistory([{ school: "한국외국어대학교", department: "스페인어과" }])) === "한국외국어대학교 스페인어과");
  check("L 재학 구분", formatEducationSummary(sanitizeEducationHistory([{ school: "한국외국어대학교", graduateSchool: "통번역대학원", degree: "석사", status: "재학중" }])) === "한국외국어대학교 통번역대학원 석사(재학)");
  check("L 학위 포함 저장값(팝업 승인·수정값)은 그대로 표시", educationDisplay(hist0(), "한국외국어대학교 스페인어과 학사(졸업)", "스페인어과", labelOf) === "한국외국어대학교 스페인어과 학사(졸업)");
  check("L 기존 등록자: 학력 없음 → null", educationDisplay(null, null, null, labelOf) === null);
  // 학력 이력 저장 후 학력을 수동으로 다른 학교로 고친 경우 → 수동 값 우선
  const hist = serializeEducationHistory([{ school: "한국외국어대학교", department: "스페인어과", degree: "학사", status: "졸업" }]);
  check("L 수동 수정된 학력은 기존 값 표시", educationDisplay(hist, "서울대학교", null, labelOf) === "서울대학교");
  check("L 손상된 JSON → 기존 값 대체", educationDisplay("{broken", "고려대학교", null, labelOf) === "고려대학교");
}

async function e2e() {
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!apiKey) { console.log("\n[E] OpenAI 키 없음 — 실제 파이프라인 검증 건너뜀"); return; }
  const client = new OpenAI({ apiKey, baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL });
  const run = async (tag: string) => {
    const { text, method } = await extractDocText(makeDocx(CASES[tag]), `test-${tag}`);
    const c = await client.chat.completions.create({
      model: "gpt-4o", response_format: { type: "json_object" }, temperature: 0.1,
      messages: buildResumePromptMessages(text),
    });
    const d = buildResumeDto(JSON.parse(c.choices[0].message.content ?? "{}"));
    console.log(`\n[E-${tag}] DOCX 추출=${method}`); show(tag, d);
    return d;
  };
  const [A, B, C, D, E, F] = await Promise.all(["A", "B", "C", "D", "E", "F"].map(run));
  console.log("");

  check("A 팝업 학력 = 한국외국어대학교 경영정보대학원 경영학 석사", A.education === "한국외국어대학교 경영정보대학원 경영학 석사", A.education);
  check("A 승인 후 목록 = 팝업 학력", listEdu(A) === A.education, listEdu(A));
  check("A 전공 = 경영정보학과(경영학 석사), 학부 영어과", /^경영정보학과\(경영학 석사\)/.test(A.major ?? "") && /학부 영어과/.test(A.major ?? ""), A.major);
  check("A 졸업 1987", A.graduationYear === 1987 && A.graduationStatus === "졸업", [A.graduationYear, A.graduationStatus]);
  check("A 학부·대학원 학력 모두 보존", (A.educationHistory ?? []).length >= 2, A.educationHistory?.length);

  check("B 팝업 학력 = 한국외국어대학교 스페인어과 학사(졸업예정)", B.education === "한국외국어대학교 스페인어과 학사(졸업예정)", B.education);
  check("B 승인 후 목록 = 팝업 학력", listEdu(B) === B.education, listEdu(B));
  check("B 전공 = 스페인어과 / 제2전공 영어통번역학", B.major === "스페인어과 / 제2전공 영어통번역학", B.major);
  check("B 졸업예정 2011", B.graduationStatus === "졸업예정" && B.graduationYear === 2011, [B.graduationStatus, B.graduationYear]);

  check("C 팝업 학력 = 이화여자대학교 영문학 석사 (통역번역대학원 아님)", C.education === "이화여자대학교 영문학 석사" && noTI(C.education), C.education);
  check("C 승인 후 목록 = 팝업 학력", listEdu(C) === C.education, listEdu(C));
  check("C 전공 = 영문학(미국희곡) / 학부 영어영문학", C.major === "영문학(미국희곡) / 학부 영어영문학", C.major);
  check("C 졸업 1997", C.graduationYear === 1997 && C.graduationStatus === "졸업", [C.graduationYear, C.graduationStatus]);

  check("D 팝업 학력 = 표준명 + 학위", /^한국외국어대학교 통번역대학원 .*석사$/.test(D.education ?? ""), D.education);
  check("D 통번역대학원 → 일반번역 제외 규칙 유지", !/일반번역/.test(D.profileSubTypes ?? ""), D.profileSubTypes);
  check("D 기본 필드(이름·전화·이메일) 유지", D.name === "박지수" && D.phone === "010-1234-0004" && D.email === "jisoo.park@example.com", [D.name, D.phone, D.email]);

  check("E 팝업 학력 = 두 통번역대학원 석사 모두 표시", /^서울외국어대학원대학교 통번역대학원 .*석사 \/ 한국외국어대학교 통번역대학원 .*석사$/.test(E.education ?? ""), E.education);
  check("E 승인 후 목록 = 팝업 학력", listEdu(E) === E.education, listEdu(E));
  check("E 석사 2건 모두 보존", (E.educationHistory ?? []).filter(e => e.degree === "석사").length === 2);
  check("F 팝업 학력 = 한국외국어대학교 통번역대학원 석사·박사", F.education === "한국외국어대학교 통번역대학원 석사·박사", F.education);
  check("F 승인 후 목록 = 팝업 학력", listEdu(F) === F.education, listEdu(F));
  // 팝업에서 학력을 수정한 뒤 승인 → 저장된 수정값이 목록에 그대로 표시
  const editedB = { ...B, education: "한국외국어대학교 스페인어과 학사(졸업)" };
  check("팝업 수정값 승인 → 목록에 수정값 표시", listEdu(editedB) === "한국외국어대학교 스페인어과 학사(졸업)", listEdu(editedB));
  // 전공·졸업연도·졸업상태는 기존 분석 결과 유지
  check("전공·졸업연도·상태 유지 (A)", A.major === "경영정보학과(경영학 석사) / 학부 영어과" && A.graduationYear === 1987 && A.graduationStatus === "졸업", [A.major, A.graduationYear, A.graduationStatus]);
  check("F 석사·박사 각각 보존", (F.educationHistory ?? []).some(e => e.degree === "석사") && (F.educationHistory ?? []).some(e => e.degree === "박사"));
  check("A~C 이름 추출 유지", A.name === "김용규" && B.name === "김나빈" && /김혜진/.test(C.name ?? ""), [A.name, B.name, C.name]);
}

async function main() {
  unitTests();
  listDisplayTests();
  await e2e();
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
