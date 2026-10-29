// ─── 견적서 수신자 고정값 ↔ 현재 담당자 Master 비교(공통) ─────────────────────────
// 견적 수신자 안내(QuoteRecipientRefreshBar)가 쓰는 유일한 비교 기준. 정규화는 비교에만 쓰고 저장값은 바꾸지 않는다.
//   · 거래처: 법인 표기((주)·㈜·주식회사 등)·공백 차이는 같은 거래처(서버 거래처 판정 normName 과 같은 기준)
//   · 이름·직함·부서: 앞뒤 공백 제거 + 중복 공백 정리
//   · 전화·휴대전화: 숫자만 비교(하이픈·공백·괄호 차이 무시)
//   · 이메일: 앞뒤 공백 제거 + 대소문자 무시
//   · null·undefined·빈 문자열은 모두 '없음'. 양쪽 모두 없으면 같음.
//   · 담당자 ID 는 비교하지 않는다(출력 정보 기준).

export type RecipientValues = {
  customerCompanyName: string | null; customerContactName: string | null; customerContactPosition: string | null;
  customerContactDepartment: string | null; customerContactPhone: string | null; customerContactMobile: string | null; customerContactEmail: string | null;
};
export type RecipientKey = keyof RecipientValues;

const text = (v?: string | null) => (v ?? '').trim().replace(/\s+/g, ' ');
const company = (v?: string | null) => (v ?? '').replace(/\(주\)|㈜|주식회사|\(재\)|재단법인|\(사\)|사단법인|\s+/g, '').toLowerCase();
const phone = (v?: string | null) => (v ?? '').replace(/\D/g, '');
const email = (v?: string | null) => (v ?? '').trim().toLowerCase();

export const RECIPIENT_FIELDS: Array<{ key: RecipientKey; label: string; norm: (v?: string | null) => string; core: boolean }> = [
  { key: 'customerCompanyName', label: '거래처', norm: company, core: false },
  { key: 'customerContactName', label: '담당자', norm: text, core: true },
  { key: 'customerContactPosition', label: '직함', norm: text, core: false },
  { key: 'customerContactDepartment', label: '부서', norm: text, core: false },
  { key: 'customerContactPhone', label: '전화', norm: phone, core: true },
  { key: 'customerContactMobile', label: '휴대전화', norm: phone, core: false },
  { key: 'customerContactEmail', label: '이메일', norm: email, core: true },
];

export type RecipientDiff = { key: RecipientKey; label: string; liveMissing: boolean };
export type RecipientCompare =
  | { status: 'same' }
  | { status: 'no_live_contact' }                    // 현재 담당자를 확인할 수 없음(미연결·이름 없음) — 확인 필요
  | { status: 'diff'; diffs: RecipientDiff[]; refreshable: boolean };

/**
 * 비교 규칙
 *  · 담당자·전화·이메일(core): 한쪽에만 값이 있어도 불일치.
 *  · 그 외(거래처·직함·부서·휴대전화): 현재 Master 에 값이 있을 때만 비교 — Master 에 없는 값은 갱신해도 지우지 않으므로(판매 당시 원본 보존) 안내하지 않는다.
 *  · refreshable: '담당자 정보 갱신'으로 해소되는 차이(현재 Master 에 값이 있는 항목)가 하나라도 있을 때만 true.
 *    현재 Master 에만 값이 없는 항목은 갱신해도 기존 고정값이 유지되므로 Master 보완이 필요하다.
 */
export function compareRecipient(fixed: RecipientValues, live: RecipientValues | null | undefined): RecipientCompare {
  if (!live || text(live.customerContactName) === '') return { status: 'no_live_contact' };
  const diffs: RecipientDiff[] = [];
  for (const f of RECIPIENT_FIELDS) {
    const a = f.norm(fixed[f.key]), b = f.norm(live[f.key]);
    if (a === b) continue;
    if (b === '' && !f.core) continue;
    diffs.push({ key: f.key, label: f.label, liveMissing: b === '' });
  }
  if (!diffs.length) return { status: 'same' };
  return { status: 'diff', diffs, refreshable: diffs.some(d => !d.liveMissing) };
}
