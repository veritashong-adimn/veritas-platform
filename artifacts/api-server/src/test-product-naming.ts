/**
 * Product Naming Policy 검증 스크립트
 * 실행: cd artifacts/api-server && pnpm run test:naming
 *
 * 검증 항목: direction / sourceLanguage / targetLanguage / displayName / confidence / reviewReason
 */
import { analyzeProductStructure } from "./routes/products.js";

type Case = {
  input: string;
  productType?: string;
  expect: {
    displayName?: string;
    productCandidate?: string;
    domain?: string;
    direction?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
    minConfidence?: number;
    reviewReasonIncludes?: string[];
    reviewReasonExcludes?: string[];
  };
};

// ── 기존 9케이스 (regression) ─────────────────────────────────────────────────
const REGRESSION_CASES: Case[] = [
  {
    input: "한국어 → 라오스어 일반번역",
    expect: { displayName: "한국어-라오스어 번역" },
  },
  {
    input: "한-홍콩어번역",
    expect: { displayName: "한국어-중국어(번체) 번역" },
  },
  {
    input: "한-대만어번역",
    expect: { displayName: "한국어-중국어(번체) 번역" },
  },
  {
    input: "en→ko 일반번역",
    expect: { displayName: "영어-한국어 번역" },
  },
  {
    input: "ja↔ko 동시통역",
    expect: { displayName: "일본어-한국어 동시통역", direction: "ja↔ko" },
  },
  {
    input: "법률번역",
    expect: { productCandidate: "번역", domain: "법률" },
  },
  {
    input: "기술번역",
    expect: { productCandidate: "번역", domain: "기술" },
  },
  {
    input: "일본어원어민감수",
    expect: { displayName: "일본어 원어민감수" },
  },
  {
    input: "아랍어원어민감수",
    expect: { displayName: "아랍어 원어민감수" },
  },
];

// ── 신규 11케이스 (compact + alias + taxonomy) ────────────────────────────────
const NEW_CASES: Case[] = [
  // ── Compact patterns ────────────────────────────────────────────────────────
  {
    input: "한영번역",
    expect: {
      direction: "ko→en",
      sourceLanguage: "ko",
      targetLanguage: "en",
      displayName: "한국어-영어 번역",
      minConfidence: 90,
      reviewReasonIncludes: ["COMPACT_DIRECTION_PATTERN"],
    },
  },
  {
    input: "영한번역",
    expect: {
      direction: "en→ko",
      sourceLanguage: "en",
      targetLanguage: "ko",
      displayName: "영어-한국어 번역",
      minConfidence: 90,
      reviewReasonIncludes: ["COMPACT_DIRECTION_PATTERN"],
    },
  },
  {
    input: "태한번역",
    expect: {
      direction: "th→ko",
      sourceLanguage: "th",
      targetLanguage: "ko",
      displayName: "태국어-한국어 번역",
      minConfidence: 85,
      reviewReasonIncludes: ["COMPACT_DIRECTION_PATTERN"],
    },
  },
  {
    input: "베한번역",
    expect: {
      direction: "vi→ko",
      sourceLanguage: "vi",
      targetLanguage: "ko",
      displayName: "베트남어-한국어 번역",
      minConfidence: 85,
      reviewReasonIncludes: ["COMPACT_DIRECTION_PATTERN"],
    },
  },
  {
    input: "한터번역",
    expect: {
      direction: "ko→tr",
      sourceLanguage: "ko",
      targetLanguage: "tr",
      displayName: "한국어-튀르키예어 번역",  // 정책 변경: canonical = 튀르키예어
      minConfidence: 85,
      reviewReasonIncludes: ["COMPACT_DIRECTION_PATTERN"],
    },
  },
  // ── Country language alias (확정 alias — COUNTRY_LANGUAGE_ALIAS 플래그 없음) ──
  {
    input: "파키스탄어-한국어번역",
    expect: {
      direction: "ur→ko",
      sourceLanguage: "ur",
      targetLanguage: "ko",
      displayName: "우르두어-한국어 번역",
      minConfidence: 75,
      reviewReasonExcludes: ["COUNTRY_LANGUAGE_ALIAS"],  // 확정 alias — review 불필요
    },
  },
  {
    input: "이란어-한국어번역",
    expect: {
      direction: "fa→ko",
      sourceLanguage: "fa",
      targetLanguage: "ko",
      displayName: "페르시아어-한국어 번역",
      minConfidence: 75,
      reviewReasonExcludes: ["COUNTRY_LANGUAGE_ALIAS"],  // 확정 alias — review 불필요
    },
  },
  // ── Native review with alias ──────────────────────────────────────────────
  {
    input: "홍콩어원어민감수",
    expect: {
      displayName: "중국어(번체) 원어민감수",
      minConfidence: 60,
      reviewReasonIncludes: ["CANTONESE_REVIEW"],
    },
  },
  {
    input: "대만어원어민감수",
    expect: {
      displayName: "중국어(번체) 원어민감수",
      minConfidence: 70,
    },
  },
  // ── Interpretation with full language names ───────────────────────────────
  {
    // 통역 양방향: direction은 "en↔zh-hans" (ISO pair), 언어 확인은 displayName으로
    input: "영어↔중국어동시통역",
    expect: {
      direction: "en↔zh-hans",
      displayName: "영어-중국어(간체) 동시통역",
      minConfidence: 60,
    },
  },
  {
    // 통역 양방향: direction은 "th↔ko" (ISO pair)
    input: "태국어↔한국어수행통역",
    expect: {
      direction: "th↔ko",
      displayName: "태국어-한국어 수행통역",
      minConfidence: 75,
    },
  },
];

