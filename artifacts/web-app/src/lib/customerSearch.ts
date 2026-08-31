/**
 * customerSearch — 거래처/담당자 검색·매칭 로직 (UI 비종속).
 *
 * 기존 서버 API를 그대로 래핑한다. 새 검색 시스템을 만들지 않는다.
 *  · searchCompanies      → GET /api/admin/companies?search=  (회사명/브랜드/사업자번호/대표자/이메일/전화/담당자명/부서 통합검색)
 *  · listCompanyContacts  → GET /api/admin/contacts?companyId= (담당자 전체필드, 자동채움용)
 *
 * 이 모듈은 화면(등록 폼)뿐 아니라 향후 AI 자동접수(추출값→후보검색→매칭)에서도 재사용한다.
 * 따라서 fetch/매핑 로직만 담고 React 상태에 의존하지 않는다.
 */
import { api } from './constants';

export interface CompanyHit {
  id: number;
  name: string;
  businessNumber?: string | null;
  representativeName?: string | null;
  phone?: string | null;
  mobile?: string | null;
  email?: string | null;
  customerType?: string | null;
  companyType?: string | null;
}

export interface ContactHit {
  id: number;
  name: string;
  companyId: number;
  divisionId?: number | null;
  department?: string | null;
  position?: string | null;
  phone?: string | null;
  mobile?: string | null;
  email?: string | null;
  officePhone?: string | null;
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** 거래처 통합검색 — 기존 GET /api/admin/companies(search=) 재사용. */
export async function searchCompanies(token: string, query: string, limit = 8): Promise<CompanyHit[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    const res = await fetch(api(`/api/admin/companies?page=1&pageSize=${limit}&search=${encodeURIComponent(q)}`), { headers: authHeader(token) });
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    const rows: any[] = Array.isArray(data) ? data : (data?.rows ?? []);
    return rows.slice(0, limit).map(c => ({
      id: c.id, name: c.name,
      businessNumber: c.businessNumber, representativeName: c.representativeName,
      phone: c.phone, mobile: c.mobile, email: c.email,
      customerType: c.customerType, companyType: c.companyType,
    }));
  } catch { return []; }
}

/** 특정 거래처의 담당자 목록 — 기존 GET /api/admin/contacts?companyId= 재사용(전체 필드). */
export async function listCompanyContacts(token: string, companyId: number): Promise<ContactHit[]> {
  try {
    const res = await fetch(api(`/api/admin/contacts?companyId=${companyId}`), { headers: authHeader(token) });
    if (!res.ok) return [];
    const data = await res.json().catch(() => []);
    const rows: any[] = Array.isArray(data) ? data : (data?.rows ?? []);
    return rows.map(c => ({
      id: c.id, name: c.name, companyId: c.companyId, divisionId: c.divisionId,
      department: c.department, position: c.position,
      phone: c.phone, mobile: c.mobile, email: c.email, officePhone: c.officePhone,
    }));
  } catch { return []; }
}
