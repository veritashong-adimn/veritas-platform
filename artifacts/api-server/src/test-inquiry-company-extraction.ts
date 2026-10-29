// 의뢰건 AI 분석 — 고객 회사명 vs 제3자 업체 구분 / 이메일 / 접수일시 / CRM 연결 검증 (DB 쓰기 없음).
//   R  : 실제 사례(홈페이지 통역 의뢰 알림 캡처) — 개발환경 진단 폴더의 전사문·이미지(git 제외)로 실제 파이프라인 실행
//   A~E: 방문 업체 / 행사 주최사 / 회사 이메일만 / 기존 CRM 담당자 / 자유형식 이메일
//   OpenAI 키가 있으면 실제 이미지 전사·표 판독·자유형식 semantic 추출까지 실행한다.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { analyzeInquiry, buildImageStrips, transcribeInquiryImage, type AnalyzeOutput } from "./services/inquiryAiPipeline";
import { planCustomer } from "./services/quoteCustomerResolve";
import { detectChannel } from "./lib/inquirySourceFields";
import { companiesTable } from "@workspace/db";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); }
}
const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
const F = (o: AnalyzeOutput) => o.fields as Record<string, unknown>;
const reviewWarnings = (o: AnalyzeOutput) => o.warnings.filter(w => /확인\s*필요|확인필요/.test(w));

function show(o: AnalyzeOutput) {
  const f = F(o);
  console.log(`    회사명=${f.customerCompanyName ?? "-"} | 부서=${f.department ?? "-"} | 담당자=${f.contactName ?? "-"} | 휴대폰=${f.contactMobile ?? "-"} | 이메일=${f.contactEmail ?? "-"}`);
  console.log(`    언어=${f.languageFrom ?? "-"}→${f.languageTo ?? "-"} | 장소=${f.place ?? "-"} | 견적희망일=${f.quoteDueDate ?? "-"} | 접수일시=${f.customerReceivedDate ?? "-"} ${f.customerReceivedTime ?? ""} (${f.customerReceivedStatus}/${f.customerReceivedSource}) | 신뢰도=${o.confidence}`);
  for (const w of o.warnings) console.log(`    ⚠ ${w}`);
}

function checkRealCase(o: AnalyzeOutput, tag: string) {
  const f = F(o);
  check(`${tag} 고객 회사명 = 한국뷰로베리타스`, f.customerCompanyName === "한국뷰로베리타스", f.customerCompanyName);
  check(`${tag} 현지 업체명이 회사명에 들어가지 않음`, !/FRANCEST|SDN BHD/i.test(String(f.customerCompanyName ?? "")));
  check(`${tag} 현지 업체명은 요구사항에 유지`, /FRANCEST\w* CONFECTIONERIES/i.test(String(f.requirements ?? "")));
  check(`${tag} 부서 = CER`, f.department === "CER", f.department);
  check(`${tag} 담당자 = 조예리`, f.contactName === "조예리", f.contactName);
  check(`${tag} 휴대폰 = 010-2240-4330`, String(f.contactMobile ?? "").replace(/\D/g, "") === "01022404330", f.contactMobile);
  check(`${tag} 회사 이메일 누락 없음`, f.contactEmail === "ye-ri.cho@bureauveritas.com", f.contactEmail);
  check(`${tag} 통역 장소 = 말레이시아`, f.place === "말레이시아", f.place);
  check(`${tag} 언어 = 한국어 → 말레이시아어`, f.languageFrom === "한국어" && f.languageTo === "말레이시아어", [f.languageFrom, f.languageTo]);
  check(`${tag} 견적서 수령 희망일 = 2026-08-20`, f.quoteDueDate === "2026-08-20", f.quoteDueDate);
  check(`${tag} 통역 일정 = 2026-09-02`, String(f.scheduleFrom ?? "").startsWith("2026-09-02"), f.scheduleFrom);
  check(`${tag} 접수일시 = 알림 메일 발송시각 2026-08-20 15:33 (확정)`, f.customerReceivedDate === "2026-08-20" && f.customerReceivedTime === "15:33" && f.customerReceivedStatus === "confirmed", [f.customerReceivedDate, f.customerReceivedTime, f.customerReceivedStatus]);
  check(`${tag} 불필요한 '확인 필요' 경고 없음`, reviewWarnings(o).length === 0, reviewWarnings(o));
}

