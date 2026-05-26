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
      displayName: "한국어-터키어 번역",
      minConfidence: 85,
      reviewReasonIncludes: ["COMPACT_DIRECTION_PATTERN"],
    },
  },
  // ── Country language alias ────────────────────────────────────────────────
  {
    input: "파키스탄어-한국어번역",
    expect: {
      direction: "ur→ko",
      sourceLanguage: "ur",
      targetLanguage: "ko",
      displayName: "우르두어-한국어 번역",
      minConfidence: 75,
      reviewReasonIncludes: ["COUNTRY_LANGUAGE_ALIAS"],
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
      reviewReasonIncludes: ["COUNTRY_LANGUAGE_ALIAS"],
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

const ALL_CASES: { label: string; cases: Case[] }[] = [
  { label: "Regression (기존 9케이스)", cases: REGRESSION_CASES },
  { label: "New (신규 11케이스)",       cases: NEW_CASES },
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
