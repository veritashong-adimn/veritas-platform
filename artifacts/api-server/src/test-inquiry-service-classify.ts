// 의뢰건 AI 분석 — 서비스 유형 분류·서비스별 필드 매핑 검증(DB 쓰기 없음).
//   A: 실제 사례(한국출판학회 홈페이지 번역 의뢰 알림 캡처) — 진단 폴더의 전사문·이미지(git 제외)로 실제 파이프라인 실행
//   B~J: 번역/통역/복합/장비/언급만/복수 형식/메일 제목/기존 사례
//   OpenAI 키가 있으면 AI 업무 맥락·semantic 추출·이미지 전사까지 실행한다.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { analyzeInquiry, buildImageStrips, transcribeInquiryImage, type AnalyzeOutput } from "./services/inquiryAiPipeline";
import { hasInterpretationRequest, splitDocumentTypes } from "./lib/inquirySourceFields";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); }
}
const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
const F = (o: AnalyzeOutput) => o.fields as Record<string, unknown>;
const types = (o: AnalyzeOutput) => (F(o).serviceTypes as string[] | undefined) ?? [];
const STAFF = ["이상우", "홍성희", "장서영"];
const OURS = ["shhong@veritasco.co.kr"];
const INTERP_ONLY = ["interpretType", "scheduleFrom", "scheduleTo", "interpretDuration", "place"];
const TRANS_ONLY = ["documentType", "documentUsage", "volume", "desiredCompletionDate"];

function show(o: AnalyzeOutput) {
  const f = F(o);
  console.log(`    유형=${JSON.stringify(f.serviceTypes)}(${f.serviceType}) | 언어=${f.languageFrom ?? "-"}→${f.languageTo ?? "-"} | 주제=${f.subject ?? "-"} | 형식=${f.documentType ?? "-"} | 분량=${f.volume ?? "-"} | 사용처=${f.documentUsage ?? "-"} | 완료=${f.desiredCompletionDate ?? "-"} | 통역형태=${f.interpretType ?? "-"} | 장소=${f.place ?? "-"}`);
  if (f.requirements) console.log(`    요구사항=${JSON.stringify(f.requirements)}`);
}
// 홈페이지 번역 의뢰 알림(한국출판학회 사례와 같은 표 행 전사문 형식)
const transForm = (o: { sent: string; company: string; contact: string; langs: string; docType: string; volume: string; content: string; usage: string; due: string }) => [
  `Sent : ${o.sent}  `, "Subject : [번역서비스의뢰] 가 들어왔습니다.", "",
  `회사명 ${o.company}  `, `담당자 ${o.contact}  `, "부서명 연구지원팀  ", "직함 과장  ", "전화번호 02-555-1234  ", "핸드폰 010-1234-5678  ", "팩스번호  ", "개인 E-mail  ",
  "회사 E-mail info@example.org  ", "주소  ", `번역할 언어 ${o.langs} ex) 출발언어 -> 도착언어  `, `원본문서의 형태 ${o.docType} ex) ms word, pdf, 출력물, 책  `,
  `의뢰한번역의 분량 ${o.volume}  `, `번역할 내용 ${o.content} ex)제품 사용메뉴얼  `, `번역한 문서의 사용처 ${o.usage}  `, `번역 완료 희망일 ${o.due}  `,
  "요구및 주의사항  ", "번역자료 전송정보 온라인 견적의뢰 후 E-mail로 번역할 원문파일을 전송하겠습니다.  ", "첨부파일  ", "견적서 수령 희망날짜",
].join("\n");
const run = (text: string, ai = false) => analyzeInquiry({ pastedText: text, ocrText: "", visionContents: [], internalNames: STAFF, internalEmails: OURS, ...(ai && apiKey ? { apiKey, baseURL } : {}) });

