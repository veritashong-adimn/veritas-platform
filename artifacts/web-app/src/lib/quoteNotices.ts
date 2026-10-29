/**
 * 견적서 '안내말씀' 템플릿 — 베리타스 공통 운영조건 + 서비스별 고객 고지사항.
 *
 *  · 비고(프로젝트별 요청·특이사항)와 별개. 견적 조건(유효기간·문의 이메일)은 여기 넣지 않는다.
 *  · 고지만 한다 — 녹음·방송 이용료, 취소보상비를 견적금액에 합산하지 않는다.
 *
 * 수정 방법(소급 방지):
 *  기존 버전의 문구를 고치지 말고, QUOTE_NOTICE_VERSIONS 끝에 새 버전을 추가하고 effectiveFrom 에 시행일을 적는다.
 *  견적서는 발행일(issueDate)이 속한 버전으로 출력되므로 이미 발행한 견적서의 고지사항은 바뀌지 않는다.
 */

export type NoticeKey = 'common' | 'interpretation' | 'interpRecording' | 'interpCancel' | 'translation'
  // 번역 전용 견적서(번역 품목만) — 공통 대신 번역 기준 4개 영역
  | 'transCommon' | 'transWork' | 'transDelivery' | 'transSecurity'
  // 통역장비 — 장비 단독은 4개 영역 전체, 복합은 공통(equipCommon)을 뺀 장비 전용 3개 영역
  | 'equipCommon' | 'equipInstall' | 'equipCancel' | 'equipSafety';

export interface NoticeRate { label: string; value: string }
export interface NoticeSection {
  key: NoticeKey;
  title: string;
  /** 번호 매긴 항목(①②③…) */
  items?: string[];
  /** 서술 문단(요율 앞) */
  intro?: string[];
  /** 요율표 — 라벨 / 요율 */
  rates?: NoticeRate[];
  /** 요율 뒤 문단 */
  outro?: string[];
  /** 번호 항목과 요율표를 순서대로 섞어 표시할 때(번호는 항목만 이어서 매김) — items/intro/rates/outro 대신 사용 */
  blocks?: Array<{ item: string } | { rates: NoticeRate[] }>;
}

export interface NoticeTemplateVersion {
  version: string;
  /** 시행일(YYYY-MM-DD) — 이 날짜 이후 발행 견적서에 적용. 첫 버전은 '' (이전 견적서 전체) */
  effectiveFrom: string;
  sections: Record<NoticeKey, NoticeSection>;
}

