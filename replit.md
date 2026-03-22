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

- `users` — id, email, **password** (nullable, bcrypt hashed), role (customer/translator/admin), created_at
- `projects` — id, user_id, title, status (created/quoted/approved/matched/in_progress/completed), created_at
- `quotes` — id, project_id, price (numeric), status (pending/sent/approved/rejected), created_at
- `tasks` — id, project_id, translator_id (FK→users), status (waiting/assigned/working/done), created_at
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
- `POST /api/projects` 🔒 (customer only) — 프로젝트 생성 (userId는 JWT에서 자동)
- `GET /api/projects` — 프로젝트 목록 (?userId=N 필터)
- `POST /api/projects/:id/match` 🔒 (customer/admin) — 번역가 랜덤 매칭 + task 생성

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
