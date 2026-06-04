/**
 * searchNormalize 유닛 테스트
 * 실행: cd artifacts/api-server && pnpm run test:search-normalize
 */
import { normalizeSearchQuery, buildProductSearchText } from "./lib/product-parser/searchNormalize.js";

const ISO_LABEL: Record<string, string> = {
  ko: "한국어", en: "영어", ja: "일본어",
  "zh-hans": "중국어(간체)", "zh-hant": "중국어(번체)", zh: "중국어",
  fr: "프랑스어", de: "독일어", es: "스페인어", ru: "러시아어",
  ar: "아랍어", pt: "포르투갈어", vi: "베트남어", th: "태국어",
  id: "인도네시아어", ms: "말레이어", hi: "힌디어",
  tr: "튀르키예어", it: "이탈리아어", mn: "몽골어",
  yue: "광동어",
};

type TestCase = {
  query: string;
  products: { name: string; src: string; tgt: string }[];
  expectMatch: boolean[];
};

const cases: TestCase[] = [
  {
    query: "영한번역",
    products: [
      { name: "영어-한국어 번역",  src: "en", tgt: "ko" },
      { name: "한국어-영어 번역",  src: "ko", tgt: "en" },
      { name: "한국어-일본어 번역", src: "ko", tgt: "ja" },
    ],
    expectMatch: [true, false, false],
  },
  {
    query: "한영번역",
    products: [
      { name: "한국어-영어 번역",  src: "ko", tgt: "en" },
      { name: "영어-한국어 번역",  src: "en", tgt: "ko" },
    ],
    expectMatch: [true, false],
  },
  {
    query: "인한번역",
    products: [
      { name: "인도네시아어-한국어 번역", src: "id", tgt: "ko" },
      { name: "한국어-인도네시아어 번역", src: "ko", tgt: "id" },
    ],
    expectMatch: [true, false],
  },
  {
    query: "한일번역",
    products: [
      { name: "한국어-일본어 번역", src: "ko", tgt: "ja" },
      { name: "일본어-한국어 번역", src: "ja", tgt: "ko" },
    ],
    expectMatch: [true, false],
  },
  {
    query: "일한번역",
    products: [
      { name: "일본어-한국어 번역", src: "ja", tgt: "ko" },
      { name: "한국어-일본어 번역", src: "ko", tgt: "ja" },
    ],
    expectMatch: [true, false],
  },
  {
    query: "중한번역",
    products: [
      { name: "중국어-한국어 번역", src: "zh", tgt: "ko" },
      { name: "한국어-중국어 번역", src: "ko", tgt: "zh" },
    ],
    expectMatch: [true, false],
  },
  {
    query: "한중번역",
    products: [
      { name: "한국어-중국어 번역", src: "ko", tgt: "zh" },
      { name: "중국어-한국어 번역", src: "zh", tgt: "ko" },
    ],
    expectMatch: [true, false],
  },
  {
    query: "영한동시통역",
    products: [
      { name: "영어-한국어 동시통역", src: "en", tgt: "ko" },
      { name: "한국어-영어 동시통역", src: "ko", tgt: "en" },
    ],
    expectMatch: [true, false],
  },
  {
    query: "한베번역",
    products: [
      { name: "한국어-베트남어 번역", src: "ko", tgt: "vi" },
      { name: "베트남어-한국어 번역", src: "vi", tgt: "ko" },
    ],
    expectMatch: [true, false],
  },
  {
    query: "영어-한국어 번역",
    products: [
      { name: "영어-한국어 번역", src: "en", tgt: "ko" },
    ],
    expectMatch: [true],
  },
  {
    // "en" ISO 코드 검색 — "영어-한국어 번역" 매칭 ✓
    // 주의: 코드 "tr-ko-ja-gen-001"의 "gen" 안에 "en"이 포함 → ko/ja 제품도 매칭되는 것은
    //       원래 substring 검색의 pre-existing 동작 (기존 코드도 동일)
    query: "en",
    products: [
      { name: "영어-한국어 번역", src: "en", tgt: "ko" },
      { name: "한국어-일본어 번역", src: "ko", tgt: "ja" },
    ],
    expectMatch: [true, true],
  },
];

let passed = 0;
let failed = 0;

console.log("\n🔍 Search Normalize 테스트\n" + "─".repeat(60));

for (const tc of cases) {
  const candidates = normalizeSearchQuery(tc.query);
  console.log(`\n검색어: "${tc.query}"`);
  console.log(`  후보: ${candidates.join(" | ")}`);

  tc.products.forEach((p, i) => {
    const searchText = buildProductSearchText(
      { name: p.name, code: `TR-${p.src.toUpperCase()}-${p.tgt.toUpperCase()}-GEN-001`, mainCategory: "번역", subCategory: null, sourceLanguage: p.src, targetLanguage: p.tgt },
      ISO_LABEL,
    );
    const matched = candidates.some(c => searchText.includes(c));
    const expected = tc.expectMatch[i];
    const ok = matched === expected;
    if (ok) passed++; else failed++;
    const icon = ok ? "✅" : "❌";
    console.log(`  ${icon} "${p.name}" → ${matched ? "매칭" : "미매칭"} (기대: ${expected ? "매칭" : "미매칭"})`);
    if (!ok) {
      console.log(`     searchText 일부: ${searchText.slice(0, 120)}`);
    }
  });
}

console.log(`\n${"─".repeat(60)}`);
console.log(`결과: ${passed}건 통과 / ${failed}건 실패\n`);
if (failed > 0) process.exit(1);
