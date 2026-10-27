# 51mai Frontend Implementation Plan

**Goal:** Build the 51mai responsive storefront and management UI from the 19 approved SVG prototypes, starting with the frontend foundation and F01 homepage.

**Architecture:** React + TypeScript + Vite static frontend. Until Hostinger/backend/payment/upstream capabilities are verified, all business data uses local typed fixtures and no real transaction or supplier connector is included.

**Spec:** `原型图/README.md`, `原型图/01-设计规范.md`, `项目总览.md`

## Global Constraints
- Mobile-first: 320–767px; tablet 768–1199px; desktop >=1200px.
- Follow the blue/white prototype design system.
- Do not connect real payments, supplier APIs, credentials, card keys, or customer data.
- Do not deploy or modify Hostinger/Cloudflare.

## Tasks
1. Foundation + F01 homepage: tests first, app shell, header, hero search, categories, product cards, trust strip, mobile navigation, build verification.
2. F02–F03 catalog/search and product detail.
3. F04–F06 cart, login/register, simulated checkout/payment UI.
4. F07–F09 orders, delivery UI, help center.
5. A01–A10 admin shell and ten admin pages with fixture data.
6. Whole-site responsive QA against all 19 SVG prototypes and final test/build/typecheck gates.
