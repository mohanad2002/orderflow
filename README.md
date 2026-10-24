# Orderflow — Order Management App

Web application for managing customer orders with **Customer Service** and **Finance** roles.

| Part | Where it runs | Cost |
|---|---|---|
| The app (this code) | [Render](https://render.com), free web service | free |
| The database | [Turso](https://turso.tech), hosted SQLite | free (5 GB, no card) |

**Nextcloud is no longer used.** It is read only once, on the very first start, to copy your existing data into Turso.

---

## Go live (one time, about 15 minutes)

### 1. Create the database on Turso
1. Go to <https://turso.tech> and sign up. Signing in with GitHub works.
2. **Create a database** named `orderflow`. Pick the location closest to Europe (Frankfurt if offered).
3. On the database's page:
   - copy its **URL**, which starts with `libsql://`
   - **create a token** with read & write access and no expiry, and copy it.

### 2. Stop the old app
Close every running copy of the old local app (`start.bat` / `node server.js`). Otherwise someone could change Nextcloud data after it has been copied.

### 3. Put this folder on GitHub
Upload the folder's contents to your repository, including the `public` folder. `node_modules`, `.env` and `*.db` are deliberately excluded.

### 4. Deploy on Render
1. Sign in at <https://dashboard.render.com> with GitHub.
2. Click **New → Blueprint** and pick the repository. Render reads `render.yaml` and asks for:

   | Setting | What to enter |
   |---|---|
   | `TURSO_DATABASE_URL` | the `libsql://…` URL from step 1 |
   | `TURSO_AUTH_TOKEN` | the token from step 1 |
   | `CS_PASSWORD` | a **new** password for the `cs` login (8+ characters) |
   | `FINANCE_PASSWORD` | a **new** password for the `finance` login (8+ characters) |
   | `NC_HOST` | `nestle.thegood.cloud`, for the one-time data copy |
   | `NC_TOKEN` / `NC_PASSWORD` | the old Nextcloud share token and password, for the one-time data copy |

3. Click **Apply**. The first build takes about 2–3 minutes.
4. In the service's **Logs**, look for:
   ```
   Import complete and verified:
      Users                2 row(s)
      Orders               … row(s)
      ...
   Ready.
   ```
5. Open the app address shown at the top, e.g. `https://orderflow.onrender.com`, and sign in with `cs` or `finance` and the new password.

### 5. Cut the cord to Nextcloud
In Render → your service → **Environment**, **delete `NC_HOST`, `NC_TOKEN` and `NC_PASSWORD`**. The import never runs again once the database has data, but there's no reason to keep them. From now on, Nextcloud plays no part. Keep the old `Order_App.db` file somewhere safe as an archive.

---

## Everyday notes

**Backups.** Click the **database icon** at the bottom of the sidebar to download a full copy as `Order_App_backup_<date>.db`. It's the same kind of file as before and opens in [DB Browser for SQLite](https://sqlitebrowser.org/). Turso also keeps 1 day of point-in-time restore on the free plan.

**Passwords.** On the hosted app, the factory passwords (`cs123`, `fin123`) never work. On first start, any account still using one is switched to `CS_PASSWORD` / `FINANCE_PASSWORD`. Passwords users have changed in the app (lock icon) are left alone.

**Emails.** A cloud server can't open Outlook on your PC. **Notify Finance** and **Send Release Mail** therefore download an `.eml` draft; open it and Outlook (classic) shows the message with To, CC, subject, body and Excel attachment ready. Review it and click **Send**.

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
- First start: if the database is empty, the server copies every table, row and index from the Nextcloud file (or `IMPORT_DB_FILE`) in a single transaction, then verifies the row counts.
- Browsers poll `/api/version` every 10 s and refresh when another user changes data.

---

## File structure

```
├─ server.js          ← Express app + Turso (libSQL) data layer
├─ render.yaml        ← Render deployment blueprint
├─ .env.example       ← settings template (copy to .env for local runs)
├─ package.json
├─ start.bat          ← Windows launcher (local)
└─ public/
   ├─ index.html      ← login page
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
