// ─── 서비스 그룹(본 서비스 ↔ 부대 판매항목) parent_item_id 링크 헬퍼 ─────────────
//  · 목적: quote_items.parent_item_id 를 "생성/수정(인덱스 기반)"·"clone(old→new 재매핑)" 양쪽에서 안전하게 세팅.
//  · 매출 그룹 관계 전용 — 정산/금액 계산과 무관(수익률 계산에서만 사용).
//  · 무결성 규칙: 같은 quote 내 링크만 유효, 자기참조 금지, 1-depth(부대→부대 금지)만 허용. 위반은 무시(자동 보정 없이 NULL 유지).
import { eq } from "drizzle-orm";
import { quoteItemsTable } from "@workspace/db";

// drizzle 트랜잭션 핸들(타입 순환 회피용 최소 시그니처).
type Tx = { update: typeof import("@workspace/db")["db"]["update"] } | any;

// ── 생성/수정: 클라이언트가 보낸 parentItemIndex(같은 items[] 배열 내 부모 인덱스) 기반으로 링크 확정 ──
//   삽입은 배열 순서를 보존하므로 insertedIds[i] === items[i] 의 새 id 다.
//   범위 밖·자기참조·부모가 부대항목(expense/discount)인 경우는 무시 → 1-depth·무순환 보장.
export async function applyParentIndexLinks(
  tx: Tx,
  insertedIds: number[],
  items: { itemType?: string | null; parentItemIndex?: number | null }[],
): Promise<number> {
  let linked = 0;
  for (let i = 0; i < items.length; i++) {
    const pIdx = items[i]?.parentItemIndex;
    if (pIdx == null) continue;
    if (!Number.isInteger(pIdx) || pIdx < 0 || pIdx >= insertedIds.length || pIdx === i) continue; // 범위밖·자기참조
    const parentType = items[pIdx]?.itemType ?? "";
    if (parentType === "expense" || parentType === "discount") continue; // 부대/할인은 부모 불가(1-depth)
    await tx.update(quoteItemsTable).set({ parentItemId: insertedIds[pIdx] }).where(eq(quoteItemsTable.id, insertedIds[i]));
    linked++;
  }
  return linked;
}

// ── clone(revision/additional/derived/copy): 원본 parent_item_id(old) → 새 항목 id 로 재매핑 ──
//   srcItems[i] ↔ newIds[i] (같은 순서). 원본 부모가 이 clone 집합 밖(파생 부분분할 등)이면 NULL 유지(공통비용으로 강등 §12).
//   호출부는 반드시 삽입 시 parentItemId=null 로 넣은 뒤 이 함수로 재매핑한다(cross-quote 링크 방지).
export async function remapClonedParentLinks(
  tx: Tx,
  srcItems: { id: number; parentItemId: number | null }[],
  newIds: number[],
): Promise<number> {
  const idMap = new Map<number, number>();
  srcItems.forEach((s, i) => { if (newIds[i] != null) idMap.set(s.id, newIds[i]); });
  let linked = 0;
  for (let i = 0; i < srcItems.length; i++) {
    const oldP = srcItems[i].parentItemId;
    if (oldP == null) continue;
    const newP = idMap.get(oldP);
    if (newP == null) continue; // 부모가 clone 집합 밖 → NULL 유지
    await tx.update(quoteItemsTable).set({ parentItemId: newP }).where(eq(quoteItemsTable.id, newIds[i]));
    linked++;
  }
  return linked;
}