// ── Policy 검증 케이스 (작업 1-12 기준) ──────────────────────────────────────
const POLICY_CASES: Case[] = [
  // 작업 2: 튀르키예어 canonical
  {
    input: "한-튀르키예번역",
    expect: {
      displayName: "한국어-튀르키예어 번역",
      direction: "ko→tr",
      reviewReasonExcludes: ["COUNTRY_LANGUAGE_ALIAS"],
    },
  },
  // 작업 3: compact 번역 canonical display
  {
    input: "체코-한글번역",
    expect: {
      displayName: "체코어-한국어 번역",
      direction: "cs→ko",
    },
  },
  // 작업 4: 확정 alias — review 플래그 없음
  {
    input: "캄보디아어-한국어번역",
    expect: {
      displayName: "크메르어-한국어 번역",
      direction: "km→ko",
      reviewReasonExcludes: ["COUNTRY_LANGUAGE_ALIAS"],
    },
  },
  // 작업 6: 다국어 — direction 없음, MULTI_LANGUAGE_DETECTED
  {
    input: "다국어-한글번역",
    expect: {
      displayName: "다국어-한국어 번역",
      direction: "",
      reviewReasonIncludes: ["MULTI_LANGUAGE_DETECTED"],
    },
  },
  {
    input: "한-다국어번역",
    expect: {
      displayName: "한국어-다국어 번역",
      direction: "",
      reviewReasonIncludes: ["MULTI_LANGUAGE_DETECTED"],
    },
  },
  // 작업 8+9: expense canonical — direction 없음, Product 불명확 없음
  {
    input: "식비",
    expect: {
      productCandidate: "식비",
      direction: "",
      minConfidence: 70,
      reviewReasonExcludes: ["Product 불명확"],
    },
  },
  {
    input: "교통비",
    expect: {
      productCandidate: "교통비",
      direction: "",
      minConfidence: 70,
      reviewReasonExcludes: ["Product 불명확"],
    },
  },
  // 작업 6+8: equipment alias — 수신기로 canonical
  {
    input: "리시버",
    expect: {
      productCandidate: "수신기",
      direction: "",
      minConfidence: 70,
      reviewReasonExcludes: ["Product 불명확"],
    },
  },
  // 작업 5+11: REVIEW_REQUIRED_LANGUAGE + displayName canonical
  {
    input: "동티모르어-한글번역",
    expect: {
      displayName: "동티모르어-한국어 번역",
      direction: "tet→ko",
      reviewReasonIncludes: ["REVIEW_REQUIRED_LANGUAGE"],
    },
  },
  // compact 전문번역 (인한전문번역)
  {
    input: "인한전문번역",
    expect: {
      displayName: "인도네시아어-한국어 번역",
      direction: "id→ko",
      reviewReasonIncludes: ["COMPACT_DIRECTION_PATTERN"],
    },
  },
];