async function main() {
  // ── R. 실제 사례 ─────────────────────────────────────────────────────────
  const diagRoot = process.env.INQUIRY_AI_DIAG_DIR || path.join(process.cwd(), ".inquiry-ai-diagnostics");
  const realDir = existsSync(diagRoot) ? readdirSync(diagRoot).map(d => path.join(diagRoot, d)).find(d => {
    try { return readFileSync(path.join(d, "result.json"), "utf8").includes("뷰로베리타스"); } catch { return false; }
  }) : undefined;
  if (!realDir) {
    console.log("\n[R] 실제 사례 진단 자료 없음 — 건너뜀");
  } else {
    const saved = JSON.parse(readFileSync(path.join(realDir, "result.json"), "utf8"));
    const transcript: string = saved.extractedText?.[0]?.text ?? "";
    console.log(`\n[R-1] 실제 사례 — 저장된 이미지 전사문(오류가 났던 동일 원문)으로 실제 파이프라인 실행 (vision 없음)`);
    const r1 = await analyzeInquiry({ pastedText: "", ocrText: transcript, visionContents: [], internalNames: ["홍길동"], internalEmails: ["shhong@veritasco.co.kr"] });
    show(r1); checkRealCase(r1, "R-1");

    // 실제 재전사에서 관찰된 변형: 값 사이 두 칸 공백("한국어  1. 출발언어…") — 라벨 경계로 오인하지 않아야 한다
    console.log(`\n[R-3] 실제 사례 — 재전사 변형(언어 칸 두 칸 공백)`);
    const variant = transcript.replace(/^통역할 언어 .*$/m, "통역할 언어 한국어  1. 출발언어 → 도착언어 ex)한국어 → 영어 말레이시아어  2. 출발언어 → 도착언어 ");
    const r3 = await analyzeInquiry({ pastedText: "", ocrText: variant, visionContents: [], internalEmails: ["shhong@veritasco.co.kr"] });
    show(r3); checkRealCase(r3, "R-3");

    const img = readdirSync(realDir).find(n => /\.(png|jpe?g)$/i.test(n));
    if (apiKey && img) {
      console.log(`\n[R-2] 실제 사례 — 원본 캡처 이미지로 라우트와 동일한 전체 과정(전사 → 표 판독 → 매핑)`);
      const buf = readFileSync(path.join(realDir, img));
      const strips = await buildImageStrips(buf, path.extname(img).toLowerCase());
      const text = await transcribeInquiryImage({ images: strips, apiKey, baseURL });
      const r2 = await analyzeInquiry({ pastedText: "", ocrText: `### 파일: ${img} (PNG)\n${text}`, visionContents: strips, apiKey, baseURL, internalEmails: ["shhong@veritasco.co.kr"] });
      show(r2); checkRealCase(r2, "R-2");
    } else console.log("\n[R-2] OpenAI 키 또는 원본 이미지 없음 — 건너뜀");
  }

  // ── A. 고객 회사명 ≠ 방문 업체 ─────────────────────────────────────────────
  console.log("\n[A] 고객 회사명과 방문 업체명이 다른 경우(라벨 양식)");
  const a = await analyzeInquiry({ pastedText: [
    "회사명: 가온테크 주식회사", "부서: 품질보증팀", "담당자: 이수진", "휴대폰: 010-1111-2222", "이메일: sujin.lee@gaontech.example",
    "방문 업체: Hanoi Precision Co., Ltd.", "통역 장소: 베트남 하노이", "통역할 언어: 한국어 → 베트남어",
    "요구사항: 협력사 공장 방문 시 순차통역 필요", "업체명 : Hanoi Precision Co., Ltd.", "공장주소 : Lot 5, Thang Long IZ",
  ].join("\n"), ocrText: "", visionContents: [] });
  show(a);
  check("A 회사명 = 가온테크 주식회사", F(a).customerCompanyName === "가온테크 주식회사", F(a).customerCompanyName);
  check("A 방문 업체는 요구사항에 유지", /Hanoi Precision/.test(String(F(a).requirements ?? "")), F(a).requirements);

  console.log("\n[A-2] 회사명 라벨 없이 요구사항 안 '업체명'만 있는 경우 → 회사명으로 쓰지 않음");
  const a2 = await analyzeInquiry({ pastedText: [
    "담당자: 이수진", "휴대폰: 010-1111-2222", "통역 장소: 베트남", "요구사항: 현지 공장 심사 통역", "업체명 : Hanoi Precision Co., Ltd.",
  ].join("\n"), ocrText: "", visionContents: [] });
  show(a2);
  check("A-2 제3자 업체가 회사명에 들어가지 않음", !F(a2).customerCompanyName, F(a2).customerCompanyName);

  // ── B. 고객 회사명 ≠ 행사 주최사 ───────────────────────────────────────────
  console.log("\n[B] 고객 회사명과 행사 주최사가 다른 경우(표 행 전사 형식)");
  const b = await analyzeInquiry({ pastedText: [
    "회사명 이벤트온 주식회사", "담당자 최민호", "핸드폰 010-3333-4444", "회사 E-mail minho@eventon.example",
    "행사 주최사 한국글로벌포럼", "통역의 형태 동시통역", "통역 수행 장소 서울 코엑스", "통역할 주제 국제 포럼",
  ].join("\n"), ocrText: "", visionContents: [] });
  show(b);
  check("B 회사명 = 이벤트온 주식회사", F(b).customerCompanyName === "이벤트온 주식회사", F(b).customerCompanyName);
  check("B 행사 주최사는 요구사항에 유지", /한국글로벌포럼/.test(String(F(b).requirements ?? "")), F(b).requirements);

  // ── C. 회사 이메일만 있고 개인 이메일 없음 ────────────────────────────────
  console.log("\n[C] 회사 E-mail 만 있고 개인 E-mail 은 빈 칸");
  const c = await analyzeInquiry({ pastedText: [
    "회사명 다온물산", "부서명 해외영업", "담당자 정하늘", "직함 대리", "핸드폰 010-5555-6666",
    "회사 E-mail haneul.jung@daon.example", "개인 E-mail", "주소", "통역할 언어 한국어 → 일본어", "통역 수행 장소 도쿄",
  ].join("\n"), ocrText: "", visionContents: [] });
  show(c);
  check("C 회사 이메일을 담당자 이메일로 사용", F(c).contactEmail === "haneul.jung@daon.example", F(c).contactEmail);
  check("C 빈 '개인 E-mail' 칸이 다음 줄 값을 끌어오지 않음", !/주소/.test(String(F(c).contactEmail ?? "")));

  // ── D. 기존 CRM 담당자 존재 → 기존 연결 정책(읽기 전용 판정) ─────────────
  console.log("\n[D] 기존 CRM 에 거래처·담당자가 있는 경우 — 분석값으로 기존 연결 판정(planCustomer, DB 쓰기 없음)");
  if (realDir) {
    const transcript: string = JSON.parse(readFileSync(path.join(realDir, "result.json"), "utf8")).extractedText?.[0]?.text ?? "";
    const d = await analyzeInquiry({ pastedText: "", ocrText: transcript, visionContents: [], internalEmails: ["shhong@veritasco.co.kr"] });
    const f = F(d);
    const companies = [{ id: 11, name: "(주)한국뷰로베리타스", phone: "02-0000-0000", mobile: null, businessNumber: null }];
    const contacts = [{ id: 501, name: "조예리", email: "Ye-Ri.Cho@bureauveritas.com", mobile: "010-2240-4330", position: "사원", companyId: 11 }];
    const rowsFor = (tbl: unknown) => (tbl === companiesTable ? companies : contacts);
    const q = (rows: unknown[]) => Object.assign(Promise.resolve(rows), { limit: () => Promise.resolve(rows) });
    const fakeDb = { select: () => ({ from: (tbl: unknown) => ({ where: () => q(rowsFor(tbl)) }) }) };
    const inq = { companyId: null, contactId: null, customerCompanyName: f.customerCompanyName, contactName: f.contactName, contactPosition: f.contactPosition,
      department: f.department, contactPhone: f.contactPhone, contactMobile: f.contactMobile, contactEmail: f.contactEmail };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plan = await planCustomer(fakeDb as any, inq as any);
    console.log(`    거래처: ${plan.company.action} ${plan.company.name ?? ""} — ${plan.company.reason}`);
    console.log(`    담당자: ${plan.contact.action} ${plan.contact.name ?? ""} — ${plan.contact.reason}`);
    check("D 기존 거래처(한국뷰로베리타스)로 연결", plan.company.action === "link" && plan.company.id === 11, plan.company);
    check("D 기존 담당자(조예리)로 연결", plan.contact.action === "link" && plan.contact.id === 501, plan.contact);
  } else console.log("    실제 사례 자료 없음 — 건너뜀");

  // ── E. 일반 자유형식 이메일 ───────────────────────────────────────────────
  console.log(`\n[E] 일반 자유형식 이메일 (방문 업체가 본문에 등장)${apiKey ? " — AI semantic 추출 포함" : " — 결정론 추출만"}`);
  const eText = [
    "보낸 사람: 박민수 <minsoo.park@greenenergy.example>",
    "받는 사람: info@veritasco.co.kr",
    "받은 날짜: 2026-10-27 (화) 오전 10:12",
    "제목: 베트남 출장 통역 견적 문의",
    "",
    "안녕하세요. 그린에너지 해외사업팀 박민수 과장입니다.",
    "다음 달 11월 18일 베트남 하노이 현지 협력업체인 VinaSteel Joint Stock Company 공장을 방문하여 설비 점검 회의를 진행할 예정입니다.",
    "한국어-베트남어 순차통역이 가능한 통역사 견적을 부탁드립니다.",
    "",
    "감사합니다.",
    "박민수 드림 | 그린에너지 해외사업팀 | M. 010-7777-8888 | minsoo.park@greenenergy.example",
  ].join("\n");
  const e = await analyzeInquiry({ pastedText: eText, ocrText: "", visionContents: [], apiKey, baseURL });
  show(e);
  check("E 방문 업체(VinaSteel)가 회사명에 들어가지 않음", !/VinaSteel/i.test(String(F(e).customerCompanyName ?? "")), F(e).customerCompanyName);
  if (apiKey) check("E 회사명 = 그린에너지", /그린에너지/.test(String(F(e).customerCompanyName ?? "")), F(e).customerCompanyName);
  check("E 담당자 이메일 = 발신자 주소", F(e).contactEmail === "minsoo.park@greenenergy.example", F(e).contactEmail);
  check("E 접수일시 = 메일 수신시각 2026-10-27 10:12 (확정)", F(e).customerReceivedDate === "2026-10-27" && F(e).customerReceivedTime === "10:12" && F(e).customerReceivedStatus === "confirmed" && F(e).customerReceivedSource === "email_received",
    [F(e).customerReceivedDate, F(e).customerReceivedTime, F(e).customerReceivedStatus, F(e).customerReceivedSource]);
  check("E 접수일시 '확인 필요' 경고 없음", !e.warnings.some(w => /접수일시/.test(w)), e.warnings);

  channelCases();
  await emailContextCases(diagRoot);

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  if (fail) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });

