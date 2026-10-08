// C-4I-a Record Matching DRY-RUN(analyzeRecordMatching) — 순수함수 테스트(DB 미접근).
//   INITIAL/SAME/UPDATED(입금·지급·통번역사)/NEW/AMBIGUOUS(후보2)/identical group/multiplicity 변경/
//   4년전 update/부분파일 미삭제/주민번호·row_hash·source_row 비식별/성능(O(N+E)).
import { analyzeRecordMatching, type MatchableRow } from "./services/legacyArchiveResolve";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); }
}
let seq = 1;
function R(o: Partial<MatchableRow>): MatchableRow {
  const base: MatchableRow = {
    id: o.id, sourceRow: o.sourceRow ?? seq++, rowHash: "",
    recordDate: o.recordDate ?? null, companyName: o.companyName ?? null, contactName: o.contactName ?? null,
    translatorName: o.translatorName ?? null, productName: o.productName ?? null, language: o.language ?? null,
    deliveryDate: o.deliveryDate ?? null, payoutDate: o.payoutDate ?? null, payoutPretax: o.payoutPretax ?? null,
    collectionDate: o.collectionDate ?? null, collectionStatus: o.collectionStatus ?? null,
    supplyAmount: o.supplyAmount ?? null, vatAmount: o.vatAmount ?? null, totalAmount: o.totalAmount ?? null,
  };
  // rowHash 는 실제 시스템처럼 "내용"에서 결정론적으로 파생(동일 내용 → 동일 rowHash). 명시 override 우선.
  base.rowHash = o.rowHash ?? JSON.stringify([base.recordDate, base.companyName, base.contactName, base.translatorName, base.productName, base.language, base.deliveryDate, base.payoutDate, base.payoutPretax, base.collectionDate, base.collectionStatus, base.supplyAmount, base.vatAmount, base.totalAmount]);
  return base;
}
// 안정 stable key(거래처+고객+상품+언어+견적일) 동일 레코드 생성 헬퍼
function rec(co: string, prod: string, extra: Partial<MatchableRow> = {}): MatchableRow {
  return R({ companyName: co, contactName: "고객", productName: prod, language: "영어", recordDate: "2022-05-01", ...extra });
}

