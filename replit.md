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
- A new data layer for translation data assetization (`translation_units`), enabling advanced search, anonymization, and history tracking.
- Detailed project, company, contact, translator, and product management modals.
- File management (upload/download/delete) for project documents using GCS presigned URLs.
- Translator self-service for profile and rate management.
- Comprehensive logging of key events.

The business vision is to streamline the process of translation and interpretation services, offering a robust platform for efficient project delivery and fair compensation for translators, while providing detailed administrative oversight.

# User Preferences

I prefer detailed explanations and iterative development. Ask before making major changes. Do not make changes to files outside the `artifacts/api-server/src` directory.

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
- **Frontend Structure:** Refactored into modular components and pages for better maintainability, including shared UI components, project-specific components, and admin modals.
- **UI/UX Decisions:** JWTs managed in localStorage. Clear separation of concerns between customer, translator, and admin roles. Forms for all data entry. Uses inline styles instead of Tailwind.

# External Dependencies

- **PostgreSQL:** Primary database.
- **Drizzle ORM:** ORM for PostgreSQL.
- **Express:** API server framework.
- **Zod:** Schema validation library.
- **bcryptjs:** Password hashing library.
- **Orval:** OpenAPI client code generator.
- **AWS S3 (or compatible, e.g., Cloudflare R2):** For file storage.