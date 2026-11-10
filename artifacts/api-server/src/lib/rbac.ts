import { db, rolesTable, permissionsTable, rolePermissionsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ─── 권한 정의 ───────────────────────────────────────────────────────────────
// (2026-11-08 현행화) 현재 사이드메뉴 영역 기준으로 재구성. 기존 키는 그대로 유지(역할 연결·코드 참조 보존).
//   · group     : 역할관리 화면의 업무 영역(사이드메뉴와 같은 순서)
//   · deprecated: 실제 기능·API 에 연결되지 않은 과거 권한 → 역할관리 화면에서 숨김(DB 행·역할 연결은 보존)
//   · enforce   : 'api' = 서버 API 에서 검사 · 'menu' = 메뉴 노출·페이지 접근만 · 'none' = 아직 검사 지점 없음(2단계 예정)
//   · grantFrom : 신규 권한이 처음 등록될 때 이 키 중 하나를 가진 역할에 1회 자동 부여(기존 접근 범위 보존). 이후 재부여 없음.
export type PermGroup = "dashboard" | "customer" | "sales" | "resource" | "product" | "settlement" | "collection" | "data" | "system" | "trash";
export const PERM_GROUPS: { id: PermGroup; label: string }[] = [
  { id: "dashboard", label: "대시보드" }, { id: "customer", label: "고객·거래처" }, { id: "sales", label: "영업관리" },
  { id: "resource", label: "리소스" }, { id: "product", label: "상품관리" }, { id: "settlement", label: "정산" },
  { id: "collection", label: "수금관리" }, { id: "data", label: "데이터 자산" }, { id: "system", label: "시스템" }, { id: "trash", label: "휴지통" },
];
export type PermDef = { key: string; name: string; category: "menu" | "action"; group: PermGroup; deprecated?: boolean; enforce?: "api" | "menu" | "none"; grantFrom?: string[] };

export const ALL_PERMISSIONS: PermDef[] = [
  // ① 대시보드
  { key: "menu.dashboard",  name: "대시보드",                    category: "menu",   group: "dashboard", enforce: "menu" },
  // ② 고객·거래처
  { key: "menu.company",    name: "거래처 메뉴",                  category: "menu",   group: "customer", enforce: "menu" },
  { key: "menu.contact",    name: "담당자 메뉴",                  category: "menu",   group: "customer", enforce: "menu" },
  { key: "menu.customer",   name: "고객관리 메뉴",                category: "menu",   group: "customer", enforce: "menu" },
  { key: "company.view",    name: "거래처 조회",                  category: "action", group: "customer", enforce: "none" },
  { key: "company.create",  name: "거래처 등록·대량등록",          category: "action", group: "customer", enforce: "api" },
  { key: "company.update",  name: "거래처 수정",                  category: "action", group: "customer", enforce: "api" },
  { key: "contact.view",    name: "담당자 조회",                  category: "action", group: "customer", enforce: "none" },
  { key: "contact.create",  name: "담당자 등록·대량등록",          category: "action", group: "customer", enforce: "api" },
  { key: "contact.update",  name: "담당자 수정",                  category: "action", group: "customer", enforce: "api" },
  // ③ 영업관리 — 의뢰접수 · 견적관리 · 판매관리(기존 '프로젝트' 권한 = 판매건)
  { key: "menu.inquiry",    name: "의뢰접수 메뉴",                category: "menu",   group: "sales", enforce: "menu", grantFrom: ["menu.project"] },
  { key: "inquiry.view",    name: "의뢰건 조회",                  category: "action", group: "sales", enforce: "none", grantFrom: ["menu.project"] },
  { key: "inquiry.create",  name: "의뢰건 등록",                  category: "action", group: "sales", enforce: "none", grantFrom: ["quote.create"] },
  { key: "inquiry.update",  name: "의뢰건 수정",                  category: "action", group: "sales", enforce: "none", grantFrom: ["quote.create"] },
  { key: "inquiry.delete",  name: "의뢰건 삭제·복원",              category: "action", group: "sales", enforce: "none", grantFrom: ["quote.update"] },
  { key: "inquiry.ai",      name: "AI 의뢰 분석",                 category: "action", group: "sales", enforce: "none", grantFrom: ["quote.create"] },
  { key: "menu.quote",      name: "견적관리 메뉴",                category: "menu",   group: "sales", enforce: "menu", grantFrom: ["menu.project"] },
  { key: "quote.view",      name: "견적 조회",                    category: "action", group: "sales", enforce: "api" },
  { key: "quote.create",    name: "견적 생성·판매전환",            category: "action", group: "sales", enforce: "api" },
  { key: "quote.update",    name: "견적 수정·삭제(의뢰건 삭제 포함)", category: "action", group: "sales", enforce: "api" },
  { key: "quote.approve",   name: "견적 승인(미사용 — 승인 절차 없음)", category: "action", group: "sales", deprecated: true },
  { key: "menu.project",    name: "판매관리 메뉴",                category: "menu",   group: "sales", enforce: "menu" },
  { key: "project.view",    name: "판매건 조회(미사용)",           category: "action", group: "sales", deprecated: true },
  { key: "project.create",  name: "판매건 등록·과거 판매 운영 전환", category: "action", group: "sales", enforce: "api" },
  { key: "project.update",  name: "판매건 수정·취소",              category: "action", group: "sales", enforce: "api" },
  { key: "project.delete",  name: "판매건 삭제(미사용)",           category: "action", group: "sales", deprecated: true },
  { key: "task.view",       name: "작업 조회(미사용)",             category: "action", group: "sales", deprecated: true },
  { key: "task.create",     name: "작업 생성(미사용)",             category: "action", group: "sales", deprecated: true },
  { key: "task.update",     name: "작업 수정(미사용)",             category: "action", group: "sales", deprecated: true },
  // ④ 리소스
  { key: "menu.translator", name: "통번역사·외주업체 메뉴",         category: "menu",   group: "resource", enforce: "menu" },
  { key: "translator.sensitive", name: "통번역사 민감정보(주민번호·계좌) 열람", category: "action", group: "resource", enforce: "api" },
  // ⑤ 상품관리
  { key: "menu.product",    name: "상품관리 메뉴",                category: "menu",   group: "product", enforce: "menu" },
  // 실행권한 — 직원(역할 지정)도 부여 가능. 관리자 계정은 기존과 동일하게 전체 허용(routes/products.ts requireProductAction).
  //   조회·삭제/복원은 기존에 메뉴 보유자가 이미 가능했으므로 menu.product 보유 역할에 최초 1회 이어 부여(기존 범위 유지).
  //   등록·수정은 기존에 관리자 전용이었으므로 자동 부여하지 않는다(직원은 관리자가 명시적으로 부여).
  { key: "product.view",    name: "상품 조회",                    category: "action", group: "product", enforce: "menu", grantFrom: ["menu.product"] },
  { key: "product.create",  name: "상품 등록(단건·대량·빠른생성)",   category: "action", group: "product", enforce: "api" },
  { key: "product.update",  name: "상품 수정·활성/비활성",          category: "action", group: "product", enforce: "api" },
  { key: "product.delete",  name: "상품 삭제·복원(휴지통)",         category: "action", group: "product", enforce: "api", grantFrom: ["menu.product"] },
  // ⑥ 정산
  { key: "menu.settlement", name: "정산 메뉴(공통·기존)",          category: "menu",   group: "settlement", enforce: "menu" },
  { key: "menu.payout",     name: "지급회차관리 메뉴",             category: "menu",   group: "settlement", enforce: "menu", grantFrom: ["menu.settlement"] },
  { key: "menu.payout_statement", name: "지급명세서 메뉴",         category: "menu",   group: "settlement", enforce: "menu", grantFrom: ["menu.settlement"] },
  { key: "menu.tax_report", name: "세무자료 메뉴",                category: "menu",   group: "settlement", enforce: "menu", grantFrom: ["menu.settlement"] },
  { key: "menu.payout_ops", name: "운영 지급확정·은행이체 화면",    category: "menu",   group: "settlement", enforce: "menu", grantFrom: ["menu.settlement"] },
  { key: "payout.view",     name: "지급회차 조회",                category: "action", group: "settlement", enforce: "none", grantFrom: ["menu.settlement"] },
  { key: "payout.statement", name: "지급명세서 조회·출력",          category: "action", group: "settlement", enforce: "none", grantFrom: ["menu.settlement"] },
  { key: "tax.view",        name: "세무자료 조회·다운로드",         category: "action", group: "settlement", enforce: "none", grantFrom: ["menu.settlement"] },
  { key: "settlement.pay",  name: "지급확인(과거 지급 확인 처리)",   category: "action", group: "settlement", enforce: "api" },
  { key: "legacy_payout.request", name: "과거 CRM 지급건 전환 요청", category: "action", group: "settlement", enforce: "none", grantFrom: ["menu.settlement"] },
  { key: "legacy_payout.approve", name: "과거 CRM 지급건 전환 승인·반려(관리자)", category: "action", group: "settlement", enforce: "none" },
  { key: "payout.confirm",  name: "운영 지급확정(지급 승인)",       category: "action", group: "settlement", enforce: "none", grantFrom: ["settlement.pay"] },
  { key: "payout.transfer", name: "은행이체·지급완료 처리(지급 실행)", category: "action", group: "settlement", enforce: "none", grantFrom: ["settlement.pay"] },
  { key: "settlement.view", name: "정산 조회(미사용 — 지급회차 조회로 대체)", category: "action", group: "settlement", deprecated: true },
  // ⑦ 수금관리
  { key: "menu.payment",    name: "수금현황 메뉴",                category: "menu",   group: "collection", enforce: "menu" },
  { key: "menu.billing",    name: "누적청구 메뉴",                category: "menu",   group: "collection", enforce: "menu", grantFrom: ["menu.settlement"] },
  { key: "menu.prepaid",    name: "선입금관리 메뉴",              category: "menu",   group: "collection", enforce: "menu", grantFrom: ["menu.settlement"] },
  { key: "payment.create",  name: "수금(입금) 등록",              category: "action", group: "collection", enforce: "api" },
  { key: "prepaid.manage",  name: "선입금 관리",                  category: "action", group: "collection", enforce: "api" },
  { key: "payment.view",    name: "결제 조회(미사용)",             category: "action", group: "collection", deprecated: true },
  { key: "payment.update",  name: "결제 수정(미사용)",             category: "action", group: "collection", deprecated: true },
  { key: "billing.view",    name: "청구 조회(미사용)",             category: "action", group: "collection", deprecated: true },
  // ⑧ 데이터 자산 (기존: 사용자관리 메뉴 권한으로 노출되던 메뉴)
  { key: "menu.data",       name: "데이터 자산 메뉴(과거 CRM·번역 데이터·언어 서비스·인사이트)", category: "menu", group: "data", enforce: "menu", grantFrom: ["menu.user"] },
  { key: "menu.archive",    name: "회사 자료보관함 메뉴",          category: "menu",   group: "data", enforce: "menu" },
  { key: "archive.upload",  name: "자료보관함 자료 등록",          category: "action", group: "data", enforce: "api" },
  { key: "archive.admin",   name: "자료보관함 관리(분류·권한·전체 열람)", category: "action", group: "data", enforce: "api" },
  { key: "archive.approve", name: "자료보관함 승인·반려(승인 전 AI 활용 제한)", category: "action", group: "data", enforce: "api" },
  { key: "archive.purge",   name: "자료보관함 영구 삭제",          category: "action", group: "data", enforce: "api" },
  // ⑨ 시스템
  { key: "menu.user",       name: "사용자관리 메뉴",              category: "menu",   group: "system", enforce: "menu" },
  { key: "user.manage",     name: "사용자 관리(등록·수정)",        category: "action", group: "system", enforce: "api" },
  { key: "menu.permission", name: "역할관리 메뉴(변경은 관리자만)", category: "menu",   group: "system", enforce: "menu" },
  { key: "menu.board",      name: "게시판 메뉴",                  category: "menu",   group: "system", enforce: "menu" },
  { key: "menu.settings",   name: "환경설정 메뉴",                category: "menu",   group: "system", enforce: "menu" },
  { key: "menu.test",       name: "운영 테스트 메뉴",             category: "menu",   group: "system", enforce: "menu", grantFrom: ["menu.user"] },
  // ⑩ 휴지통 (기존: 권한 없이 모든 관리자 화면 사용자에게 노출)
  { key: "menu.trash",      name: "휴지통 메뉴",                  category: "menu",   group: "trash", enforce: "menu", grantFrom: ["*"] },
];
export const PERM_META = new Map(ALL_PERMISSIONS.map(p => [p.key, p]));

// ─── 기본 역할 정의 ──────────────────────────────────────────────────────────

const ALL_KEYS = ALL_PERMISSIONS.map(p => p.key);

export const DEFAULT_ROLES: Array<{
  name: string;
  description: string;
  isSystem: boolean;
  permissions: string[];
}> = [
  {
    name: "admin",
    description: "모든 권한 (시스템 관리자)",
    isSystem: true,
    permissions: ALL_KEYS,
  },
  {
    name: "pm",
    description: "프로젝트/견적/거래처 관리 (정산 지급 제외)",
    isSystem: true,
    permissions: [
      "menu.dashboard", "menu.project", "menu.payment", "menu.company",
      "menu.contact", "menu.customer", "menu.translator", "menu.product", "menu.board",
      "project.view", "project.create", "project.update", "project.delete",
      "quote.view", "quote.create", "quote.update", "quote.approve",
      "payment.view", "payment.create", "payment.update",
      "settlement.view",
      "company.view", "company.create", "company.update",
      "contact.view", "contact.create", "contact.update",
      "task.view", "task.create", "task.update",
      "billing.view",
      // (현행화) 영업관리 세분화 메뉴·의뢰접수 — 기존 menu.project·quote.* 범위와 동일
      "menu.inquiry", "menu.quote", "inquiry.view", "inquiry.create", "inquiry.update", "inquiry.delete", "inquiry.ai", "menu.trash",
    ],
  },
  {
    name: "finance",
    description: "정산/결제 관리 (프로젝트 수정 제한)",
    isSystem: true,
    permissions: [
      "menu.dashboard", "menu.project", "menu.payment", "menu.settlement", "menu.company",
      "menu.translator",
      "project.view",
      "quote.view",
      "settlement.view", "settlement.pay",
      "payment.view", "payment.create", "payment.update",
      "company.view",
      "billing.view", "prepaid.manage",
      "translator.sensitive",
      // (현행화) 정산·수금 세분화 — 기존 menu.settlement·settlement.pay 범위와 동일
      "menu.inquiry", "inquiry.view", "menu.quote",
      "menu.payout", "menu.payout_statement", "menu.tax_report", "menu.payout_ops", "menu.billing", "menu.prepaid",
      "payout.view", "payout.statement", "tax.view", "legacy_payout.request", "payout.confirm", "payout.transfer", "menu.trash",
    ],
  },
  {
    name: "viewer",
    description: "조회만 가능",
    isSystem: true,
    permissions: [
      "menu.dashboard", "menu.project", "menu.company", "menu.contact",
      "project.view", "quote.view",
      "company.view", "contact.view",
      "task.view", "settlement.view", "payment.view",
      "menu.inquiry", "inquiry.view", "menu.quote", "menu.trash",
    ],
  },
];

// ─── 권한 캐시 (roleId → Set<key>) ──────────────────────────────────────────

const permCache = new Map<number, Set<string>>();

export function invalidatePermCache(roleId?: number): void {
  if (roleId !== undefined) permCache.delete(roleId);
  else permCache.clear();
}

export async function getPermissionsForRole(roleId: number): Promise<Set<string>> {
  if (permCache.has(roleId)) return permCache.get(roleId)!;

  const rows = await db
    .select({ key: permissionsTable.key })
    .from(rolePermissionsTable)
    .innerJoin(permissionsTable, eq(rolePermissionsTable.permissionId, permissionsTable.id))
    .where(eq(rolePermissionsTable.roleId, roleId));

  const keys = new Set(rows.map(r => r.key));
  permCache.set(roleId, keys);
  return keys;
}

// ─── 시드: 최초 1회 실행 ─────────────────────────────────────────────────────

export async function seedRbac(): Promise<void> {
  try {
    // 권한 upsert — 없으면 추가, 있으면 표시 이름·분류만 현행화(키·역할 연결 불변)
    const newlyAdded: string[] = [];
    for (const p of ALL_PERMISSIONS) {
      const exists = await db
        .select({ id: permissionsTable.id, name: permissionsTable.name, category: permissionsTable.category })
        .from(permissionsTable)
        .where(eq(permissionsTable.key, p.key))
        .limit(1);

      if (exists.length === 0) {
        await db.insert(permissionsTable).values({ key: p.key, name: p.name, category: p.category });
        newlyAdded.push(p.key);
      } else if (exists[0].name !== p.name || exists[0].category !== p.category) {
        await db.update(permissionsTable).set({ name: p.name, category: p.category }).where(eq(permissionsTable.id, exists[0].id));
      }
    }

    // 전체 권한 key→id 매핑
    const allPerms = await db.select({ id: permissionsTable.id, key: permissionsTable.key }).from(permissionsTable);
    const keyToId = new Map(allPerms.map(p => [p.key, p.id]));

    // 신규 권한 최초 1회 부여 — grantFrom 키를 가진 역할(사용자 정의 역할 포함)에 같은 접근 범위를 이어준다.
    //   '*' = 모든 역할(기존에 권한 없이 노출되던 메뉴). 이미 등록된 권한은 다시 부여하지 않는다(관리자가 해제한 권한 보존).
    if (newlyAdded.length) {
      const allRolePerms = await db.select({ roleId: rolePermissionsTable.roleId, key: permissionsTable.key })
        .from(rolePermissionsTable).innerJoin(permissionsTable, eq(rolePermissionsTable.permissionId, permissionsTable.id));
      const roleKeys = new Map<number, Set<string>>();
      for (const rp of allRolePerms) { const s2 = roleKeys.get(rp.roleId) ?? new Set<string>(); s2.add(rp.key); roleKeys.set(rp.roleId, s2); }
      const allRoles = await db.select({ id: rolesTable.id }).from(rolesTable);
      const grants: { roleId: number; permissionId: number }[] = [];
      for (const key of newlyAdded) {
        const src = PERM_META.get(key)?.grantFrom; const pid = keyToId.get(key);
        if (!src?.length || pid == null) continue;
        for (const r of allRoles) {
          const has = roleKeys.get(r.id) ?? new Set<string>();
          if (src.includes("*") || src.some(k => has.has(k))) grants.push({ roleId: r.id, permissionId: pid });
        }
      }
      if (grants.length) await db.insert(rolePermissionsTable).values(grants).onConflictDoNothing();
      console.log(`[RBAC] 신규 권한 ${newlyAdded.length}개 등록 · 기존 역할에 ${grants.length}건 부여(동일 접근 범위)`);
      invalidatePermCache();
    }

    // 역할 upsert
    for (const r of DEFAULT_ROLES) {
      const existing = await db
        .select({ id: rolesTable.id })
        .from(rolesTable)
        .where(eq(rolesTable.name, r.name))
        .limit(1);

      let roleId: number;
      if (existing.length === 0) {
        const [inserted] = await db.insert(rolesTable).values({
          name: r.name,
          description: r.description,
          isSystem: r.isSystem,
        }).returning({ id: rolesTable.id });
        roleId = inserted.id;
      } else {
        roleId = existing[0].id;
      }

      // role_permissions upsert (없는 것만 추가)
      const existingRp = await db
        .select({ permissionId: rolePermissionsTable.permissionId })
        .from(rolePermissionsTable)
        .where(eq(rolePermissionsTable.roleId, roleId));
      const existingPermIds = new Set(existingRp.map(rp => rp.permissionId));

      const toInsert = r.permissions
        .map(key => keyToId.get(key))
        .filter((id): id is number => id !== undefined && !existingPermIds.has(id));

      if (toInsert.length > 0) {
        await db.insert(rolePermissionsTable).values(
          toInsert.map(permissionId => ({ roleId, permissionId }))
        );
      }
    }
  } catch (err) {
    console.error("[RBAC] seed failed:", err);
  }
}
