/**
 * 운영용 상품 Naming Policy 최종 정비 — 9-case 검증 스크립트
 * 실행: cd artifacts/api-server && pnpm run build:test && node dist/test-product-naming.mjs
 */
import { analyzeProductStructure } from "./routes/products.js";

type Case = {
  input: string;
  productType?: string;
  expect: {
    displayName?: string;
    productCandidate?: string;
    domain?: string;
  };
};

const CASES: Case[] = [
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
    expect: { displayName: "일본어-한국어 동시통역" },
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

let passed = 0;
let failed = 0;

for (const c of CASES) {
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

  if (failures.length === 0) {
    console.log(`  PASS  "${c.input}"`);
    passed++;
  } else {
    console.log(`  FAIL  "${c.input}"`);
    failures.forEach(f => console.log(`         └─ ${f}`));
    failed++;
  }
}

console.log(`\n결과: ${passed}/${CASES.length} 통과${failed > 0 ? `, ${failed} 실패` : ""}`);
if (failed > 0) process.exit(1);