function checkKpss(o: AnalyzeOutput, tag: string) {
  const f = F(o);
  check(`${tag} 서비스 유형 = 번역만`, JSON.stringify(types(o)) === '["translation"]' && f.serviceType === "translation", [f.serviceTypes, f.serviceType]);
  check(`${tag} 통역 전용 항목 없음`, INTERP_ONLY.every(k => !f[k]), INTERP_ONLY.filter(k => f[k]).map(k => `${k}=${f[k]}`));
  check(`${tag} 메일 제목을 주제로 쓰지 않음`, !/번역서비스의뢰/.test(String(f.subject ?? "")), f.subject);
  check(`${tag} 번역 내용/주제 = 학술 연구 발표문`, f.subject === "학술 연구 발표문", f.subject);
  check(`${tag} 언어 일본어 → 한국어`, f.languageFrom === "일본어" && f.languageTo === "한국어", [f.languageFrom, f.languageTo]);
  check(`${tag} 원문서 형태 = Word, HWP`, f.documentType === "Word, HWP", f.documentType);
  check(`${tag} 요구사항에 원문서 형태 중복 기재 없음`, !/원문서 형태/.test(String(f.requirements ?? "")), f.requirements);
  check(`${tag} 원본에 없는 역방향(한국어 → 일본어) 추가 언어 없음`, !/한국어\s*→\s*일본어|추가 언어/.test(String(f.requirements ?? "")) && !o.warnings.some(w => /추가 언어/.test(w)) && !(o.additionalLanguagePairs ?? []).length, [f.requirements, o.additionalLanguagePairs]);
  check(`${tag} 분량 = 100 page`, f.volume === "100 page", f.volume);
  check(`${tag} 문서 사용처 = 한일출판학술회의`, f.documentUsage === "한일출판학술회의", f.documentUsage);
  check(`${tag} 번역 완료 희망일 = 2026-10-30`, f.desiredCompletionDate === "2026-10-30", f.desiredCompletionDate);
  check(`${tag} 고객정보 유지`, f.customerCompanyName === "사)한국출판학회" && f.department === "사무국" && f.contactName === "이성윤" && f.contactPosition === "사무국장"
    && f.contactPhone === "02-712-9169" && f.contactMobile === "010-3399-5916" && f.contactEmail === "kpss@kpss.or.kr",
    [f.customerCompanyName, f.department, f.contactName, f.contactPosition, f.contactPhone, f.contactMobile, f.contactEmail]);
  check(`${tag} 접수경로 = 홈페이지, 접수일시 2026-10-01 14:48`, f.channel === "homepage" && f.customerReceivedDate === "2026-10-01" && f.customerReceivedTime === "14:48", [f.channel, f.customerReceivedDate, f.customerReceivedTime]);
}