// ══ 이메일 업무 맥락(작성자·수신자·고객사 역할) — 2026-10-28 2차 ═══════════════════════════════
const STAFF = ["이상우", "홍성희", "장서영"];
const OURS = ["shhong@veritasco.co.kr"];
const ctxOf = (o: AnalyzeOutput) => o.emailContext;

function checkWorldExpo(o: AnalyzeOutput, tag: string) {
  const f = F(o);
  check(`${tag} 고객 회사명 = 월드엑스포탈(작성자 소속 베리타스 아님)`, f.customerCompanyName === "월드엑스포탈", f.customerCompanyName);
  check(`${tag} 고객 담당자 = 구예나`, f.contactName === "구예나", f.contactName);
  check(`${tag} 담당자 직함 = 이사`, f.contactPosition === "이사", f.contactPosition);
  check(`${tag} 베리타스 내부 담당자 = 이상우`, ctxOf(o).internalStaff.some(s => s.name === "이상우"), ctxOf(o).internalStaff);
  check(`${tag} 담당 PM 자동 배정 없음`, !("assignedPmId" in f));
  check(`${tag} 통역일·시작 = 2026-03-25 13:30`, f.scheduleFrom === "2026-03-25T13:30", f.scheduleFrom);
  check(`${tag} 통역 종료 = 16:00`, f.scheduleTo === "2026-03-25T16:00", f.scheduleTo);
  check(`${tag} 종료 '정도' → 예상 종료로 요구사항에 보존`, /16:00경\(예상\)/.test(String(f.requirements ?? "")), f.requirements);
  check(`${tag} 예상 통역시간 = 약 2시간 30분`, f.interpretDuration === "약 2시간 30분", f.interpretDuration);
  check(`${tag} 통역사 도착 요청 12:30 은 시작시간과 구분해 보존`, /도착 요청 시간: 낮 12:30/.test(String(f.requirements ?? "")) && !String(f.scheduleFrom).includes("12:30"));
  check(`${tag} 통역 형태 = 동시통역`, f.interpretType === "동시통역", f.interpretType);
  check(`${tag} 통역 언어 영어(도착), 출발 언어 공란`, f.languageTo === "영어" && !f.languageFrom, [f.languageFrom, f.languageTo]);
  check(`${tag} 출발 언어 확인 필요 표시`, o.warnings.some(w => /출발\(상대\) 언어 확인 필요/.test(w)));
  check(`${tag} 상세 장소 = 킨텍스 1전시장 2층 208호`, f.place === "킨텍스 1전시장 2층 208호", f.place);
  check(`${tag} 지역 경기 고양 보존`, /지역: 경기 고양/.test(String(f.requirements ?? "")));
  check(`${tag} 통역 주제 = KOPPEX 2026 해외조달시장 진출설명회`, f.subject === "KOPPEX 2026 해외조달시장 진출설명회", f.subject);
  check(`${tag} 접수경로 = 이메일(인사말·발신자 자기소개)`, f.channel === "email" && o.channelGuess.channel === "email" && o.channelGuess.certain, o.channelGuess);
  check(`${tag} 접수경로 확인 필요 경고 없음`, !o.warnings.some(w => /접수경로/.test(w)), o.warnings);
  check(`${tag} 접수일시 없음 → 공란 유지`, !f.customerReceivedDate && !f.customerReceivedTime, [f.customerReceivedDate, f.customerReceivedTime]);
  check(`${tag} 회사명·담당자 불필요 경고 없음`, !o.warnings.some(w => /회사명|고객사|고객담당자/.test(w)), o.warnings);
}

