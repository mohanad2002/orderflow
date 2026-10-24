# Orderflow — Changelog

Build version is shown in the top-left of the app (next to "Order Management"). It also prints on the server console at startup. If the on-screen version doesn't match this list, you're running an older copy — restart the server after fully extracting the latest zip.

---

## v3.0.0  (Database moved off Nextcloud → Turso)
- **New database:** data now lives in a hosted SQLite database on [Turso](https://turso.tech) (free plan). Nextcloud is no longer used.
- **One-time automatic data copy:** on the first start with an empty Turso database, the server downloads the old `Order_App.db` from Nextcloud (or `IMPORT_DB_FILE`) and copies every table, row and index in a single transaction, then verifies the row counts. It never runs again once the database has data.
- **Safer writes:** every write is one database transaction (all-or-nothing). Bulk operations (order/customer/balance imports, mail flags, deletes) are sent in batches.
- **Database backup button** (sidebar, database icon): downloads a complete `Order_App_backup_<date>.db` that opens in DB Browser for SQLite and can be re-imported with `IMPORT_DB_FILE`.
- Sidebar status shows "Database · N ms" (was "Nextcloud").
- While the server is still starting (first-time import, migrations), data APIs answer "starting up" instead of touching a half-ready database.
- Settings: `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` replace the Nextcloud settings. `NC_HOST` / `NC_TOKEN` / `NC_PASSWORD` are now only for the one-time copy. `TURSO_DATABASE_URL=file:…` runs fully offline on a local file.
- Dependencies: added `@libsql/client`. `sql.js` is kept only for the import/backup file format.

## v2.11.0  (Cloud hosting on Render)
- App can now be hosted on the internet (Render free plan) — see README → "Deploy to Render". `render.yaml` blueprint included.
- **No secrets in code.** Nextcloud host/token/password now come from environment variables (`.env` locally, Render settings online).
- **Factory passwords disabled online.** `cs123` / `fin123` never sign in on the hosted app; on first start they are replaced by `CS_PASSWORD` / `FINANCE_PASSWORD`. Default-credential hint removed from the login page. Minimum password length is now 8.
- **Logins survive restarts.** Sessions are stored in a signed cookie (was server memory), so the free instance sleeping no longer logs everyone out.
- **No more lost writes.** Database writes are queued one at a time; two users saving at the same moment could previously overwrite each other.
- **Email drafts on the cloud:** Notify Finance / Send Release Mail auto-download an `.eml` draft that opens in Outlook (server-side Outlook automation still used when run locally on Windows). Draft files now require login to download and are cleaned up after 24 h.
- Login rate-limiting (10 failed attempts per 15 min per IP), basic security headers, 25 MB upload limit, `/healthz` endpoint.
- Startup retries the Nextcloud connection every 30 s instead of giving up.
- Dependencies: `express-session` + `cors` replaced by `cookie-session`; `multer` upgraded to 2.x; Express security patches applied.

## v2.10.1  (Release mail attachment structure)
- Finance "Send Release Mail" attachment now matches the reference `Mail_List_Sqry` structure exactly.
- Sheet name changed from `Released Orders` to `Mail_List_Sqry`.
- Columns: `Number`, `Code`, `Customer`, `Amount`, `Release Date`, `Release` (TRUE/FALSE), `Exception` (TRUE/FALSE), `Exception_Remark`, `Remaining_Balance`.
- Release Date formatted as a plain date string (no time component).

## v2.10.0  (Performance: in-memory DB cache)
- Added an in-memory cache for the SQLite database file, eliminating the bottleneck of downloading from Nextcloud on every API call.
- **Before:** every read = 1 full Nextcloud GET (~300ms). With 2 users and 10s polling, that was 12+ downloads/minute doing nothing.
- **After:** cache is reused within a 3-second TTL. After TTL expires, a lightweight HEAD request (~50ms) checks the ETag. Only if ETag changed does the server do a full download.
- Writes always upload to Nextcloud and immediately update the in-memory cache — User B sees User A's changes on the next read without any re-download.
- `/api/version` (polled every 10s) never touches the DB — returns the in-memory counter directly.
- Cold start (server restart) still does a full download on the first request to seed the cache.

## v2.9.0  (Balance import: aggregate duplicates + clean-slate replace)
- The raw balance Excel file may now contain **multiple rows per customer code**. The app aggregates (sums) them by `Code` before storing.
- Every successful balance import now **wipes `Customer_Balance` clean** and inserts one row per unique customer.
- The duplicate-Summary-sheet check is unchanged — last upload's Summary is still preserved in `Balance_Upload_Log` for comparison.
- Sign flip behavior is unchanged: negative debt in file → positive credit in app.
- **Pending orders for customers missing from the new file** now have `Uploaded_Balance = 0` and `Remaining_Balance = 0` — release will be blocked until that customer reappears in a future balance upload.
- Result card updated: shows rows read, unique customers, rows skipped, plus the Summary sheet values.

## v2.8.0  (CS bulk-delete on All Orders)
- New **checkboxes** in the All Orders page (CS only — hidden from Finance).
- Master checkbox in the header to select/deselect all visible orders.
- **Delete Selected** button in the toolbar with a live count of selected items.
- CS can delete **any** order on this page, including released ones.
- Confirmation dialog shows the count and warns when released orders are included.
- Deleting a released order does **not** return its amount to the customer's Remaining Balance (per spec).
- All deletions logged to Audit_Log as `CS_DELETE_ORDERS_FORCE` when released orders are removed.

## v2.7.0  (Month filter)
- New **Month dropdown** in the toolbar of Dashboard, Finance Review & Release, and All Orders pages.
- Options: All months, January (1) through December (12). Each labeled with the current year (e.g. "June 2026").
- Default selection: the current month. Selection is persisted in localStorage.
- Filters by `OrderDate` (the Date column from the import file), restricted to the current year.
- Dashboard stats and Finance customer dropdown all update with the active filter.

## v2.6.0  (Bug fix: release rejected when balance was sufficient)
- Release check now uses the **stored `Remaining_Balance`** on the order row as the single source of truth.
- Eliminates the stale calculation (`Uploaded − sum(all-time released)`) that conflicted with the fresh balance import's clean-slate reset.
- Undo release now keeps all pending orders of the same customer in sync (consistent shared pool value).
- Added `APP_VERSION` exposed via `/api/me`, `/api/app-info`, and printed in the console banner.
- Visible version badge in sidebar & login page.

## v2.5.0  (Balance upload improvements)
- **Duplicate-upload protection** — uses the `Summary` sheet (Cust_Count + Total Balance) to detect identical re-uploads and hard-rejects them.
- **Remaining = Uploaded after balance import** — fresh balance upload is a clean slate; all prior release deductions on pending orders are reset.
- **Column order swapped** — `Remaining Balance` now appears before `Uploaded Balance` in the Finance Review & Release table.
- New `Balance_Upload_Log` table auto-created on first startup.

## v2.4.0  (Theme switch)
- Replaced the icon-button theme toggle with a proper sliding switch (sun ⇄ moon) on both the login page and sidebar.

## v2.3.0  (Recipients & progress + CC scoping)
- New **Email Recipients** page (CS only) — manages who receives the inter-team emails. Add / edit / delete / toggle-active per email.
- **Notify Finance** and **Send Release Mail** now read recipients from this table instead of the Users.Email field.
- **CC scoping** — Send Release Mail CC contains only sales reps of the customers whose orders are *actually* in the released batch.
- **Progress bar** (indeterminate sweeping animation) on all Excel imports.

## v2.2.0  (Quality of life)
- **Direct Outlook integration** via PowerShell + Outlook COM — opens a real draft window instead of downloading `.eml`. Three-method fallback chain (COM1 → COM2 → `.eml` open) for resilience.
- **Connection status indicator** in sidebar — shows Connected / Disconnected with latency, auto-polls every 20s.
- **Live auto-refresh** between users — every 10s, browsers check for changes and refresh visible page silently with a friendly toast.
- **Pre-seeded users** in shipped `Order_App.db` (cs/cs123, finance/fin123) so login works immediately after first Nextcloud upload.

## v2.1.0  (Bulk delete + filters)
- CS can bulk-delete orders via checkboxes (only those not yet released by Finance).
- CS sees only pending orders (released ones disappear automatically).
- Finance customer dropdown filter — only customers with pending orders.
- Auto-hide released-and-mailed orders by default; "Show Mailed & Released" toggle to reveal.

## v2.0.0  (Migration: Access → SQLite + Nextcloud)
- Switched from MS Access (`.accdb` + PowerShell + OLEDB) to **SQLite via `sql.js`** with the file stored on **Nextcloud** (WebDAV).
- Cross-platform: any OS with Node.js works.
- Modern dark + light theme.
- Full business logic: Customer Service & Finance roles, order/balance imports with sign flip, release/undo/exception, Outlook email drafts with sales rep CC, audit log.
