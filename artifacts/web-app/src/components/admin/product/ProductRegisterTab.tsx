import { Card } from '../../ui';
import { LazyProductPanel } from '../LazyProductPanel';
import { ProductRequestSection } from './ProductRequestSection';
import { Section } from './productShared';

interface Props {
  token: string;
  user: { role: string } | null;
  hasPerm: (perm: string) => boolean;
  setToast: (msg: string) => void;
  authHeaders: Record<string, string>;
}

/**
 * 상품등록 — 조건 선택 → 기존 상품 조회 → 동일 상품이 없으면 신규 생성 (빠른 상품 조회/생성).
 * 하단에서 등록 요청(승인/거절/삭제)을 함께 관리한다.
 * 상품 생성·코드/이름 자동생성 로직은 LazyProductPanel(기존 빠른생성)을 그대로 재사용.
 */
export function ProductRegisterTab({ token, user, hasPerm, setToast, authHeaders }: Props) {
  const canManage = hasPerm("product.manage");

  return (
    <>
      <Section title="상품등록" sub="조건을 선택해 기존 상품을 조회하고, 동일 상품이 없으면 새 상품을 생성합니다.">
        {canManage ? (
          <LazyProductPanel
            token={token}
            authHeaders={authHeaders}
            setToast={setToast}
            onProductCreated={() => { /* 생성 후 목록 방문 시 자동 반영 (목록은 마운트 시 재조회) */ }}
          />
        ) : (
          <Card style={{ padding: "20px 24px", color: "#9ca3af", fontSize: 13 }}>
            상품 등록 권한이 없습니다. 아래에서 등록 요청을 제출할 수 있습니다.
          </Card>
        )}
      </Section>

      {/* 등록요청 관리 — 상품 등록 업무와 승인 업무를 한 화면에서 처리 */}
      <ProductRequestSection token={token} user={user} setToast={setToast} authHeaders={authHeaders} />
    </>
  );
}
