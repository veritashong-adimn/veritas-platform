# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Translation and interpretation platform (통번역 플랫폼) — connects customers with translators via project management, quoting, task assignment, payments, and settlements. Built as a pnpm monorepo.

## Commands

```bash
# Install dependencies
pnpm install

# Typecheck everything (libs + artifacts)
pnpm run typecheck

# Build everything
pnpm run build

# API server — build then start
cd artifacts/api-server && pnpm run build && pnpm run start
# API server — dev mode (build + start)
cd artifacts/api-server && pnpm run dev

# Frontend — dev server
cd artifacts/web-app && pnpm run dev

# DB schema push (run from repo root or lib/db/)
cd lib/db && pnpm run push
cd lib/db && pnpm run push-force   # skip interactive confirm

# Seed database with test data
cd artifacts/api-server && pnpm run seed

# Regenerate API client & Zod schemas from openapi.yaml
cd lib/api-spec && pnpm run codegen
```

No test framework is configured; there are no test scripts.

## Monorepo Structure

```
artifacts/
  api-server/     Express v5 backend (Node 24, TypeScript, esbuild)
  web-app/        React 19 frontend (Vite, Tailwind v4, shadcn/ui)
lib/
  db/             Drizzle ORM schema + PostgreSQL pool (shared by api-server)
  api-spec/       openapi.yaml (single source of truth) + Orval config
  api-client-react/   Generated React Query hooks (from Orval)
  api-zod/        Generated Zod request/response validators (from Orval)
  integrations-openai-ai-server/  OpenAI server-side utilities
  integrations-openai-ai-react/   OpenAI client-side utilities
scripts/          Utility scripts
```

## Architecture

### API-First Codegen Flow

`lib/api-spec/openapi.yaml` is the **single source of truth**. Orval generates two outputs:
- `lib/api-client-react/src/generated/` — React Query hooks used in the frontend
- `lib/api-zod/src/generated/` — Zod schemas used for server-side request validation

After changing `openapi.yaml`, run `cd lib/api-spec && pnpm run codegen` to regenerate both.

### Backend (`artifacts/api-server`)

- **Framework**: Express v5 with `pino`/`pino-http` logging
- **Database**: PostgreSQL via Drizzle ORM (`@workspace/db`)
- **Validation**: Zod schemas from `@workspace/api-zod`
- **Build**: esbuild bundles to `dist/index.mjs`; source maps enabled at runtime
- **Production**: The compiled API server also serves the frontend's static build from `../../web-app/dist/public`

Route files live in `src/routes/` (one file per domain) and are registered in `src/routes/index.ts`. Shared utilities are in `src/lib/` and `src/services/`.

### Authentication & RBAC

- JWT (7-day expiry) issued at login, stored in `localStorage` on the client
- `requireAuth` middleware verifies `Authorization: Bearer <token>` or `?token=` query param
- Roles: `admin | staff | client | linguist | customer | translator`
- Fine-grained RBAC via `requirePermission(key)` middleware. Permission keys are defined in `src/lib/rbac.ts` (e.g. `project.create`, `settlement.pay`, `translator.sensitive`)
- `admin` with no `roleId` bypasses permission checks (super-admin shortcut)
- Permission cache lives in-process (`permCache` Map); call `invalidatePermCache()` on role changes

### Frontend (`artifacts/web-app`)

- **Routing**: `window.location.pathname` matching in `App.tsx` (no router for top-level pages). Public pages (`/insights`, `/insights/:slug`, `/set-password`) skip auth checks.
- **State**: Auth state (token, user, permissions) is stored in `localStorage` and loaded on mount. Permissions are re-fetched from the server on every load.
- **Data fetching**: TanStack Query v5; generated React Query hooks from `@workspace/api-client-react`
- **UI components**: shadcn/ui (Radix primitives + Tailwind). Custom/admin components use **inline styles**, not Tailwind classes.
- **Role-based rendering**: `admin`/`staff` → `AdminDashboard`; `customer`/`client` → `CustomerDashboard`; `translator` → `TranslatorDashboard`