export const QUOTE_NOTICE_VERSIONS: NoticeTemplateVersion[] = [
  {
    version: '2026-10-v1',
    effectiveFrom: '',
    sections: {
      common: {
        key: 'common',
        title: '견적 및 서비스 조건',
        items: [
          '본 견적은 명시된 서비스 내용, 일정, 인원 및 수행 조건을 기준으로 산정되었습니다. 해당 조건이 변경될 경우 견적금액이 조정될 수 있습니다.',
          '견적 내용에 오류 또는 변경사항이 있는 경우 사전에 알려주시기 바랍니다.',
          '세금계산서 발행을 위해 사업자등록증 등 필요한 정보를 요청드릴 수 있습니다.',
          '서비스 일정, 장소, 업무범위 또는 수행시간이 변경될 경우 추가 비용이 발생할 수 있습니다.',
        ],
      },
      interpretation: {
        key: 'interpretation',
        title: '통역 서비스 운영',
        items: [
          '동시통역은 원칙적으로 통역사 2인 1조로 운영하며, 순차통역은 업무 조건에 따라 필요 인원을 결정합니다.',
          '통역사는 언어, 전문분야, 경력 및 일정 등을 고려하여 배정하며, 최종 확정 전에는 배정이 변경될 수 있습니다.',
          '통역시간 연장, 교통비, 숙박비 등 부대비용은 견적서에 명시된 조건에 따라 별도로 적용될 수 있습니다.',
          '원활한 통역 준비를 위해 행사 일정, 발표자료 및 관련 참고자료를 사전에 제공해 주시기 바랍니다.',
        ],
      },
      interpRecording: {
        key: 'interpRecording',
        title: '통역 녹음·방송 및 2차 이용',
        intro: [
          '통역 내용을 녹음·녹화·방송하거나 재사용하려는 경우 반드시 사전 협의가 필요합니다.',
          '다음 기준에 따라 기본 통역료와 별도로 추가 이용료가 청구됩니다.',
        ],
        rates: [
          { label: '내부 보관용 녹음·녹화', value: '기본 통역료의 50%' },
          { label: '대외 공개·방송·배포용', value: '기본 통역료의 100%' },
        ],
        outro: ['해당 이용료는 통역료와 별도로 부과됩니다.'],
      },
      interpCancel: {
        key: 'interpCancel',
        title: '통역 취소보상비',
        intro: ['고객 사정으로 확정된 통역 업무를 취소하는 경우, 통역 예정일을 기준으로 다음 취소보상비가 발생합니다.'],
        // 확정 정책의 시점만 표기한다(6일 전·8일 이상 전 등 정책에 없는 시점의 요율은 만들지 않음)
        rates: [
          { label: '통역일 7일 전 취소', value: '통역료의 30%' },
          { label: '통역일 2~5일 전 취소', value: '통역료의 50%' },
          { label: '통역일 전일 취소', value: '통역료의 70%' },
          { label: '통역일 당일 취소', value: '통역료의 100%' },
        ],
      },
      translation: {
        key: 'translation',
        title: '번역 서비스 운영',
        items: [
          '번역은 견적서에 명시된 언어, 분량, 전문분야 및 납품 조건을 기준으로 진행합니다.',
          '원문 변경, 분량 증가, 추가 작업 또는 납품 조건 변경 시 비용과 납품 일정이 조정될 수 있습니다.',
          '전문용어, 고유명사 및 참고자료가 있는 경우 사전에 제공해 주시기 바랍니다.',
        ],
      },
      // ── 통역장비 — 장비 단독 견적서 전용 안내말씀(확정 문구) ──
      equipCommon: {
        key: 'equipCommon',
        title: '견적 및 서비스 조건',
        items: [
          '본 견적은 행사 일정, 장소, 장비 종류, 수량 및 사용 시간을 기준으로 산정되었습니다. 해당 조건이 변경되는 경우 견적금액이 조정될 수 있습니다.',
          '견적에 포함되지 않은 장비, 추가 운영시간 및 별도 서비스는 추가 비용이 발생할 수 있습니다.',
          '세금계산서 발행을 위해 사업자등록증 등 필요한 정보를 요청드릴 수 있습니다.',
        ],
      },
      equipInstall: {
        key: 'equipInstall',
        title: '장비 설치 및 운영',
        items: [
          '통역장비의 설치 및 철수 일정은 행사 장소와 운영 여건을 고려하여 사전에 협의합니다.',
          '장비 설치에 필요한 공간, 전원 및 행사장 출입 등은 고객 측의 협조가 필요합니다.',
          '장비 운영인력 및 기술지원 범위는 견적서에 명시된 조건에 따릅니다.',
          '고객 측의 귀책사유로 발생한 장비의 파손 또는 분실은 별도 비용이 청구될 수 있습니다.',
        ],
      },
      equipCancel: {
        key: 'equipCancel',
        title: '일정 변경 및 취소보상비',
        // 기준 금액은 장비 서비스의 확정 계약금액(통역 취소보상비의 '통역료'와 구분). 고지만 하며 견적금액에 합산하지 않는다.
        blocks: [
          { item: '통역장비 대여가 확정된 후 고객 사정으로 취소되는 경우 다음 기준에 따라 취소보상비가 발생합니다.' },
          { rates: [
            { label: '행사 7일 전 취소', value: '계약금액의 30%' },
            { label: '행사 2~5일 전 취소', value: '계약금액의 50%' },
            { label: '행사 전일 취소', value: '계약금액의 70%' },
            { label: '행사 당일 취소', value: '계약금액의 100%' },
          ] },
          { item: '행사 일정이나 장소가 변경되는 경우 장비 및 운영인력의 재배정 가능 여부에 따라 추가 비용이 발생할 수 있습니다.' },
          { item: '취소보상비는 취소된 장비 서비스의 확정 계약금액을 기준으로 산정합니다.' },
        ],
      },
      equipSafety: {
        key: 'equipSafety',
        title: '안전 및 기타 사항',
        items: [
          '고객은 행사 진행 중 통역장비가 안전하게 사용될 수 있도록 협조해 주시기 바랍니다.',
          '장비의 임의 이동, 분해 또는 설치 변경이 필요한 경우 사전에 당사 담당자와 협의해 주시기 바랍니다.',
          '천재지변 등 불가항력적인 사유로 정상적인 장비 운영이 어려운 경우 처리 조건은 상호 협의합니다.',
        ],
      },
      // ── 번역 전용 견적서 — 기존 CRM 번역 견적서 안내말씀을 교정·정리한 확정 문구(결제조건·감사 인사 제외) ──
      transCommon: {
        key: 'transCommon',
        title: '견적 및 서비스 조건',
        items: [
          '본 견적은 제공된 원문, 언어, 분량, 전문분야 및 납품 조건을 기준으로 산정되었습니다. 원문 변경, 분량 증가 또는 작업 범위 변경 시 견적금액과 납품 일정이 조정될 수 있습니다.',
          '견적 내용에 오류 또는 변경사항이 있는 경우 작업 시작 전에 알려주시기 바랍니다.',
          '세금계산서 발행을 위해 사업자등록증 등 필요한 정보를 요청드릴 수 있습니다.',
        ],
      },
      transWork: {
        key: 'transWork',
        title: '번역 작업 및 참고자료',
        items: [
          '번역에 필요한 용어집, 고유명사 표기 기준 및 참고자료는 작업 시작 전에 제공해 주시기 바랍니다.',
          '사전 제공되지 않은 용어 기준에 따른 납품 후 일괄 수정은 추가 작업으로 처리될 수 있습니다.',
          '급행 번역이나 추가 검수 작업은 별도 비용이 발생할 수 있습니다.',
        ],
      },
      transDelivery: {
        key: 'transDelivery',
        title: '납품 및 검수',
        items: [
          '번역물은 MS Word 또는 아래한글 형식으로 납품하는 것을 기본으로 하며, 다른 형식이 필요한 경우 사전에 협의합니다.',
          '납품된 번역물은 고객께서 최종 사용 전에 검토해 주시기 바랍니다. 대량 번역물의 검토 일정은 별도로 협의할 수 있습니다.',
          '외부 공개·인쇄·출판용 번역물은 사용 목적에 따라 원어민 검수 및 최종 교정·교열을 권장합니다.',
          '인쇄·출판용 번역물은 최종 제작 전 별도의 검판검수가 필요할 수 있으며, 검수 범위와 책임은 사전에 협의한 조건에 따릅니다.',
        ],
      },
      transSecurity: {
        key: 'transSecurity',
        title: '보안 및 자료 활용',
        items: [
          '의뢰 자료와 번역물은 업무 수행 목적에 따라 관리하며, 고객의 기밀정보 보호를 위한 보안 원칙을 준수합니다.',
          '고객사명 및 번역 프로젝트명은 당사의 주요 수행실적으로 활용될 수 있습니다. 단, 비공개 또는 기밀유지가 필요한 사항은 사전에 협의하여 공개 대상에서 제외합니다.',
        ],
      },
    },
  },
];

