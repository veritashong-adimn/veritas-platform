# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   └── api-server/         # Express API server
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts (single workspace package)
│   └── src/                # Individual .ts scripts, run via `pnpm --filter @workspace/scripts run <script>`
├── pnpm-workspace.yaml     # pnpm workspace (artifacts/*, lib/*, lib/integrations/*, scripts)
├── tsconfig.base.json      # Shared TS options (composite, bundler resolution, es2022)
├── tsconfig.json           # Root TS project references
└── package.json            # Root package with hoisted devDeps
```

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references. This means:

- **Always typecheck from the root** — run `pnpm run typecheck` (which runs `tsc --build --emitDeclarationOnly`). This builds the full dependency graph so that cross-package imports resolve correctly. Running `tsc` inside a single package will fail if its dependencies haven't been built yet.
- **`emitDeclarationOnly`** — we only emit `.d.ts` files during typecheck; actual JS bundling is handled by esbuild/tsx/vite...etc, not `tsc`.
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array. `tsc --build` uses this to determine build order and skip up-to-date packages.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages that define it
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Domain

통번역 플랫폼 MVP

## Authentication

- **방식**: JWT Bearer token (7일 만료)
- **비밀번호**: bcryptjs (saltRound=10) 해싱
- **미들웨어**: `artifacts/api-server/src/middlewares/auth.ts`
  - `requireAuth` — Authorization: Bearer 헤더 검증 후 req.user 주입
  - `requireRole(...roles)` — 역할 기반 접근 제어
- **인증 필요 API**: POST /projects, POST /quotes, POST /projects/:id/match, PATCH /tasks/:id/start, PATCH /tasks/:id/complete
- **역할 제한**: customer → 프로젝트 생성, translator → task 작업만
- **프론트엔드**: 로그인/회원가입 폼, JWT를 localStorage에 저장, 로그아웃 지원

## DB Schema

- `users` — id, email, **password** (nullable, bcrypt hashed), role (customer/translator/admin), **is_active** (boolean default true), created_at
- `projects` — id, user_id, title, file_url (nullable), status (created/quoted/approved/**paid**/matched/in_progress/completed/**cancelled**), created_at
- `quotes` — id, project_id, price (numeric), status (pending/sent/approved/rejected), created_at
- `tasks` — id, project_id, translator_id (FK→users), status (waiting/assigned/working/done), created_at
- `payments` — id, project_id (FK), amount (numeric 12,2), status (pending/paid/failed), created_at
- `settlements` — id, project_id, translator_id, total_amount, translator_amount (70%), platform_fee (30%), status (pending/ready/paid), created_at
- `notes` — id, project_id (FK), admin_id (FK→users), content, created_at (관리자 메모)
- `logs` — id, entity_type (project/quote/task), entity_id, action, created_at

## Log Events

| 이벤트 | action 값 |
|--------|-----------|
| 프로젝트 생성 | project_created |
| 견적 생성 | quote_created |
| 견적 승인 | quote_approved |
| 매칭 실행 | project_matched |
| 작업 시작 | task_started |
| 작업 완료 | task_completed |

## API Endpoints

### Auth (공개)
- `POST /api/auth/register` — 회원가입 (email, password, role) → {token, user}
- `POST /api/auth/login` — 로그인 (email, password) → {token, user}

### Users
- `POST /api/users` — 사용자 생성 (레거시, 비밀번호 없음)
- `GET /api/users/:id` — 사용자 조회

### Projects (🔒 = 인증 필요)
- `POST /api/projects` 🔒 (customer only) — 프로젝트 생성 (userId는 JWT에서 자동, fileUrl optional)
- `GET /api/projects` — 프로젝트 목록 (?userId=N 필터)
- `POST /api/projects/:id/match` 🔒 (customer/admin) — 번역가 랜덤 매칭 (**paid 상태에서만 가능**)

### Settlements (🔒 = 인증 필요)
- `GET /api/admin/settlements` 🔒 (admin) — 전체 정산 목록 (번역사 이메일, 프로젝트 제목 포함)
- `PATCH /api/admin/settlements/:id/pay` 🔒 (admin) — 정산 완료 처리 (ready → paid)
- `GET /api/settlements/my` 🔒 (translator) — 내 정산 내역 (프로젝트 제목 포함)

### 고객·커뮤니케이션
- `GET /api/admin/customers` 🔒 — 고객 목록 (?search, 프로젝트 수·결제 합계 포함)
- `POST /api/admin/customers` 🔒 — 고객 등록 (companyName, contactName, email, phone)
- `GET /api/admin/customers/:id` 🔒 — 고객 상세 (projects 목록, totalPayment, totalSettlement)
- `PATCH /api/admin/customers/:id` 🔒 — 고객 정보 수정
- `POST /api/admin/communications` 🔒 — 커뮤니케이션 기록 추가 (customerId, projectId?, type, content)
- `GET /api/admin/customers/:id/communications` 🔒 — 고객별 커뮤니케이션 목록
- `GET /api/admin/projects/:id/communications` 🔒 — 프로젝트별 커뮤니케이션 목록

### Admin (🔒 admin role 전용)
- `GET /api/admin/projects` 🔒 — 전체 프로젝트 + 고객 이메일 (최신순, ?search, ?status, ?dateFrom, ?dateTo 필터)
- `GET /api/admin/projects/:id` 🔒 — 프로젝트 상세 (견적/결제/작업/정산/로그 포함)
- `PATCH /api/admin/projects/:id/status` 🔒 — 프로젝트 상태 수동 변경
- `POST /api/admin/projects/:id/rematch` 🔒 — 번역사 재매칭 (기존 task 삭제 후 재배정)
- `PATCH /api/admin/projects/:id/cancel` 🔒 — 프로젝트 취소 (→ cancelled)
- `GET /api/admin/projects/:id/notes` 🔒 — 관리자 메모 목록
- `POST /api/admin/projects/:id/notes` 🔒 — 관리자 메모 추가
- `GET /api/admin/payments` 🔒 — 전체 결제 + 프로젝트 제목
- `GET /api/admin/tasks` 🔒 — 전체 작업 + 번역사 이메일
- `GET /api/admin/logs/:projectId` 🔒 — 프로젝트 이벤트 로그
- `GET /api/admin/users` 🔒 — 사용자 목록 (?search, ?role 필터)
- `PATCH /api/admin/users/:id/role` 🔒 — 사용자 역할 변경 (customer/translator만, admin 변경 불가)
- `PATCH /api/admin/users/:id/deactivate` 🔒 — 계정 활성화/비활성화 토글 (본인 불가, admin 불가)
- `PATCH /api/admin/update-email` 🔒 — 본인 이메일 변경 (이메일 형식 검증, 중복 불가, 본인만 변경 가능)
- Login: 비활성화(is_active=false)된 계정은 403으로 차단됨

### Payments (🔒 = 인증 필요)
- `POST /api/payments/request` 🔒 — 결제 요청 생성 (approved 상태 프로젝트, 견적 금액 기준)
- `POST /api/payments/confirm` 🔒 — 결제 확인 ({paymentId, success: bool}) → paid/failed
- `GET /api/payments` — 결제 목록 (?projectId=N)

### Upload (🔒 = 인증 필요)
- `POST /api/upload` 🔒 — 파일 업로드 → R2 저장 → fileUrl 반환 (10MB, PDF/DOCX/TXT/이미지/ZIP)

### Quotes
- `POST /api/quotes` 🔒 — 견적 생성 (project status → quoted)
- `POST /api/quotes/:id/approve` — 견적 승인 (project status → approved)

### Tasks
- `GET /api/tasks` — 작업 목록 (?translatorId=N, 프로젝트 정보 JOIN)
- `PATCH /api/tasks/:id/start` 🔒 (translator) — 작업 시작 (→ working, project → in_progress)
- `PATCH /api/tasks/:id/complete` 🔒 (translator) — 작업 완료 (→ done, project → completed)

### Logs & Health
- `GET /api/logs` — 전체 로그 (?entityType=project|quote|task, ?entityId=N)
- `GET /api/healthz` — 헬스체크

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server. Routes live in `src/routes/` and use `@workspace/api-zod` for request and response validation and `@workspace/db` for persistence.

- Entry: `src/index.ts` — reads `PORT`, starts Express
- App setup: `src/app.ts` — mounts CORS, JSON/urlencoded parsing, routes at `/api`
- Routes: `src/routes/index.ts` mounts sub-routers; `src/routes/health.ts` exposes `GET /health` (full path: `/api/health`)
- Depends on: `@workspace/db`, `@workspace/api-zod`
- `pnpm --filter @workspace/api-server run dev` — run the dev server
- `pnpm --filter @workspace/api-server run build` — production esbuild bundle (`dist/index.cjs`)
- Build bundles an allowlist of deps (express, cors, pg, drizzle-orm, zod, etc.) and externalizes the rest

### `lib/db` (`@workspace/db`)

Database layer using Drizzle ORM with PostgreSQL. Exports a Drizzle client instance and schema models.

- `src/index.ts` — creates a `Pool` + Drizzle instance, exports schema
- `src/schema/index.ts` — barrel re-export of all models
- `src/schema/<modelname>.ts` — table definitions with `drizzle-zod` insert schemas (no models definitions exist right now)
- `drizzle.config.ts` — Drizzle Kit config (requires `DATABASE_URL`, automatically provided by Replit)
- Exports: `.` (pool, db, schema), `./schema` (schema only)

Production migrations are handled by Replit when publishing. In development, we just use `pnpm --filter @workspace/db run push`, and we fallback to `pnpm --filter @workspace/db run push-force`.

### `lib/api-spec` (`@workspace/api-spec`)

Owns the OpenAPI 3.1 spec (`openapi.yaml`) and the Orval config (`orval.config.ts`). Running codegen produces output into two sibling packages:

1. `lib/api-client-react/src/generated/` — React Query hooks + fetch client
2. `lib/api-zod/src/generated/` — Zod schemas

Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `lib/api-zod` (`@workspace/api-zod`)

Generated Zod schemas from the OpenAPI spec (e.g. `HealthCheckResponse`). Used by `api-server` for response validation.

### `lib/api-client-react` (`@workspace/api-client-react`)

Generated React Query hooks and fetch client from the OpenAPI spec (e.g. `useHealthCheck`, `healthCheck`).

### `scripts` (`@workspace/scripts`)

Utility scripts package. Each script is a `.ts` file in `src/` with a corresponding npm script in `package.json`. Run scripts via `pnpm --filter @workspace/scripts run <script>`. Scripts can import any workspace package (e.g., `@workspace/db`) by adding it as a dependency in `scripts/package.json`.
