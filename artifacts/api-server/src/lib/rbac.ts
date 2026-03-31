import { db, rolesTable, permissionsTable, rolePermissionsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ─── 권한 정의 ───────────────────────────────────────────────────────────────

export const ALL_PERMISSIONS: Array<{ key: string; name: string; category: "menu" | "action" }> = [
  // 메뉴 권한
  { key: "menu.dashboard",  name: "대시보드",      category: "menu" },
  { key: "menu.project",    name: "프로젝트/작업",  category: "menu" },
  { key: "menu.payment",    name: "결제",           category: "menu" },
  { key: "menu.settlement", name: "정산/청구/선입금", category: "menu" },
  { key: "menu.company",    name: "거래처",         category: "menu" },
  { key: "menu.contact",    name: "담당자",         category: "menu" },
  { key: "menu.customer",   name: "고객관리",       category: "menu" },
  { key: "menu.translator", name: "통번역사",       category: "menu" },
  { key: "menu.product",    name: "상품/단가",      category: "menu" },
  { key: "menu.user",       name: "사용자관리",     category: "menu" },
  { key: "menu.board",      name: "게시판",         category: "menu" },
  { key: "menu.permission", name: "역할/권한관리",  category: "menu" },

  // 기능 권한 - 프로젝트
  { key: "project.view",    name: "프로젝트 조회",  category: "action" },
  { key: "project.create",  name: "프로젝트 생성",  category: "action" },
  { key: "project.update",  name: "프로젝트 수정",  category: "action" },
  { key: "project.delete",  name: "프로젝트 삭제",  category: "action" },

  // 기능 권한 - 견적
  { key: "quote.view",      name: "견적 조회",      category: "action" },
  { key: "quote.create",    name: "견적 생성",      category: "action" },
  { key: "quote.update",    name: "견적 수정",      category: "action" },
  { key: "quote.approve",   name: "견적 승인",      category: "action" },

  // 기능 권한 - 정산
  { key: "settlement.view", name: "정산 조회",      category: "action" },
  { key: "settlement.pay",  name: "정산 지급",      category: "action" },

  // 기능 권한 - 결제
  { key: "payment.view",    name: "결제 조회",      category: "action" },
  { key: "payment.create",  name: "결제 등록",      category: "action" },
  { key: "payment.update",  name: "결제 수정",      category: "action" },

  // 기능 권한 - 거래처
  { key: "company.view",    name: "거래처 조회",    category: "action" },
  { key: "company.create",  name: "거래처 생성",    category: "action" },
  { key: "company.update",  name: "거래처 수정",    category: "action" },

  // 기능 권한 - 담당자
  { key: "contact.view",    name: "담당자 조회",    category: "action" },
  { key: "contact.create",  name: "담당자 생성",    category: "action" },
  { key: "contact.update",  name: "담당자 수정",    category: "action" },

  // 기능 권한 - 작업
  { key: "task.view",       name: "작업 조회",      category: "action" },
  { key: "task.create",     name: "작업 생성",      category: "action" },
  { key: "task.update",     name: "작업 수정",      category: "action" },

  // 기능 권한 - 청구/선입금
  { key: "billing.view",    name: "청구 조회",      category: "action" },
  { key: "prepaid.manage",  name: "선입금 관리",    category: "action" },

  // 기능 권한 - 사용자
  { key: "user.manage",     name: "사용자 관리",    category: "action" },
];

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
    ],
  },
  {
    name: "finance",
    description: "정산/결제 관리 (프로젝트 수정 제한)",
    isSystem: true,
    permissions: [
      "menu.dashboard", "menu.project", "menu.payment", "menu.settlement", "menu.company",
      "project.view",
      "quote.view",
      "settlement.view", "settlement.pay",
      "payment.view", "payment.create", "payment.update",
      "company.view",
      "billing.view", "prepaid.manage",
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
    // 권한 upsert
    for (const p of ALL_PERMISSIONS) {
      const exists = await db
        .select({ id: permissionsTable.id })
        .from(permissionsTable)
        .where(eq(permissionsTable.key, p.key))
        .limit(1);

      if (exists.length === 0) {
        await db.insert(permissionsTable).values(p);
      }
    }

    // 전체 권한 key→id 매핑
    const allPerms = await db.select({ id: permissionsTable.id, key: permissionsTable.key }).from(permissionsTable);
    const keyToId = new Map(allPerms.map(p => [p.key, p.id]));

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