/** 발행일 기준 적용 버전 — effectiveFrom ≤ 발행일 인 마지막 버전(발행일 없으면 최신) */
export function pickNoticeVersion(issueDate: string): NoticeTemplateVersion {
  const d = (issueDate ?? '').slice(0, 10);
  let picked = QUOTE_NOTICE_VERSIONS[0];
  for (const v of QUOTE_NOTICE_VERSIONS) if (!d || !v.effectiveFrom || v.effectiveFrom <= d) picked = v;
  return picked;
}

// 녹음·방송 이용료가 이미 별도 품목으로 들어간 경우(같은 비용을 다시 청구하지 않음을 함께 안내)
const RECORDING_ITEM = /녹음|녹화|방송|2차\s*이용|재사용/;

export interface QuoteNotices { version: string; sections: NoticeSection[] }

/**
 * 견적 품목의 서비스 유형으로 안내말씀을 구성한다.
 *  · 통역·번역·장비 품목이 하나도 없으면(부대비용·할인·기타만) 안내말씀을 표시하지 않는다(기존 정책 유지).
 *  · 공통은 한 번, 서비스별 고지는 포함된 서비스만, 같은 고지는 중복하지 않는다.
 *  · 번역 전용(통역·장비 품목 없음)은 번역 4개 영역만 — 2열 배치 순서: 좌상 견적·서비스 조건 / 우상 납품·검수 / 좌하 작업·참고자료 / 우하 보안.
 *  · 장비 전용(통역·번역 품목 없음)은 장비 4개 영역만 — 좌상 견적·서비스 조건 / 우상 일정 변경·취소보상비 / 좌하 설치·운영 / 우하 안전·기타.
 *  · 장비가 섞인 복합은 기존 안내말씀(통역 / 번역 / 통역+번역) 뒤에 장비 전용 3개 영역(설치·운영, 취소보상비, 안전·기타)을 붙인다.
 *    견적·서비스 조건은 앞 서비스의 것 하나만(장비 공통 중복 출력 없음). 취소보상비는 통역(통역료 기준)과 장비(장비 계약금액 기준)를
 *    각자의 영역에 한 번씩만 — 번역에는 취소보상비를 붙이지 않는다.
 *  · 서비스 구분은 품목 분류(productType) 기준 — 상품명의 '통역' 글자로 판단하지 않는다('통역장비 1세트' = 장비).
 */
