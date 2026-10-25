# Orderflow — Order Management App

Web application for managing customer orders with **Customer Service** and **Finance** roles.

| Part | Where it runs | Cost |
|---|---|---|
| The app (this code) | [Render](https://render.com), free web service | free |
| The database | [Turso](https://turso.tech), hosted SQLite | free (5 GB, no card) |

**Nextcloud is not used.** Your existing data is moved in once, by uploading your local `Order_App.db` on the app's first-time setup page.

---

## Go live (one time, about 15 minutes)

### 1. Create the database on Turso
1. Go to <https://turso.tech> and sign up. Signing in with GitHub works.
2. **Create a database** named `orderflow`. Pick the location closest to Europe (Frankfurt if offered).
3. On the database's page:
   - copy its **URL**, which starts with `libsql://`
   - **create a token** with read & write access and no expiry, and copy it.

### 2. Find your newest `Order_App.db`
The old app refreshed its local `Order_App.db` every time it ran, so the newest copy is normally in the old app's folder on the PC that ran it last. Check the file's **Date modified**, and close the old app before you take the copy.

### 3. Put this folder on GitHub
Upload the folder's contents to your repository, including the `public` folder. `node_modules`, `.env` and `*.db` are deliberately excluded. **Never put `Order_App.db` in the repository**, because it contains customer data.

### 4. Deploy on Render
1. Sign in at <https://dashboard.render.com> with GitHub.
2. Click **New → Blueprint** and pick the repository. Render reads `render.yaml` and asks for:

   | Setting | What to enter |
   |---|---|
   | `TURSO_DATABASE_URL` | the `libsql://…` URL from step 1 |
   | `TURSO_AUTH_TOKEN` | the token from step 1 |
   | `CS_PASSWORD` | a **new** password for the `cs` login (8+ characters) |
   | `FINANCE_PASSWORD` | a **new** password for the `finance` login (8+ characters). It is also the **setup key** in step 5 |

3. Click **Apply**. The first build takes about 2–3 minutes.

### 5. Upload your data (first visit only)
1. Open the app address shown at the top of the Render page, e.g. `https://orderflow.onrender.com`.
2. Because the new database is empty, the app shows the **Upload your data** page. Choose your `Order_App.db`, enter the setup key (your `FINANCE_PASSWORD`) and click **Import data**.
3. The app copies every table and row, checks them, and shows the row counts. Click **Go to sign in**.

The upload page only works while the database is completely empty, so once your data is in, it can't be used again.

*(Alternatives, if ever needed: set `IMPORT_DB_FILE` to a file on the server, or `NC_HOST` / `NC_TOKEN` / `NC_PASSWORD` to copy from a Nextcloud share. Both are used only while the database is empty.)*

---

## Everyday notes

**Backups.** Click the **database icon** at the bottom of the sidebar to download a full copy as `Order_App_backup_<date>.db`. It's the same kind of file as before and opens in [DB Browser for SQLite](https://sqlitebrowser.org/). Turso also keeps 1 day of point-in-time restore on the free plan. To restore a backup, create a new empty Turso database, point `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` at it, and upload the backup on the setup page.

**Passwords.** On the hosted app, the factory passwords (`cs123`, `fin123`) never work. On first start, any account still using one is switched to `CS_PASSWORD` / `FINANCE_PASSWORD`. Passwords users have changed in the app (lock icon) are left alone.

**Emails (Notify Finance / Send Release Mail).** A website can't control Outlook on your PC by itself, so there are two ways:
- **Outlook button (recommended).** Set it up once on each PC by clicking **Outlook: off** next to the email button and following the 3 steps. No admin rights are needed. After that, clicking the email button opens a **new Outlook email** with To, CC, subject, text and the Excel already attached. Nothing is saved to Downloads. Review it and click **Send**. The first time, the browser asks to open *Windows PowerShell*: tick **Always allow** and click **Open**. This needs classic Outlook for Windows.
- **Without the Outlook button,** the app downloads an `.eml` draft instead. Open it and Outlook shows the same ready-to-send email.

How the Outlook button works: setup saves a small script to `%LOCALAPPDATA%\Orderflow` and registers the `orderflow-mail:` link type for your Windows user only. When you click the email button, the browser hands that link to the script. The script fetches that one email from the app (the link expires after 15 minutes) and creates it in Outlook, the same way the original local app did. The script only accepts links from your own app address. To remove it, delete `%LOCALAPPDATA%\Orderflow` and the registry key `HKEY_CURRENT_USER\Software\Classes\orderflow-mail`.

**Free-plan sleep.** The app sleeps after 15 minutes with no visitors, and the next visit takes about a minute to wake it. To keep it awake, create a free monitor at <https://cron-job.org> or <https://uptimerobot.com> that opens `https://YOUR-APP.onrender.com/healthz` every 10 minutes. 750 free hours a month covers one service running 24/7.

**Free-plan limits (Turso).** 5 GB of storage, 500 million row reads and 10 million row writes a month. This app uses a tiny fraction of that.

---

## Run locally (optional)

Requires **Node.js 18+**.

1. Copy `.env.example` to `.env` and fill in `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. This uses the same live database as the hosted app.
   For a fully offline copy, use `TURSO_DATABASE_URL=file:Order_App.db` with a backup file instead.
2. Run `npm install` and then `node server.js`, or on Windows double-click **`start.bat`**.
3. Open `http://localhost:3000`.

When run locally on Windows, the email buttons still try to open Outlook directly.

---

## How it works

### Customer Service flow
1. **Import Orders.** Upload an Excel file. Duplicate `Number`s are skipped.
2. **Notify Finance.** Builds an email draft to Finance, with the customers' Sales Reps in CC and the new orders attached as Excel.

### Finance flow
1. **Import Balance.** Upload the `Code, Total Debt` Excel, which must include a `Summary` sheet. The sign is flipped on import (negative debt becomes positive credit), and each upload replaces the previous balances.
2. **Review & Release.** Release is allowed only if the remaining balance is at least the order amount. The customer's other pending orders are updated automatically.
3. **Undo Release.** Allowed until the release mail is sent.
4. **Send Release Mail.** Builds an email draft to Customer Service, with Sales Reps in CC and the released orders attached.
5. **Exception.** Mark an order as an exception, with a remark, instead of releasing it.

### Data access (technical)
- Reads are direct queries against Turso (libSQL, the SQLite dialect), so the SQL is unchanged from the old app.
- Each write runs in **one database transaction**: it fully commits or fully rolls back. Writes are queued one at a time, and bulk operations (imports, mail flags) are sent in batches.
- First start: if the database is empty, the app shows a setup page where the existing `Order_App.db` is uploaded (protected by the setup key). Every table, row and index is copied in a single transaction, then verified. A failed upload saves nothing.
- Browsers poll `/api/version` every 10 s and refresh when another user changes data.

---

## File structure

```
├─ server.js          ← Express app + Turso (libSQL) data layer
├─ render.yaml        ← Render deployment blueprint
├─ .env.example       ← settings template (copy to .env for local runs)
├─ package.json
├─ start.bat          ← Windows launcher (local)
├─ outlook-helper/    ← "Outlook button" helper (setup file + script for each PC)
└─ public/
   ├─ index.html      ← login page
   ├─ setup.html      ← first-time data upload page
   ├─ app.html        ← main app shell
   ├─ app.js          ← frontend logic
   ├─ styles.css      ← dark + light theme
   └─ theme.js        ← theme toggle
```

## Database schema

| Table | Purpose |
|-------|---------|
| `Users` | Login accounts (bcrypt hashes, role, email) |
| `Customers` | Code, EN/AR name, Sales Rep, Sales Rep email |
| `Customer_Balance` | Latest imported balance per customer |
| `Orders` | Master order table with full lifecycle flags |
| `Email_Recipients` | Who receives the inter-team emails |
| `Balance_Upload_Log` | Duplicate-upload protection for balance files |
| `Audit_Log` | Every action with user, timestamp, and details |

You can also browse and edit the live data in the Turso dashboard.
