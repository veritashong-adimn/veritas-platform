// ─────────────────────────────────────────────────────────────────────────────
// quoteItemForm — API 견적 품목(QuoteDetailItem) → 폼/표시 모델(QuoteItemForm) 변환
//
// 견적관리 편집 진입(QuoteListTab)과 판매관리 읽기전용 뷰(QuoteItemsView)가 동일한
// 방식으로 품목 데이터를 해석하도록 공용화한 순수 함수. 레거시 memo/interpretDuration
// 포맷, 장비 수량 역산 등 복원 규칙을 한 곳에서 관리한다 (동일 로직 중복 개발 방지).
// ─────────────────────────────────────────────────────────────────────────────
import { parseMemoInfo, type QuoteDetailItem } from './quotePdf';
import type { QuoteItemForm, ServiceType, VatType } from '../components/admin/QuoteEditorWorkspace';

// QuoteDetailItem → QuoteItemForm 변환
export function convertToFormItem(it: QuoteDetailItem & { productId?: number | null; taxType?: string | null }): QuoteItemForm {
  const type = (it.itemType ?? 'translation') as ServiceType;
  const taxType: VatType = (it.taxType === 'taxable' || it.taxType === 'exempt' || it.taxType === 'zero_rate') ? it.taxType : 'taxable';
  const { fields, userMemo } = parseMemoInfo(it.memo);
  // 통역 인원 복원 우선순위:
  // 1) interpreter_count 컬럼 (신규 저장 포맷 — quantity = 진행일수)
  // 2) 비고의 "투입인원: N명" (Legacy)
  // 3) quantity ÷ serviceDays 역산 (구 포맷 — quantity = 인원×일수)
  const sd = (() => {
    if (type !== 'interpretation' || !it.interpretDate) return 0;
    const eDate = it.eventEndDate;
    if (!eDate || eDate === it.interpretDate) return 1;
    return Math.max(1, Math.round((new Date(eDate).getTime() - new Date(it.interpretDate).getTime()) / 86400000) + 1);
  })();
  const qty = Number(it.quantity) || 1;
  let interpreterCount = '';
  if (type === 'interpretation') {
    const col = (it as { interpreterCount?: number | null }).interpreterCount;
    const memoCount = fields['투입인원'];
    if (col != null && Number(col) > 0) {
      interpreterCount = String(Number(col));            // 신규: interpreter_count 컬럼
    } else if (memoCount && Number(memoCount) > 0) {
      interpreterCount = memoCount;                       // Legacy: "투입인원: N명"
    } else if (sd > 0) {
      interpreterCount = String(Math.round(qty / sd));    // 구 포맷: billingQty ÷ days
    }
  }
  // 폼 수량 복원 —
  //  · 통역: 진행일수 (신규 포맷은 qty가 이미 일수, 구 포맷은 날짜에서 재산출)
  //  · 장비: 저장 quantity = 사용일수 × 수량 이므로 사용일수로 나눠 '순수 수량'을 복원한다.
  //    (나누지 않으면 저장 시마다 사용일수가 재차 곱해져 수량이 1→2→4→…로 증식하는 버그가 발생)
  const usageDays = type === 'equipment' ? Math.max(1, Number(it.usagePeriod) || 1) : 1;
  const formQuantity =
    type === 'interpretation' && sd > 0 ? String(sd)
    : type === 'equipment' ? String(Math.max(1, Math.round(qty / usageDays)))
    : String(qty);
  const [startTime = '', endTime = ''] = it.interpretDuration ? it.interpretDuration.split('~') : [];
  const sourceLanguage = it.languagePair ? it.languagePair.split('-')[0] : 'ko';
  // 할인 항목 복원 — discount_type/value/reason 컬럼에서
  const dc = it as { discountType?: string | null; discountValue?: string | number | null; discountReason?: string | null };
  return {
    productId:        it.productId ?? null,
    productName:      it.productName,
    productType:      type,
    quantity:         formQuantity,
    unit:             it.unit,
    unitPrice:        String(Number(it.unitPrice)),
    taxType,
    memo:             userMemo,
    sourceLanguage,
    fileName:         fields['파일']   ?? '',
    fileFormat:       fields['형식']   ?? '',
    wordCount:        fields['단어수'] ?? '',
    charCount:        fields['글자수'] ?? '',
    interpretDate:    it.interpretDate     ?? '',
    interpretEndDate: it.eventEndDate      ?? '',
    startTime,
    endTime,
    // 통역시간 복원 — "N시간/일" 저장 문자열에서 숫자(소수 포함) 추출 (예: "6.5시간/일" → "6.5")
    interpretHours:   it.interpretDuration ? (it.interpretDuration.match(/\d+(\.\d+)?/)?.[0] ?? '') : '',
    // 운영시간 복원 — 저장된 자유입력 문자열 그대로
    operationHours:   (it as { operationHours?: string | null }).operationHours ?? '',
    interpretPlace:   it.interpretPlace    ?? '',
    interpreterCount,
    eventStartDate:   it.eventStartDate    ?? '',
    eventEndDate:     it.eventEndDate      ?? '',
    itemLocation:     it.itemLocation      ?? '',
    usagePeriod:      it.usagePeriod       ?? '',
    expenseType:      it.interpretType     ?? '',
    // 할인 전용 — 금액은 원화 정수로 정규화(DB numeric의 "400000.00" → "400000")
    discountType:     (dc.discountType === 'percent' ? 'percent' : 'amount'),
    discountValue:    dc.discountValue != null && dc.discountValue !== '' ? String(Number(dc.discountValue)) : '',
    discountReason:   dc.discountReason ?? '',
  };
}