// ── Final Rendering 검증 (작업 1-13) ─────────────────────────────────────────
const FINAL_CASES: Case[] = [
  // 작업 1+2: bare language pair → 번역 inference, 한글→한국어 canonical
  {
    input: "한글-크메르어",
    expect: {
      displayName: "한국어-크메르어 번역",
      direction: "ko→km",
    },
  },
  // 작업 1: 카자흐스탄(without 어) + 한(single char + 서비스키워드)
  {
    input: "카자흐스탄-한번역",
    expect: {
      displayName: "카자흐스탄어-한국어 번역",
      direction: "kk→ko",
    },
  },
  // 작업 8: sk 신규 등록
  {
    input: "슬로바키아어 → 한국어 일반번역",
    expect: {
      displayName: "슬로바키아어-한국어 번역",
      direction: "sk→ko",
      reviewReasonExcludes: ["UNKNOWN_LANGUAGE"],
    },
  },
  // 작업 8: lt — 정식 표기 (어 포함)
  {
    input: "리투아니아어-한국어번역",
    expect: {
      displayName: "리투아니아어-한국어 번역",
      direction: "lt→ko",
      reviewReasonExcludes: ["UNKNOWN_LANGUAGE"],
    },
  },
  // 작업 8: lt — 실제 Excel 형식 (한글 alias + 어 없는 국가명)
  {
    input: "리투아니아-한글번역",
    expect: {
      displayName: "리투아니아어-한국어 번역",
      direction: "lt→ko",
    },
  },
  // 타지키스탄어 신규 등록 (tg)
  {
    input: "한글-타지키스탄어번역",
    expect: {
      displayName: "한국어-타지키스탄어 번역",
      direction: "ko→tg",
      reviewReasonIncludes: ["REVIEW_REQUIRED_LANGUAGE"],
    },
  },
  // 이탈리아 국가명 alias (어 없이)
  {
    input: "한-이탈리아",
    expect: {
      displayName: "한국어-이탈리아어 번역",
      direction: "ko→it",
    },
  },
  // 카자흐스탄 — 실제 Excel 형식
  {
    input: "카자흐스탄-한번역",
    expect: {
      displayName: "카자흐스탄어-한국어 번역",
      direction: "kk→ko",
    },
  },
  // 작업 4+5: expense override (차량대여)
  {
    input: "차량대여",
    expect: {
      productCandidate: "차량대여",
      direction: "",
      minConfidence: 70,
      reviewReasonExcludes: ["Product 불명확"],
    },
  },
  // 작업 9: 번역공증/아포스티유 — certification canonical
  {
    input: "번역공증/아포스티유",
    expect: {
      productCandidate: "공증번역",
      minConfidence: 70,
    },
  },
  {
    input: "아포스티유",
    expect: {
      productCandidate: "공증번역",
      minConfidence: 70,
    },
  },
  // 작업 9: 사전미팅 — interpretation support canonical
  {
    input: "사전미팅",
    expect: {
      productCandidate: "사전미팅",
      direction: "",
      minConfidence: 70,
    },
  },
  // 작업 9: 행사보조 canonical
  {
    input: "행사보조",
    expect: {
      productCandidate: "행사보조",
      direction: "",
      minConfidence: 70,
    },
  },
  // 작업 11: 번역+감수 혼합 — proofreading 추천 (suggestProductType 기준)
  {
    input: "번역 및 감수",
    expect: {
      productCandidate: "번역",  // analyzeProductStructure는 번역 canonical 반환
      // suggestProductType은 "proofreading" 반환 (import preview에서 taxonomy 추천)
    },
  },
  // 작업 10: 프로젝트 penalty 완화 검증
  {
    input: "ERP 구축 통번역",
    expect: {
      productCandidate: "통번역",
      minConfidence: 60,
    },
  },
  // 작업 6: equipment vs expense 경계
  {
    input: "취소보상비",
    expect: {
      productCandidate: "취소보상비",
      direction: "",
      minConfidence: 70,
    },
  },
  // E2E 5-case: Import Preview 실제 화면 검증 케이스
  {
    input: "한글-타지키스탄어번역",
    expect: {
      displayName: "한국어-타지키스탄어 번역",
      direction: "ko→tg",
      reviewReasonIncludes: ["REVIEW_REQUIRED_LANGUAGE"],
    },
  },
  {
    input: "한문국문화",
    expect: {
      displayName: "한문-한국어 번역",
      direction: "lzh→ko",
    },
  },
  {
    input: "에티오피아어-한국어번역",
    expect: {
      displayName: "에티오피아어-한국어 번역",
      direction: "am→ko",
      reviewReasonIncludes: ["REVIEW_REQUIRED_LANGUAGE"],
    },
  },
  {
    input: "한-뱅골어 번역",
    expect: {
      displayName: "한국어-뱅골어 번역",
      direction: "ko→bn",
    },
  },
  {
    input: "프한번역",
    expect: {
      displayName: "프랑스어-한국어 번역",
      direction: "fr→ko",
      reviewReasonIncludes: ["COMPACT_DIRECTION_PATTERN"],
    },
  },
];