export function buildQuoteNotices(
  items: Array<{ productType: string; productName?: string; detailText?: string }>,
  issueDate: string,
): QuoteNotices | null {
  const types = new Set(items.map(i => i.productType));
  const hasInterp = types.has('interpretation');
  const hasTrans = types.has('translation');
  const hasEquip = types.has('equipment');
  if (!hasInterp && !hasTrans && !hasEquip) return null;

  const v = pickNoticeVersion(issueDate);
  const S = v.sections;
  const transOnly = [S.transCommon, S.transDelivery, S.transWork, S.transSecurity];
  if (hasTrans && !hasInterp && !hasEquip) return { version: v.version, sections: transOnly };
  if (hasEquip && !hasInterp && !hasTrans) return { version: v.version, sections: [S.equipCommon, S.equipCancel, S.equipInstall, S.equipSafety] };
  const equipSpecific = hasEquip ? [S.equipInstall, S.equipCancel, S.equipSafety] : [];
  // 번역 + 장비 — 번역 안내말씀(번역 전용 4개 영역) + 장비 전용 조항
  if (hasTrans && !hasInterp) return { version: v.version, sections: [...transOnly, ...equipSpecific] };
  const out: NoticeSection[] = [S.common];
  if (hasInterp) {
    out.push(S.interpretation);
    const billed = items.some(i => RECORDING_ITEM.test(`${i.productName ?? ''} ${i.detailText ?? ''}`));
    out.push(billed
      ? { ...S.interpRecording, outro: [...(S.interpRecording.outro ?? []), '본 견적서에 별도 품목으로 포함된 녹음·방송 이용료는 중복 청구하지 않습니다.'] }
      : S.interpRecording);
    out.push(S.interpCancel);
  }
  if (hasTrans) out.push(S.translation);
  out.push(...equipSpecific);
  return { version: v.version, sections: out };
}