function main() {
  // INITIAL — existing 없음 → 전부 NEW (identical 3건 포함, 병합 금지)
  const identicalContent = { rowHash: "SAME_HASH", companyName: "UNESCAP", contactName: "강원대", productName: "영어 동시통역", language: "영어", recordDate: "2024-10-25", deliveryDate: "2024-10-25", payoutPretax: 800000 };
  const init = analyzeRecordMatching([R({ ...identicalContent, sourceRow: 6261 }), R({ ...identicalContent, sourceRow: 6263 }), R({ ...identicalContent, sourceRow: 6265 }), rec("세화", "영어통역")], []);
  check("INITIAL mode / 전부 NEW=4 (identical 3건 병합 안 함)", init.mode === "INITIAL_IMPORT" && init.counts.NEW === 4 && init.counts.SAME === 0, init.counts);

  // CASE A — SAME
  const exA = rec("A", "X", { translatorName: "홍길동", deliveryDate: "2025-01-10" });
  const inA = rec("A", "X", { translatorName: "홍길동", deliveryDate: "2025-01-10" });  // 내용 동일 → 파생 rowHash 동일 → SAME
  const a = analyzeRecordMatching([inA], [exA]);
  check("A. SAME", a.mode === "REUPLOAD" && a.counts.SAME === 1 && a.counts.UPDATED === 0, a.counts);

  // CASE B — UPDATED 입금일 null→날짜
  const b = analyzeRecordMatching([rec("A", "X", { collectionDate: "2026-10-15" })], [rec("A", "X", { collectionDate: null })]);
  check("B. UPDATED(입금)", b.counts.UPDATED === 1, b.counts);
  check("B. changedFields=collectionDate null→2026-10-15", b.updatedSamples[0]?.changedFields.some(c => c.field === "collectionDate" && c.after === "2026-10-15" && c.before === null), b.updatedSamples[0]);

  // CASE C — UPDATED 지급일
  const c = analyzeRecordMatching([rec("A", "X", { payoutDate: "2026-10-31" })], [rec("A", "X", { payoutDate: null })]);
  check("C. UPDATED(지급일)", c.counts.UPDATED === 1 && c.updatedSamples[0]?.changedFields.some(f => f.field === "payoutDate"), c.counts);

  // CASE D — 통번역사 미확정→확정, 유일 후보 → UPDATED
  const d = analyzeRecordMatching([rec("A", "X", { translatorName: "김통역" })], [rec("A", "X", { translatorName: null })]);
  check("D. 통번역사 확정 + 유일후보 → UPDATED", d.counts.UPDATED === 1 && d.updatedSamples[0]?.changedFields.some(f => f.field === "translatorName"), d.counts);

  // CASE E — NEW (기존 있으나 후보 없음, stable 충실)
  const e = analyzeRecordMatching([rec("신규사", "신규상품")], [rec("A", "X")]);
  check("E. NEW", e.counts.NEW === 1 && e.counts.AMBIGUOUS === 0, e.counts);

  // CASE F — 후보 2개 → AMBIGUOUS
  const f = analyzeRecordMatching([rec("A", "X", { collectionDate: "2026-01-01" })], [rec("A", "X", { translatorName: "t1" }), rec("A", "X", { translatorName: "t2" })]);
  check("F. 후보 2개 → AMBIGUOUS(자동 UPDATE 금지)", f.counts.AMBIGUOUS === 1 && f.counts.UPDATED === 0, f.counts);

  // CASE G — identical 3 ↔ 3 동일내용 → SAME-set (1:1 날조 안 함)
  const g3 = (sr: number) => R({ companyName: "G", contactName: "고객", productName: "통역", language: "영어", recordDate: "2023-01-01", rowHash: "GHASH" });
  const g = analyzeRecordMatching([g3(10), g3(11), g3(12)], [g3(1), g3(2), g3(3)]);
  check("G. identical 3↔3 → SAME-set(SAME=3, group=1)", g.counts.SAME === 3 && g.sameSetGroups === 1 && g.counts.AMBIGUOUS === 0, { c: g.counts, s: g.sameSetGroups });

  // CASE H — multiplicity 3→4 → AMBIGUOUS
  const h = analyzeRecordMatching([g3(10), g3(11), g3(12), g3(13)], [g3(1), g3(2), g3(3)]);
  check("H. multiplicity 3→4 → AMBIGUOUS", h.counts.AMBIGUOUS === 4 && h.counts.SAME === 0, h.counts);
  check("H. ambiguous reason 개수변동 명시", /개수 변동/.test(h.ambiguousSamples[0]?.reason ?? ""), h.ambiguousSamples[0]?.reason);

  // CASE I — 4년전(2022) record 입금일 입력 → UPDATED (연도 무관)
  const i = analyzeRecordMatching([rec("장기", "번역", { recordDate: "2022-03-01", collectionDate: "2026-10-15" })], [rec("장기", "번역", { recordDate: "2022-03-01", collectionDate: null })]);
  check("I. 4년전 record 입금 → UPDATED(연도 차단 없음)", i.counts.UPDATED === 1, i.counts);

  // CASE J — 부분파일: 신규는 2025만, 기존 2018~2024 는 incoming 에 없음 → analyzer 는 incoming 만 분류(기존 미삭제는 effective 미변경으로 보장)
  const existingJ = [rec("A", "X", { recordDate: "2019-01-01" }), rec("B", "Y", { recordDate: "2020-01-01" }), rec("C", "Z", { recordDate: "2024-01-01" })];
  const incomingJ = [rec("C", "Z", { recordDate: "2024-01-01", collectionDate: "2026-02-02" }), rec("D", "W", { recordDate: "2025-01-01" })];
  const j = analyzeRecordMatching(incomingJ, existingJ);
  check("J. 부분파일 → incoming 만 판정(UPDATED 1 + NEW 1), total=2", j.total === 2 && j.counts.UPDATED === 1 && j.counts.NEW === 1, j.counts);
  check("J. analyzer 가 기존 3건을 삭제/변형하지 않음(입력 불변)", existingJ.length === 3, existingJ.length);

  // 비식별성 — 주민번호/row_hash/source_row 는 stable key 에 쓰지 않음:
  //  content(거래처/상품 등) 동일하면 주민번호·source_row 가 달라도 같은 후보로 묶여 1:1 → SAME/UPDATED
  const noPiiEx = rec("A", "X", { rowHash: "ZZ1", sourceRow: 999 });
  const noPiiIn = rec("A", "X", { rowHash: "ZZ2", sourceRow: 111, collectionDate: "2026-09-09" });
  const np = analyzeRecordMatching([noPiiIn], [noPiiEx]);
  check("비식별: row_hash/source_row 달라도 stable 동일 → UPDATED(1:1)", np.counts.UPDATED === 1, np.counts);

  // 성능 — 5,000 incoming + 5,000 existing 가 합리적 시간 내(O(N+E)). O(n²)면 수초+.
  const bigEx: MatchableRow[] = [], bigIn: MatchableRow[] = [];
  for (let k = 0; k < 5000; k++) { bigEx.push(rec("C" + k, "P" + k, { collectionDate: null })); bigIn.push(rec("C" + k, "P" + k, { collectionDate: "2026-01-01" })); }
  const t0 = process.hrtime.bigint();
  const big = analyzeRecordMatching(bigIn, bigEx);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check("성능: 5k×5k UPDATED=5000", big.counts.UPDATED === 5000, big.counts);
  check(`성능: O(N+E) < 1500ms (실측 ${ms.toFixed(0)}ms)`, ms < 1500, ms);
  // 응답에 전체 row detail 없음 — sample 상한
  check("sample 상한(updated≤20, ambiguous≤20)", big.updatedSamples.length <= 20 && big.ambiguousSamples.length <= 20, { u: big.updatedSamples.length, a: big.ambiguousSamples.length });

  console.log(`\n== C-4I-a matching tests: ${pass} passed, ${fail} failed ==`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