const ALL_CASES: { label: string; cases: Case[] }[] = [
  { label: "Regression (기존 9케이스)", cases: REGRESSION_CASES },
  { label: "New (신규 11케이스)",       cases: NEW_CASES },
  { label: "Policy (정책 검증 10케이스)", cases: POLICY_CASES },
  { label: "Final Rendering (작업 13 + E2E 5케이스)", cases: FINAL_CASES },
];

let passed = 0;
let failed = 0;
let sectionFailed = 0;

for (const { label, cases } of ALL_CASES) {
  sectionFailed = 0;
  console.log(`\n[${label}]`);

  for (const c of cases) {
    const an = analyzeProductStructure(c.input, c.productType);
    const failures: string[] = [];

    if (c.expect.displayName !== undefined && an.displayName !== c.expect.displayName) {
      failures.push(`displayName: got "${an.displayName}", want "${c.expect.displayName}"`);
    }
    if (c.expect.productCandidate !== undefined && an.productCandidate !== c.expect.productCandidate) {
      failures.push(`productCandidate: got "${an.productCandidate}", want "${c.expect.productCandidate}"`);
    }
    if (c.expect.domain !== undefined && an.domain !== c.expect.domain) {
      failures.push(`domain: got "${an.domain}", want "${c.expect.domain}"`);
    }
    if (c.expect.direction !== undefined && an.direction !== c.expect.direction) {
      failures.push(`direction: got "${an.direction}", want "${c.expect.direction}"`);
    }
    if (c.expect.sourceLanguage !== undefined) {
      // direction 컬럼에서 src 추출 (langPair 분리 방식)
      const dirParts = an.direction?.split(/[→↔]/);
      const gotSrc = dirParts?.[0]?.trim() || "";
      if (gotSrc !== c.expect.sourceLanguage) {
        failures.push(`sourceLanguage(from direction): got "${gotSrc}", want "${c.expect.sourceLanguage}"`);
      }
    }
    if (c.expect.targetLanguage !== undefined) {
      const dirParts = an.direction?.split(/[→↔]/);
      const gotTgt = dirParts?.[1]?.trim() || "";
      if (gotTgt !== c.expect.targetLanguage) {
        failures.push(`targetLanguage(from direction): got "${gotTgt}", want "${c.expect.targetLanguage}"`);
      }
    }
    if (c.expect.minConfidence !== undefined && an.confidenceScore < c.expect.minConfidence) {
      failures.push(`confidence: got ${an.confidenceScore}, want ≥${c.expect.minConfidence}`);
    }
    if (c.expect.reviewReasonIncludes) {
      for (const r of c.expect.reviewReasonIncludes) {
        if (!an.reviewReasons.includes(r)) {
          failures.push(`reviewReason missing: "${r}" (got [${an.reviewReasons.join(", ")}])`);
        }
      }
    }
    if (c.expect.reviewReasonExcludes) {
      for (const r of c.expect.reviewReasonExcludes) {
        if (an.reviewReasons.includes(r)) {
          failures.push(`reviewReason should NOT be present: "${r}"`);
        }
      }
    }

    if (failures.length === 0) {
      console.log(`  PASS  "${c.input}"  (confidence=${an.confidenceScore})`);
      passed++;
    } else {
      console.log(`  FAIL  "${c.input}"  (confidence=${an.confidenceScore})`);
      failures.forEach(f => console.log(`         └─ ${f}`));
      failed++;
      sectionFailed++;
    }
  }
}

const total = passed + failed;
console.log(`\n결과: ${passed}/${total} 통과${failed > 0 ? `, ${failed} 실패` : " ✓"}`);
if (failed > 0) process.exit(1);
