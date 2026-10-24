# Orderflow — Order Management App

Web application for managing customer orders with **Customer Service** and **Finance** roles.

- **Hosting:** runs on [Render](https://render.com)'s free plan, reachable from anywhere over HTTPS.
- **Data:** a single SQLite file (`Order_App.db`) on the Nextcloud share, read and written with the pure-JavaScript `sql.js` engine. The cloud server keeps no data of its own. That matters because Render's free disk is wiped on every restart.

---

## Deploy to Render (one time, ~10 minutes)

1. **Put this folder in a private GitHub repository.** Upload the folder's contents. `node_modules`, `.env` and `*.db` are deliberately excluded.
2. **Sign in to Render** with your GitHub account: <https://dashboard.render.com>.
3. Click **New → Blueprint** and pick the repository. Render reads `render.yaml` and asks for these values:

   | Setting | What to enter |
   |---|---|
   | `NC_HOST` | Nextcloud host, e.g. `nestle.thegood.cloud` |
   | `NC_TOKEN` | the public-share token |
   | `NC_PASSWORD` | the public-share password |
   | `CS_PASSWORD` | a **new** password for the `cs` login (8+ characters) |
   | `FINANCE_PASSWORD` | a **new** password for the `finance` login (8+ characters) |

4. Click **Apply**. The first build takes about 2–3 minutes. Your app's address is shown at the top of the service page, e.g. `https://orderflow.onrender.com`.
5. Open the address and sign in with `cs` or `finance` and the new password you set.

After this, every push to the repository redeploys automatically.

### About the default passwords
On the hosted app, the factory passwords (`cs123`, `fin123`) **never work**. On first start, any account still using one is switched to `CS_PASSWORD` / `FINANCE_PASSWORD`. Passwords that users have already changed in the app (lock icon in the sidebar) are left alone.

### Free-plan behaviour
- The app **sleeps after 15 minutes with no visitors**. The next visit takes about a minute to wake it, and Render shows a loading page meanwhile. Your data is safe, because it lives on Nextcloud.
- To keep it awake during working hours, create a free monitor at <https://cron-job.org> or <https://uptimerobot.com> that opens `https://YOUR-APP.onrender.com/healthz` every 10 minutes. The free plan gives 750 hours a month, enough for one service running 24/7. If you add other free Render services, they share those hours.
- People stay signed in across restarts for up to 8 hours.

---

## Emails (Notify Finance / Send Release Mail)

A cloud server can't open Outlook on your PC. So on the hosted app, the button **downloads an `.eml` draft**. Open it, and Outlook (classic) shows it as a new message with To, CC, subject, body and the Excel attachment already filled in. Review it and click **Send**.

When run locally on Windows (see below), the app still tries to open Outlook directly first.

---

## Run locally (optional)

Requires **Node.js 18+**.

1. Copy `.env.example` to `.env` and fill in the Nextcloud values.
2. Run:
   ```bash
   npm install
   node server.js
   ```
   Or on Windows, double-click **`start.bat`**.
3. Open `http://localhost:3000`.

> Once the hosted app is live, **stop running local servers** and have everyone use the hosted address. Writes are queued safely within one server, but two servers saving to the same Nextcloud file at the same moment can still overwrite each other.

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
- Reads use an in-memory copy of the DB. Every 3 seconds at most, a cheap `HEAD` request checks Nextcloud's ETag, and the file is downloaded again only if it changed.
- Writes are **queued one at a time**, applied to the in-memory copy, then uploaded to Nextcloud with `PUT`.
- Browsers poll `/api/version` every 10 s and refresh when another user changes data.

---

## File structure

```
├─ server.js          ← Express + sql.js + Nextcloud sync
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

You can inspect the live database by downloading `Order_App.db` from Nextcloud and opening it in [DB Browser for SQLite](https://sqlitebrowser.org/).
