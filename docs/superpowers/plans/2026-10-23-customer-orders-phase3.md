# 51mai Phase 3 Customer and Order Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace static customer/order data with authenticated MySQL-backed customer summaries, customer-owned order lists/details, and the confirmed read-only admin customer list.

**Architecture:** Keep the existing React UI and Phase 2 session model. Add a second migration for customer profiles and order snapshots, a business API router protected by the existing SessionManager guards, and frontend API clients/hooks that render only server-returned data. No payment, commission, fulfillment secrets, or synthetic historical orders are introduced.

**Tech Stack:** React 19, TypeScript, Express 5, mysql2, MySQL 8.4, Vitest.

**Spec:** docs/51mai分站功能1比1任务清单.md; docs/功能矩阵-2026-10-23.md

## Global Constraints
- Reference-site functionality is the business source of truth; do not invent hidden/plugin features.
- Keep the current 51mai page structure/UI.
- No production deploy, push, payment integration, supplier purchase, card delivery, commission settlement, or production data migration.
- Customer order access must be scoped by authenticated user_id; admin customer data requires admin role.
- Monetary snapshots are integer cents.
- Empty database means a real empty state, not demo rows.

## Review Focus
- Customer cannot read another user's order by guessing an ID.
- Customer cannot access admin customer listing.
- Frozen customer sessions cease authorizing requests via existing session guard.
- Order totals come from stored snapshot cents, never recalculated from current catalog prices.
- Search/status filters use bounded validated inputs and parameterized SQL.

### Task 1: Schema
**Files:** Create server/db/migrations/002_customer-orders.sql; extend migration integration tests.
- [x] RED: test migration creates user_profiles, orders, order_items and FK/index constraints.
- [x] GREEN: add migration using integer cents and explicit status enums.
- [x] Verify against real 51mai_test.

### Task 2: Business API
**Files:** Create server/business/routes.ts, server/business/service.ts, server/business/routes.test.ts; modify server/main.ts.
**Interfaces:** GET /api/account/summary; GET /api/orders?status=&q=; GET /api/orders/:id; GET /api/admin/customers?tier=&q=; no unverified customer mutation endpoint in this phase.
- [x] RED: customer isolation, empty lists, owned order detail, admin-only customer-list tests and cross-user isolation.
- [x] GREEN: parameterized SQL service + guarded routers.
- [x] Verify real MySQL backend suite.

### Task 3: Frontend integration
**Files:** Modify src/auth/client.ts, src/pages/OrdersPage.tsx, src/pages/OrderDetailPage.tsx, src/pages/UserCenterPages.tsx, src/admin/AdminPages.tsx and focused tests.
- [x] RED: pages load API data, show loading/error/empty, and never render old fake rows.
- [x] GREEN: replace static rows with server data while preserving current UI structure.
- [x] Verify frontend suite, typecheck and build.

### Task 4: Handoff
- [x] Update docs/功能矩阵-2026-10-23.md and runtime progress/report.
- [x] Run frontend full suite, real MySQL backend full suite, typecheck, build, hygiene check.
- [x] No commit/push/deploy.