### Database Schema (`lib/db/src/schema/`)

Key domain tables: `users`, `projects`, `quotes`, `quote_items`, `tasks`, `payments`, `settlements`, `billing_batches`, `prepaid_accounts`, `prepaid_ledger`, `companies`, `divisions`, `contacts`, `translators`, `translator_sensitive`, `products`, `product_options`, `translation_units`, `content_insights`, `language_service_data`, `roles`, `permissions`, `role_permissions`, `logs`.

Schema changes are applied via `drizzle-kit push` (no migration files; push-based workflow).

### Settlement Automation

When a task transitions to `done`, the API auto-generates a settlement record with:
- Payout due date (1–15th of month → end of month; 16–31st → 15th of next month, KST)
- Settlement type from `translator_sensitive.paymentMethod` → `WITHHOLDING_3_3 | VAT_INVOICE | OVERSEAS_REMITTANCE | OTHER_REVIEW`
- Tax calculation (3.3% withholding or VAT)
- Auto-status: `ready` for domestic 3.3% with bank info; `pending_review` otherwise

### Product Catalog

Products have 4 types (`translation | interpretation | equipment | expense`) with auto-generated codes (language-pair types: `TR-KO-EN-LAW-001`; non-language: `EQ-FM-001`). Categories and units are defined per type in `artifacts/web-app/src/lib/constants.ts`.

### AEO/GEO Content Insights

`content_insights` table stores AI-enhanced SEO content. Status flow: `draft → review_ready → publish_ready → published`. Auto-enhancement via OpenAI; auto-publish when quality thresholds met (aeoScore ≥ 80, faqCount ≥ 3, relatedCount ≥ 2). Published insights are exposed without auth at `/api/public/insights`.

## Code Weight Rules

Alert the user **before** adding a new tab or section when a file approaches these limits:
- Frontend components/pages: warn at **1,000 lines**
- API route files: warn at **1,500 lines**
- `AdminDashboard.tsx` is currently ~3,550 lines; alert before reaching **4,000 lines**

Priority refactor candidates (not yet split):
1. `SettlementTab` → `SettlementManagementTab.tsx` (~700 lines)
2. `BillingTab` → `BillingManagementTab.tsx` (~640 lines)
3. `SettingsTab` → `SettingsTab.tsx` (~440 lines)
4. `StaffTab` → `StaffManagementTab.tsx` (~360 lines)

## Development Principles

- All bash commands and tool calls are auto-approved — proceed without asking for confirmation
- Ask before making major changes
- Explore only relevant files before editing; fix build/HMR errors first
- On test or script failure: attempt one fix, then stop and report cause + plan if it fails again
- Add `data-testid` and `aria-label` to every interactive element from the start

# Veritas Platform Operating Principles

## Core Philosophy
This is not a simple translation app.
This platform is a long-term AI-based global B2B operating platform including:
- CRM
- Settlement
- HR
- SEO/AEO/GEO
- AI data assets
- BI
- Global sales automation

## Critical Rules
1. Never change DB schema without approval
2. Never break existing API response shapes
3. Always analyze before modifying
4. Always explain modification plan first
5. Wait for approval before major changes
6. Minimize impact and preserve workflows
7. Never expose secrets or env values
8. Always run build/test after modification
9. Prefer minimal safe changes over large refactors

## Product Philosophy
- Product = actual sellable service
- Direction = internal processing only
- DisplayName = human-readable natural language

Do not expose Direction directly as Product names.

## Workflow Philosophy
Current workflows are operationally sensitive.
Be conservative when modifying:
- settlement
- status flow
- CRM relations
- SEO URL structure
- financial logic