async function main() {
  // ── 단위: 판정 함수 ──
  console.log("\n[U] 판정 함수");
  const dt = (r: string) => JSON.stringify(splitDocumentTypes(r));
  check("U 형식 'ms word, HWP ex) ms word, pdf, 출력물, 책' → Word, HWP(예시 제외)", dt("ms word, HWP ex) ms word, pdf, 출력물, 책") === '{"types":["Word","HWP"],"unmatched":[]}', dt("ms word, HWP ex) ms word, pdf, 출력물, 책"));
  check("U 'DOCX, 한글, XLSX, PPTX' → Word, HWP, Excel, PPT", dt("DOCX, 한글, XLSX, PPTX") === '{"types":["Word","HWP","Excel","PPT"],"unmatched":[]}', dt("DOCX, 한글, XLSX, PPTX"));
  check("U 'doc / pdf / 출력물' → 출력물은 미매칭(임의 '기타' 없음)", dt("doc / pdf / 출력물") === '{"types":["Word","PDF"],"unmatched":["출력물"]}', dt("doc / pdf / 출력물"));
  check("U '통역 경험이 있는 번역가 희망' → 통역 요청 아님", !hasInterpretationRequest("통역 경험이 있는 번역가를 희망합니다"));
  check("U '통역은 필요 없습니다' → 통역 요청 아님", !hasInterpretationRequest("통역은 필요 없습니다"));
  check("U '영어 순차통역' → 통역 요청", hasInterpretationRequest("영어 순차통역"));
  check("U '통역 및 번역 견적 요청' → 통역 요청", hasInterpretationRequest("통역 및 번역 견적 요청드립니다"));

  // ── A. 한국출판학회 실제 사례 ──
  const diagRoot = process.env.INQUIRY_AI_DIAG_DIR || path.join(process.cwd(), ".inquiry-ai-diagnostics");
  const kDir = existsSync(diagRoot) ? readdirSync(diagRoot).map(d => path.join(diagRoot, d)).find(d => {
    try { return readFileSync(path.join(d, "result.json"), "utf8").includes("한국출판학회"); } catch { return false; }
  }) : undefined;
  const kText = kDir ? JSON.parse(readFileSync(path.join(kDir, "result.json"), "utf8")).extractedText?.[0]?.text ?? "" : "";
  if (kText) {
    console.log("\n[A-1] 한국출판학회 — 저장된 전사문, 결정론만(AI 없음)");
    const a1 = await analyzeInquiry({ pastedText: "", ocrText: kText, visionContents: [], internalNames: STAFF, internalEmails: OURS });
    show(a1); checkKpss(a1, "A-1");
    if (apiKey) {
      console.log("\n[A-2] 한국출판학회 — 저장된 전사문 + AI");
      const a2 = await analyzeInquiry({ pastedText: "", ocrText: kText, visionContents: [], apiKey, baseURL, internalNames: STAFF, internalEmails: OURS });
      show(a2); checkKpss(a2, "A-2");
      const img = readdirSync(kDir!).find(n => /\.(png|jpe?g)$/i.test(n));
      if (img) {
        console.log("\n[A-3] 한국출판학회 — 원본 캡처 이미지로 라우트와 동일한 전체 과정(전사 → 분석)");
        const buf = readFileSync(path.join(kDir!, img));
        const strips = await buildImageStrips(buf, path.extname(img).toLowerCase());
        const text = await transcribeInquiryImage({ images: strips, apiKey, baseURL });
        const a3 = await analyzeInquiry({ pastedText: "", ocrText: `### 파일: ${img} (PNG)\n${text}`, visionContents: strips, apiKey, baseURL, internalNames: STAFF, internalEmails: OURS });
        show(a3); checkKpss(a3, "A-3");
      }
    }
  } else console.log("\n[A] 한국출판학회 진단 자료 없음 — 건너뜀");

  for (const ai of apiKey ? [false, true] : [false]) {
    const tag = ai ? "(AI)" : "(결정론)";
    console.log(`\n[B~J] ${tag}`);
    const b = await run(["보낸 사람: 김민수 <minsu@hanbit-pub.example>", "받는 사람: info@veritasco.co.kr", "제목: 일본어 논문 번역 견적 요청",
      "", "안녕하세요. 한빛출판 김민수입니다.", "일본어 논문(약 30페이지)을 한국어로 번역하고자 합니다.", "견적 부탁드립니다.", "", "감사합니다."].join("\n"), ai);
    show(b);
    check(`B ${tag} 일본어→한국어 번역 → 번역만`, JSON.stringify(types(b)) === '["translation"]', types(b));
    check(`B ${tag} 메일 제목을 주제로 쓰지 않음`, F(b).subject !== "일본어 논문 번역 견적 요청", F(b).subject);
    check(`B ${tag} 통역 전용 항목 없음`, INTERP_ONLY.every(k => !F(b)[k]), INTERP_ONLY.filter(k => F(b)[k]));

    const c = await run(["보낸 사람: 박지훈 <jh.park@daeyang.example>", "받는 사람: info@veritasco.co.kr", "제목: 11/20 바이어 미팅 통역 요청",
      "", "안녕하세요. 대양무역 박지훈입니다.", "11월 20일 오후 2시~5시 본사 회의실에서 미국 바이어 미팅이 있어 한국어-영어 순차통역사를 요청드립니다.", "", "감사합니다."].join("\n"), ai);
    show(c);
    check(`C ${tag} 한국어→영어 통역 → 통역만`, JSON.stringify(types(c)) === '["interpretation"]', types(c));
    check(`C ${tag} 번역 전용 항목 없음`, TRANS_ONLY.every(k => !F(c)[k]), TRANS_ONLY.filter(k => F(c)[k]));

    const d = await run(["보낸 사람: 이수진 <sj.lee@greenenergy.example>", "받는 사람: info@veritasco.co.kr", "제목: 통역 및 번역 견적 요청",
      "", "안녕하세요. 그린에너지 이수진입니다.", "12월 3일 코엑스 세미나 영어 동시통역을 요청드리며,", "발표자료(PPT 20장) 한국어→영어 번역도 함께 부탁드립니다.", "", "감사합니다."].join("\n"), ai);
    show(d);
    check(`D ${tag} 통역+번역 요청 → 통역+번역`, JSON.stringify(types(d)) === '["interpretation","translation"]', types(d));

    const e = await run(["보낸 사람: 최유나 <yuna@mirae-law.example>", "받는 사람: info@veritasco.co.kr", "제목: 계약서 번역 의뢰",
      "", "안녕하세요. 미래법무 최유나입니다.", "영문 계약서(15페이지)를 한국어로 번역 의뢰드립니다.", "가능하면 법률 통역 경험이 있는 번역가가 맡아 주시면 좋겠습니다.", "", "감사합니다."].join("\n"), ai);
    show(e);
    check(`E ${tag} 번역 의뢰서에 '통역' 언급만 → 번역만`, JSON.stringify(types(e)) === '["translation"]', types(e));

    const fq = await run(["보낸 사람: 정해원 <hw@eventplus.example>", "받는 사람: info@veritasco.co.kr", "제목: 통역장비 대여 문의",
      "", "안녕하세요. 이벤트플러스 정해원입니다.", "12월 10일 그랜드볼룸 행사에 통역장비(수신기 200대, 송신기 2대, 부스 1식) 대여를 요청드립니다.", "통역사는 자체 섭외하였습니다.", "", "감사합니다."].join("\n"), ai);
    show(fq);
    check(`F ${tag} 장비 단독 → 장비만`, JSON.stringify(types(fq)) === '["equipment"]', types(fq));

    const h = await run(transForm({ sent: "2026-10-04 09:30:00", company: "다온출판", contact: "한지민", langs: "영어 -> 한국어", docType: "PDF, HWP, docx", volume: "50 page", content: "아동 도서 원고", usage: "국내 출간", due: "2026-11-30" }), ai);
    show(h);
    check(`H ${tag} 복수 형식 — Word, HWP, PDF 모두 선택, 요구사항 중복 없음`, F(h).documentType === "Word, HWP, PDF" && !/원문서 형태/.test(String(F(h).requirements ?? "")), [F(h).documentType, F(h).requirements]);
    const h2 = await run(transForm({ sent: "2026-10-06 11:00:00", company: "새봄문고", contact: "오태경", langs: "영어 -> 한국어", docType: "pdf, 출력물, 책", volume: "200 page", content: "소설 원고", usage: "출간", due: "2026-12-20" }), ai);
    check(`H2 ${tag} 고정 항목 밖 표기(출력물, 책)는 원문 그대로 요구사항 보존, '기타' 임의 선택 없음`, F(h2).documentType === "PDF" && /원문서 형태\(원문\): pdf, 출력물, 책/.test(String(F(h2).requirements ?? "")), [F(h2).documentType, F(h2).requirements]);

    const j = await run(transForm({ sent: "2026-10-07 09:00:00", company: "도서출판 가람", contact: "서민재", langs: "일본어 -> 한국어", docType: "ms word", volume: "30 page", content: "논문", usage: "학회 발표", due: "2026-11-20" }).replace("ex) 출발언어 -> 도착언어", "ex) 출발언어 → 도착언어 한국어 -> 일본어 ex) 출발언어 → 도착언어"), ai);
    check(`J ${tag} 일본어 → 한국어 단방향(양식 예시의 역방향 미생성)`, F(j).languageFrom === "일본어" && F(j).languageTo === "한국어" && !/추가 언어/.test(String(F(j).requirements ?? "")), [F(j).languageFrom, F(j).languageTo, F(j).requirements]);
    const k = await run(["보낸 사람: 한도윤 <dy@asiabridge.example>", "받는 사람: info@veritasco.co.kr", "제목: 계약서 양방향 번역 의뢰", "",
      "안녕하세요. 아시아브릿지 한도윤입니다.", "계약서 2건을 번역 의뢰드립니다.", "1) 한국어 → 일본어 (국문 계약서 10페이지)", "2) 일본어 → 한국어 (일문 계약서 8페이지)", "", "감사합니다."].join("\n"), ai);
    show(k);
    check(`K ${tag} 명시적 양방향 — 두 방향 모두 보존(주 언어 + 추가 언어)`, F(k).languageFrom === "한국어" && F(k).languageTo === "일본어" && /추가 언어: 일본어 → 한국어/.test(String(F(k).requirements ?? "")), [F(k).languageFrom, F(k).languageTo, F(k).requirements]);
    check(`H ${tag} 번역만`, JSON.stringify(types(h)) === '["translation"]', types(h));

    const i = await run(transForm({ sent: "2026-10-05 10:12:00", company: "오로라바이오", contact: "윤서현", langs: "한국어 -> 영어", docType: "ms word", volume: "12 page", content: "임상시험 결과보고서", usage: "FDA 제출", due: "2026-11-15" }), ai);
    show(i);
    check(`I ${tag} 메일 제목 ≠ 번역 내용 — 번역 내용 = 임상시험 결과보고서`, F(i).subject === "임상시험 결과보고서", F(i).subject);
    check(`I ${tag} 번역만`, JSON.stringify(types(i)) === '["translation"]', types(i));
  }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  if (fail) process.exitCode = 1;
}
main();