function channelCases() {
  console.log("\n[CH] 접수경로 판정 기준");
  const ch = (lines: string[]) => detectChannel(lines.join("\n"));
  const hp = ch(["[홈페이지 견적문의] 새 문의가 접수되었습니다.", "보낸 사람: noreply@veritasco.co.kr", "회사명: 대한물산"]);
  check("CH 홈페이지 의뢰 알림 → 홈페이지(기존대로)", hp.channel === "homepage", hp);
  const hdr = ch(["보낸 사람: 정우진 <woojin.jung@daehanmulsan.example>", "제목: 통역 의뢰"]);
  check("CH 메일 헤더 → 이메일 확정", hdr.channel === "email" && hdr.certain, hdr);
  const subj = ch(["제목: 11월 영어 통역 견적 요청", "", "안녕하세요.", "견적 부탁드립니다."]);
  check("CH 제목 + 인사말(주소 없음) → 이메일 확정", subj.channel === "email" && subj.certain, subj);
  const letter = ch(["블루웨이브 김하늘 팀장님 안녕하세요.", "베리타스 이상우입니다.", "견적서 송부드립니다."]);
  check("CH 수신자 인사 + 발신자 자기소개 → 이메일 확정", letter.channel === "email" && letter.certain, letter);
  const kakao = ch(["카카오톡 문의", "안녕하세요 대한물산 김철수입니다.", "통역 가능할까요?"]);
  check("CH 카카오톡 문의 표현 → 카카오(이메일 아님)", kakao.channel === "kakao", kakao);
  const vague = ch(["안녕하세요 김철수입니다.", "다음주 통역 가능할까요?"]);
  check("CH 수신자 없는 짧은 인사 → 확인 필요(미선택)", vague.channel === "", vague);
  const memo = ch(["11/20 코엑스 중국어 순차통역", "10:00~17:00", "담당 정우진 010-2222-3333"]);
  check("CH 출처 불명 메모 → 확인 필요(미선택)", memo.channel === "", memo);
}