## 금액자료 공통 정렬·그룹화 원칙 (2026-11-28)
판매·수행·정산·지급·통번역사별 금액자료(화면 목록과 Excel·CSV·PDF 등 생성 파일)는 자료 목적에 맞게 아래 순서를 적용한다.
1. 납품일 오름차순 (납품일 없음 = 맨 뒤)
2. 같은 납품일 안: 거래처명 가나다순 (법인 형태 표기 `(주)`·`㈜`·`주식회사` 등과 공백은 비교에서 무시)
3. 같은 거래처 안: 판매번호순
4. 같은 판매번호 안: 통번역사·외주업체명 가나다순
5. 같은 수행자 안: 수행정보 등록순 (과거 CRM 원본 → 플랫폼 수행정보, 각 등록 id 순)

- 같은 거래처·판매건·수행자의 내역은 흩어지지 않고 연속 표시한다. 이름이 같아도 식별값(판매 id·수행자 키)으로 묶음을 구분한다.
- 통역료·번역료·연장근무비·출장비·장비비 등 같은 수행자의 관련 비용은 함께 표시된다(위 3~5순위).
- 과거 CRM과 플랫폼 자료는 합친 뒤 최종 정렬한다(출처별 블록으로 나누어 붙이지 않는다).
- 같은 자료의 화면·Excel·CSV·PDF 출력 순서는 같아야 한다. 정렬된 한 배열을 화면과 출력이 함께 쓴다.
- 구현: `artifacts/web-app/src/lib/payoutItemOrder.ts` (`sortByPayoutOrder`·`comparePayoutOrder`)를 재사용한다. 새 정렬 함수를 따로 만들지 않는다.
- 정렬은 순서만 바꾼다. 건수·금액·합계·지급상태·검색·필터는 바꾸지 않는다. 그룹 제목·소계 행 등 표시 요소는 별도 승인 없이 추가하지 않는다.
- 현재 적용 범위: 지급회차 상세의 건별 상세내역(화면·Excel), 지급대상별 지급명세서 Excel·PDF, 지급확정·은행이체 탭의 건별 상세내역(화면·Excel). 다른 메뉴의 기존 정렬은 승인 후 순차 적용한다.

## 수행자 ↔ 지급대상 연결 원칙 (2026-11-28)
- 수행자·지급대상 일치는 이름보다 식별정보를 우선한다: 주민번호(수행정보 스냅샷 ↔ 통번역사 명부) · 사업자번호(외주업체) · 명부 id(Master 통합 포함). 단순 이름 차이(개명·영문명·법인명 표기·정상 대리 지급)만으로 오류 처리하지 않는다(참고 표시만).
- 식별정보가 서로 다른 확정 불일치는 지급준비점검에 표시하고(`identity_mismatch`), 지급확정·IBK 은행이체 파일 생성을 서버에서 차단한다(409 `PAYEE_IDENTITY_MISMATCH`). 공용 판정: `artifacts/api-server/src/services/payeeIdentity.ts`.
- 주민번호 전체는 화면·응답·로그에 넣지 않는다(서버 메모리 비교만, 표시는 이름·명부 id·사유).
- 수행자 연결 변경은 반드시 앱 저장 로직(판매관리 수행정보 저장 `PUT /admin/projects/:id/performances` 또는 수행자 선택)으로만 한다 — 이름·주민번호 스냅샷과 감사로그가 함께 갱신된다. DB 직접 수정·일괄 스크립트로 `individual_user_id`/`vendor_company_id` 만 바꾸지 않는다.
- 플랫폼에서 담당자가 정정한 수행자 연결을 과거 CRM 원본(이름·주민번호)을 근거로 덮어쓰지 않는다. 과거 CRM 원본은 참고 자료이며 플랫폼 수행정보가 기준이다.
- 이름만으로 동명이인을 자동 연결하지 않는다. 같은 이름의 다른 명부가 있으면 원본 주민번호가 한 명과 정확히 일치할 때만 연결하고, 아니면 미연결로 두어 담당자가 지정한다(CRM 판매 전환 `loadTranslatorIndex` 동명이인 보호).

## Preferred Working Style
1. Analyze
2. Explain
3. Get approval
4. Modify
5. Build/test
6. Report changes
