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

## Preferred Working Style
1. Analyze
2. Explain
3. Get approval
4. Modify
5. Build/test
6. Report changes