async function emailContextCases(diagRoot: string) {
  const wexDir = existsSync(diagRoot) ? readdirSync(diagRoot).map(d => path.join(diagRoot, d)).find(d => {
    try { return readFileSync(path.join(d, "result.json"), "utf8").includes("월드엑스포탈"); } catch { return false; }
  }) : undefined;
  const wexText = wexDir ? JSON.parse(readFileSync(path.join(wexDir, "result.json"), "utf8")).extractedText?.[0]?.text ?? "" : "";

  // ── D·F. 월드엑스포탈 (제목에 고객사, 본문에 베리타스 / 통역 시작 ≠ 도착 요청 시간) ──
  if (wexText) {
    console.log("\n[W-1] 월드엑스포탈 회신 메일 — 저장된 전사문, 결정론만(AI 없음)");
    const w1 = await analyzeInquiry({ pastedText: "", ocrText: wexText, visionContents: [], internalNames: STAFF, internalEmails: OURS });
    show(w1); checkWorldExpo(w1, "W-1");
    if (apiKey) {
      console.log("\n[W-2] 월드엑스포탈 — 저장된 전사문 + AI 업무 맥락 분석");
      const w2 = await analyzeInquiry({ pastedText: "", ocrText: wexText, visionContents: [], apiKey, baseURL, internalNames: STAFF, internalEmails: OURS });
      show(w2); checkWorldExpo(w2, "W-2");
      check("W-2 업무 유형 = 기존 의뢰 관련 회신(신규 의뢰 아님)", ctxOf(w2).emailTypes[0] === "existing_reply" && !ctxOf(w2).emailTypes.includes("new_request"), ctxOf(w2).emailTypeLabels);
      check("W-2 메일 방향 = 당사 → 고객", ctxOf(w2).direction === "outbound");
      const img = readdirSync(wexDir!).find(n => /\.(png|jpe?g)$/i.test(n));
      if (img) {
        console.log("\n[W-3] 월드엑스포탈 — 원본 캡처 이미지로 라우트와 동일한 전체 과정");
        const buf = readFileSync(path.join(wexDir!, img));
        const strips = await buildImageStrips(buf, path.extname(img).toLowerCase());
        const text = await transcribeInquiryImage({ images: strips, apiKey, baseURL });
        const w3 = await analyzeInquiry({ pastedText: "", ocrText: `### 파일: ${img} (PNG)\n${text}`, visionContents: strips, apiKey, baseURL, internalNames: STAFF, internalEmails: OURS });
        show(w3); checkWorldExpo(w3, "W-3");
      }
    }

    // ── G. 기존 CRM 거래처와 연결 ──
    console.log("\n[G] 기존 CRM 거래처·담당자 연결(기존 판정 규칙, 가짜 DB — 쓰기 없음)");
    const g = await analyzeInquiry({ pastedText: "", ocrText: wexText, visionContents: [], internalNames: STAFF, internalEmails: OURS });
    const gf = F(g);
    const companies = [{ id: 21, name: "월드엑스포탈", phone: null, mobile: null, businessNumber: null }];
    const contacts = [{ id: 701, name: "구예나", email: "yena.koo@worldexpotal.example", mobile: "010-9999-0000", position: "이사", companyId: 21 }];
    const q = (rows: unknown[]) => Object.assign(Promise.resolve(rows), { limit: () => Promise.resolve(rows) });
    const fakeDb = { select: () => ({ from: (tbl: unknown) => ({ where: () => q(tbl === companiesTable ? companies : contacts) }) }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plan = await planCustomer(fakeDb as any, { companyId: null, contactId: null, customerCompanyName: gf.customerCompanyName, contactName: gf.contactName, contactPosition: gf.contactPosition, department: null, contactPhone: null, contactMobile: null, contactEmail: null } as any);
    console.log(`    거래처: ${plan.company.action} ${plan.company.name ?? ""} — ${plan.company.reason}`);
    console.log(`    담당자: ${plan.contact.action} — ${plan.contact.reason} ${plan.contact.candidates.map(c => c.name).join(",")}`);
    check("G 기존 거래처(월드엑스포탈)로 연결", plan.company.action === "link" && plan.company.id === 21, plan.company);
    check("G 담당자: 이름만 일치(연락처 없음) → 기존 정책대로 후보 제시(직원 확인)", plan.contact.action === "confirm" && plan.contact.candidates.some(c => c.id === 701), plan.contact);
  } else console.log("\n[W] 월드엑스포탈 진단 자료 없음 — 건너뜀");

  if (!apiKey) { console.log("\n[A~E 자유형식] OpenAI 키 없음 — 건너뜀"); }
  else {
    // ── A. 고객이 베리타스에 신규 의뢰 ──
    console.log("\n[ctx-A] 고객이 베리타스에 보낸 신규 의뢰 메일");
    const a = await analyzeInquiry({ pastedText: [
      "보낸 사람: 정우진 <woojin.jung@daehanmulsan.example>", "받는 사람: info@veritasco.co.kr", "받은 날짜: 2026-11-02 (월) 오전 9:40", "제목: 11/20 코엑스 상담회 중국어 순차통역 의뢰",
      "", "베리타스 담당자님 안녕하세요.", "대한물산 해외영업팀 정우진 과장입니다.",
      "11월 20일 코엑스에서 열리는 KOTRA 주최 수출상담회에 중국 바이어(상하이 협력업체 Huaxin Trading) 미팅이 있어 한국어-중국어 순차통역사를 요청드립니다.",
      "시간은 오전 10시부터 오후 5시까지입니다.", "", "감사합니다.", "정우진 드림 | M. 010-2222-3333",
    ].join("\n"), ocrText: "", visionContents: [], apiKey, baseURL, internalNames: STAFF, internalEmails: OURS });
    show(a);
    check("ctx-A 고객사 = 대한물산", /대한물산/.test(String(F(a).customerCompanyName)), F(a).customerCompanyName);
    check("ctx-A 담당자 = 정우진", F(a).contactName === "정우진", F(a).contactName);
    check("ctx-A 업무 유형 = 신규 의뢰/견적 요청", ["new_request", "quote_request"].includes(ctxOf(a).emailTypes[0]), ctxOf(a).emailTypeLabels);
    check("ctx-A 메일 방향 = 고객 → 당사", ctxOf(a).direction === "inbound");
    check("ctx-E 여러 회사(행사장·주최·협력업체) 중 고객사만 입력", !/코엑스|KOTRA|Huaxin/i.test(String(F(a).customerCompanyName)));
    check("ctx-A 시작·종료 시각 10:00~17:00", F(a).scheduleFrom === "2026-11-20T10:00" && F(a).scheduleTo === "2026-11-20T17:00", [F(a).scheduleFrom, F(a).scheduleTo]);
    check("ctx-A 언어 한국어 → 중국어", F(a).languageFrom === "한국어" && F(a).languageTo === "중국어", [F(a).languageFrom, F(a).languageTo]);

    // ── B. 베리타스 직원이 고객에게 회신 ──
    console.log("\n[ctx-B] 베리타스 직원이 고객에게 보낸 회신(견적 발송)");
    const b = await analyzeInquiry({ pastedText: [
      "보낸 사람: 이상우 <swlee@veritasco.co.kr>", "받는 사람: 김하늘 <haneul.kim@bluewave.example>", "보낸 날짜: 2026-11-03 (화) 오후 3:10", "제목: RE: 블루웨이브 12/5 영어 순차통역 견적",
      "", "블루웨이브 김하늘 팀장님 안녕하세요.", "베리타스 이상우입니다.", "요청하신 12/5 영어 순차통역 견적서를 첨부하여 송부드립니다.",
      "통역 시간은 오후 2시~오후 5시, 장소는 여의도 본사 대회의실로 반영했습니다.", "", "감사합니다.", "이상우 드림 | T. 02-555-0101",
    ].join("\n"), ocrText: "", visionContents: [], apiKey, baseURL, internalNames: STAFF, internalEmails: OURS });
    show(b);
    check("ctx-B 고객사 = 블루웨이브(베리타스 아님)", F(b).customerCompanyName === "블루웨이브", F(b).customerCompanyName);
    check("ctx-B 고객 담당자 = 김하늘 팀장", F(b).contactName === "김하늘" && F(b).contactPosition === "팀장", [F(b).contactName, F(b).contactPosition]);
    check("ctx-B 고객 이메일 = 받는 사람 주소", F(b).contactEmail === "haneul.kim@bluewave.example", F(b).contactEmail);
    check("ctx-B 당사 직원 서명 전화번호를 고객 연락처로 넣지 않음", F(b).contactPhone !== "02-555-0101", F(b).contactPhone);
    check("ctx-B 베리타스 내부 담당자 = 이상우", ctxOf(b).internalStaff.some(s => s.name === "이상우"));
    check("ctx-B 업무 유형 = 견적 발송/회신 계열(신규 의뢰 아님)", !ctxOf(b).emailTypes.includes("new_request") && ctxOf(b).emailTypes.length > 0, ctxOf(b).emailTypeLabels);

    // ── C. 베리타스 직원이 통번역사에게 업무 안내 ──
    console.log("\n[ctx-C] 베리타스 직원이 통역사에게 보낸 업무 안내");
    const c = await analyzeInquiry({ pastedText: [
      "김민지 통역사님 안녕하세요.", "베리타스 이상우입니다.", "다음 통역 건 안내드립니다.",
      "[4/10 한빛제약 중국어 순차통역]", "1. 날짜 : 4/10", "2. 시간 : 오전 10시-오후 3시", "3. 장소 : 한빛제약 오송공장 본관 3층",
      "4. 고객사 담당자 : 한빛제약 품질팀 박준영 차장", "현장 도착은 오전 9시 30분까지 부탁드립니다.",
    ].join("\n"), ocrText: "", visionContents: [], apiKey, baseURL, internalNames: STAFF, internalEmails: OURS });
    show(c);
    check("ctx-C 고객사 = 한빛제약(통역사·베리타스 아님)", F(c).customerCompanyName === "한빛제약", F(c).customerCompanyName);
    check("ctx-C 통역사(김민지)를 고객 담당자로 넣지 않음", F(c).contactName !== "김민지", F(c).contactName);
    check("ctx-C 업무 유형에 통번역사 업무 안내 포함", ctxOf(c).emailTypes.includes("translator_notice"), ctxOf(c).emailTypeLabels);
    check("ctx-C 시작 10:00 / 종료 15:00", String(F(c).scheduleFrom).endsWith("T10:00") && String(F(c).scheduleTo).endsWith("T15:00"), [F(c).scheduleFrom, F(c).scheduleTo]);
  }

  // ── H. 홈페이지 정형 의뢰서 — 진단 폴더의 실제 의뢰 전체를 직전 엔진 결과와 비교(회사·담당자·연락처 불변) ──
  console.log("\n[H] 실제 홈페이지 정형 의뢰서 회귀(진단 폴더 전체, 직전 엔진 결과 대비)");
  const KEYS = ["customerCompanyName", "department", "contactName", "contactPosition", "contactMobile", "contactEmail", "languageFrom", "languageTo", "place", "quoteDueDate"];
  for (const d of existsSync(diagRoot) ? readdirSync(diagRoot).sort() : []) {
    const dir = path.join(diagRoot, d);
    if (!existsSync(path.join(dir, "result.json"))) continue;
    const saved = JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8"));
    if (saved.fields?.channel !== "homepage" || saved.meta?.engine !== "inquiry-ai 2026-10-28.1") continue;
    const pasted = existsSync(path.join(dir, "pasted.txt")) ? readFileSync(path.join(dir, "pasted.txt"), "utf8") : "";
    const ocr = (saved.extractedText ?? []).map((x: { name: string; text: string }) => `### 파일: ${x.name}\n${x.text}`).join("\n\n---\n\n");
    const o = await analyzeInquiry({ pastedText: pasted, ocrText: ocr, visionContents: [], internalNames: STAFF, internalEmails: OURS });
    const diff = KEYS.filter(k => String(saved.fields?.[k] ?? "") !== String((o.fields as Record<string, unknown>)[k] ?? ""));
    check(`H ${d} (${saved.fields.customerCompanyName}) 핵심 항목 불변`, diff.length === 0, diff.map(k => `${k}: ${saved.fields?.[k]} → ${(o.fields as Record<string, unknown>)[k]}`));
    check(`H ${d} 업무 유형 = 신규 의뢰`, ctxOf(o).emailTypes[0] === "new_request", ctxOf(o).emailTypeLabels);
  }
}
