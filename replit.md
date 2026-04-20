# Overview

This project is a pnpm workspace monorepo using TypeScript, designed as an MVP for a translation and interpretation platform. The platform aims to connect customers needing translation services with qualified translators, facilitating project management, quoting, task assignment, payments, and settlements.

Key capabilities include:
- User authentication and authorization with JWT.
- Project creation and management for customers with a visual status stepper.
- Quote generation and approval workflow, featuring a new item-based structure for all quote types.
- Translator matching and task assignment.
- Payment processing and settlement management for translators.
- Admin CRM dashboard with enhanced project search, a new prepaid account ledger system, and an accumulated billing tab.
- Comprehensive management of translator settlement and payment information, including sensitive data with robust security.
- Separation of translation and interpretation product structures with automatic code generation (`[SVC]-[LANG]-[CAT]-NNN`), dropdown-based form, duplicate warning, deactivation reason modal, and multi-filter search (serviceType/languagePair/category/active).
- Support for divisions within large client companies: divisions table (company_id FK, name, type), project-level requesting/billing/payer separation, full CRUD API, and stats display in company detail modal.
- **AEO/GEO 자동 보완 시스템**: `insight_auto_suggestions` 테이블 (insightId/type/payload/status). AI(GPT)가 부족한 AEO 필드(FAQ 3개 미만, 관련 연결 없음, aeoTitle/Description 누락) 자동 탐지 → 제안 생성(POST /auto-enhance 단건 / batch). 어드민이 "자동 보완 제안" 패널에서 Apply/Reject. 적용 시 insight 필드에 즉시 반영 및 AEO 점수 재계산. 유사도 기반 관련 인사이트 자동 매칭(단어 overlap). 배치 처리(최대 20건).
- A new data layer for translation data assetization (`translation_units`), enabling advanced search, anonymization, and history tracking.
- `language_service_data` + `content_insights` tables: 통합 언어 서비스 데이터 구조 (번역/통역/장비 서비스 레퍼런스 데이터 + AEO/GEO 콘텐츠 인사이트 생성 기반). 서비스 유형별 동적 필드, CRUD API, 인사이트 Q&A 등록/삭제 지원.
- **공개 인사이트 페이지**: `published` + `public_insight` 상태의 인사이트를 `/insights` (목록) 및 `/insights/:slug` (상세)로 공개 노출. FAQ JSON-LD schema, SEO 메타 태그(title, description, og:) 자동 삽입. PATCH status → published 전환 시 slug 자동 생성. 공개 API: `GET /api/public/insights`, `GET /api/public/insights/:slug` (인증 불필요). 로그인 없이 접근 가능한 공개 페이지.
- Detailed project, company, contact, translator, and product management modals.
- File management (upload/download/delete) for project documents using GCS presigned URLs.
- Translator self-service for profile and rate management.
- Comprehensive logging of key events.

The business vision is to streamline the process of translation and interpretation services, offering a robust platform for efficient project delivery and fair compensation for translators, while providing detailed administrative oversight.

# User Preferences

I prefer detailed explanations and iterative development. Ask before making major changes. Do not make changes to files outside the `artifacts/api-server/src` directory.

## 코드 무게 관리 규칙 (Code Weight Management)

파일이 무거워지기 전에 먼저 알리고 분리 여부를 확인한다.

- **프론트엔드 컴포넌트/페이지**: 1,000줄 초과 → 분리 신호. 새 탭/기능 추가 전 먼저 보고
- **API 라우트 파일**: 1,500줄 초과 → 도메인별 분리 검토
- **AdminDashboard.tsx 현황**: 현재 ~3,550줄. 4,000줄 초과 또는 새 탭 추가 전 먼저 알림
- **분리 완료**: `DataLayerTab.tsx` (387줄) — 번역 데이터 탭 분리 완료

**분리 대상 (우선순위 순)**:
1. `SettlementTab` → `SettlementManagementTab.tsx` (~700줄 분리 가능)
2. `BillingTab` → `BillingManagementTab.tsx` (~640줄 분리 가능)
3. `SettingsTab` → `SettingsTab.tsx` (~440줄 분리 가능)
4. `StaffTab` → `StaffManagementTab.tsx` (~360줄 분리 가능)

# System Architecture

The project is structured as a pnpm monorepo, organizing code into `artifacts` (deployable applications) and `lib` (shared libraries).

**Technology Stack:**
- **Monorepo:** pnpm workspaces
- **Node.js:** v24
- **TypeScript:** v5.9
- **API Framework:** Express v5
- **Database:** PostgreSQL with Drizzle ORM
- **Validation:** Zod (v4) and `drizzle-zod`
- **API Codegen:** Orval (from OpenAPI spec)
- **Build Tool:** esbuild

**Core Architectural Decisions:**
- **Monorepo Structure:** Facilitates code sharing and consistent tooling.
- **TypeScript Composite Projects:** Leverages TypeScript's composite project features for efficient type-checking.
- **API-First Development:** Uses an OpenAPI 3.1 specification (`openapi.yaml`) as the single source of truth, with Orval generating client-side React Query hooks and server-side Zod schemas.
- **Authentication:** JWT Bearer token authentication with bcryptjs for password hashing. Role-based access control is enforced via Express middleware.
- **Database Schema:** A normalized PostgreSQL schema manages all platform entities. Key entities include `users`, `projects`, `quotes`, `quote_items`, `tasks`, `payments`, `settlements`, `billing_batches`, `billing_batch_items`, `prepaid_accounts`, `prepaid_ledger`, `translation_units`, and `translation_unit_logs`.
- **API Endpoints:** A comprehensive set of RESTful API endpoints are designed to manage all platform functionalities, categorized by domain.
- **Error Handling & Logging:** Key events are logged using a dedicated `logs` table.
- **Admin Features:** Extensive admin panels for managing various entities, including data export.
- **State Transition Rules:** Explicit allowed transition maps enforced on both backend and frontend, with admin override capability.
- **Seed Data:** Provides seed data for comprehensive testing.
- **Project List UX:** Features pagination, quick action buttons, and filter pills.
- **Event Log Timeline:** Displays event logs in a chronologically sorted vertical timeline with Korean action labels, icons, and color coding.
- **PDF Document Output:** Generates PDF versions of quotes and statements, supporting authentication via `?token=` query parameter for downloads. Documents include dynamic platform and bank information based on environment variables.
- **Frontend Structure:** Refactored into modular components and pages for better maintainability, including shared UI components, project-specific components, and admin modals. AdminDashboard.tsx is broken into dedicated sub-components: `ProductManagementTab.tsx` (상품 관리), `ProjectManagementTab.tsx` (프로젝트 탭 — 필터, 페이지네이션, 생성 모달 포함, 독립 fetch 로직), `CompanyDetailModal.tsx`, `ProjectDetailModal.tsx` 등.
- **UI/UX Decisions:** JWTs managed in localStorage. Clear separation of concerns between customer, translator, and admin roles. Forms for all data entry. Uses inline styles instead of Tailwind.

# External Dependencies

- **PostgreSQL:** Primary database.
- **Drizzle ORM:** ORM for PostgreSQL.
- **Express:** API server framework.
- **Zod:** Schema validation library.
- **bcryptjs:** Password hashing library.
- **Orval:** OpenAPI client code generator.
- **AWS S3 (or compatible, e.g., Cloudflare R2):** For file storage.