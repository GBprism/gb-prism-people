# Deploying GB Prism on Google Cloud (small VM)

Why a VM rather than Cloud Run: Prism keeps its data in one SQLite file. Cloud Run's disk is wiped on every restart, but a VM's persistent disk keeps the data. For ~15 users an `e2-small` is enough (about US$15–20 a month including disk and static IP).

Time needed: about 45 minutes. You need to be able to edit the DNS of gb-advisory.com.

## 1. Billing and project
1. https://console.cloud.google.com → select the **GB Prism** project.
2. Menu ☰ → **Billing**. Link a billing account if asked.

## 2. Reserve an address
1. ☰ → **VPC network → IP addresses** → **Reserve external static IP address**.
2. Name `gb-prism-ip`, Network Service Tier **Premium**, IP version **IPv4**, Type **Regional**. For Region choose **me-central1 (Doha)**, the closest to Amman, unless GB prefers an EU region for data-protection reasons. → **Reserve**.
3. Note the IP address.

## 3. Create the VM
1. ☰ → **Compute Engine → VM instances** → **Create instance**. Enable the API if asked.
2. Name `gb-prism`. Region: the **same** region as the IP.
3. Machine type **e2-small**.
4. Boot disk → **Change** → **Debian 12**, **Balanced persistent disk**, **20 GB** → Select.
5. Networking:
   - Tick **Allow HTTP traffic** and **Allow HTTPS traffic**.
   - Under **Network interfaces** → **default** → External IPv4 address: choose `gb-prism-ip`.
6. Data protection: tick **Back up your data** / snapshot schedule (daily) if offered.
7. **Create**.

## 4. Point the web address at it
In the place that manages gb-advisory.com's DNS, add a record:
- Type **A**, Host/Name **prism**, Value **the IP from step 2**, TTL 1 hour.

To find who manages the DNS: Google Admin console → **Account → Domains → Manage domains** shows where it is hosted. It may also be your website or domain provider (GoDaddy, Namecheap, Cloudflare, Squarespace…).

## 5. Backup bucket (recommended)
1. ☰ → **Cloud Storage → Buckets → Create**. Name it `gb-prism-backups-<something unique>`, same region, **Standard**, **Prevent public access** on.
2. Open the bucket → **Protection** → add a **retention** or lifecycle rule (for example, delete objects older than 365 days).
3. ☰ → **IAM**. Find the VM's service account (`…-compute@developer.gserviceaccount.com`) and give it **Storage Object Creator** on this bucket.

## 6. Install Prism on the VM
1. Compute Engine → VM instances → **SSH** next to `gb-prism` (opens a terminal in the browser).
2. Give the VM read-only access to the private GitHub repo:
   ```bash
   ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -C gb-prism-vm
   cat ~/.ssh/id_ed25519.pub
   ```
   Copy the printed line. Then on GitHub go to **GBprism/gb-prism-people → Settings → Deploy keys → Add deploy key**: title `gb-prism-vm`, paste the line, leave **Allow write access unticked**, and click **Add key**.
3. Get the code and run the installer (replace the bucket name):
   ```bash
   sudo apt-get update && sudo apt-get install -y git
   ```
   ```bash
   git clone git@github.com:GBprism/gb-prism-people.git ~/gb-prism-people
   ```
   Type `yes` when asked to trust github.com.
   ```bash
   sudo bash ~/gb-prism-people/deploy/vm-setup.sh prism.gb-advisory.com gs://gb-prism-backups-XXXX
   ```
4. Put the Google sign-in client in the server settings. Never put it in chat or in GitHub:
   ```bash
   sudo nano /etc/gb-prism/env
   ```
   Replace `PASTE_CLIENT_ID_HERE` and `PASTE_CLIENT_SECRET_HERE` with the values from the JSON you downloaded. Save with **Ctrl+O, Enter**, then exit with **Ctrl+X**.
   ```bash
   sudo systemctl restart gb-prism caddy
   ```
5. Check it works by opening https://people.gb-advisory.com/healthz in your browser. It should say `{"ok":true}`. The HTTPS certificate is issued automatically once DNS (step 4) has updated, which can take up to an hour.

## 7. Load GB's private setup files
1. In the SSH window, click **Upload file** (the ⬆ icon at the top right) and upload `gb-prism-private-config.zip`. You receive this zip privately; it is never stored in GitHub.
2. Unpack it into the app's private folder and load the workspace:
   ```bash
   sudo apt-get install -y unzip && sudo unzip -o ~/gb-prism-private-config.zip -d /opt/gb-prism/config/private && sudo chown -R gbprism:gbprism /opt/gb-prism/config/private
   ```
   ```bash
   sudo bash /opt/gb-prism/deploy/run.sh scripts/setup-gb.js --roster config/private/roster.csv --decisions config/private/gb-decisions.json
   ```
3. Sign in at https://people.gb-advisory.com with your @gb-advisory.com Google account.
4. Go to **Admin → Import center**:
   - Upload the seven 2026 evaluation forms (**GB 2026 evaluation forms**, select all at once) → **Preview** → **Apply**.
   - Upload the LeaveBoard exports one at a time → **Preview** → **Apply**.
5. Apply the reviewer matrix:
   ```bash
   sudo bash /opt/gb-prism/deploy/run.sh scripts/assign-reviewers.js --matrix config/private/reviewers.csv --cycle cyc_gb-advisory_2026
   ```

## Updating later
```bash
cd ~/gb-prism-people && bash deploy/update.sh
```
This pulls the latest code from GitHub and restarts the app. Data, settings and private files are kept.

## Where things live on the server
| What | Where |
|---|---|
| App code | `/opt/gb-prism` |
| Database | `/var/lib/gb-prism/prism-people.db` (nightly backup to your bucket at 01:15 UTC) |
| Secrets and settings | `/etc/gb-prism/env` (readable only by root and the app) |
| GB private config | `/opt/gb-prism/config/private` |
| Logs | `sudo journalctl -u gb-prism -n 100` |

## Loading GB's real data (one command)

All real data lives in a private folder that is never committed: roster, decisions, 2026 forms, the 2025 PMS tab, LeaveBoard exports, the reviewer workbook and `hr-evidence.json` (facts checked against email). Upload the private bundle `gb-real-data.zip` to the server, then:

```bash
sudo mkdir -p /opt/gb-prism/config/private/real && sudo unzip -o ~/gb-real-data.zip -d /opt/gb-prism/config/private/real && sudo chown -R gbprism /opt/gb-prism/config/private && rm ~/gb-real-data.zip
```

```bash
cd /opt/gb-prism && sudo -u gbprism node --no-warnings scripts/load-gb-all.js --dir config/private/real --db /var/lib/gb-prism/prism-people.db --dry-run
```

Read the report, then run it again without `--dry-run`. Add `--cutover yyyy-mm-dd` only once GB has set the LeaveBoard cutover date; this posts opening balances. Re-running is safe. Restart afterwards with `sudo systemctl restart gb-prism`.

## Library and strategy KPIs

`library.json` in the private bundle holds every client, engagement (English and Arabic scope, years, status, lead, team, Drive folder), proposal outcome, and the 2026–2028 strategy objectives and KPIs. `load-gb-all.js` loads it after the projects so engagements link to the projects register (confirmed team members then appear automatically). Re-running never overwrites an engagement or proposal a partner has edited in the portal.

Everyone signed in can read the Library. Partners and People Ops change status, Drive links, scope and proposal outcomes there. No fees, contract values or client contacts are stored. Each person links their objectives to up to three strategy KPIs from their review page; colleagues see how many people support each KPI, partners and People Ops also see who.

## Timesheets, expenses, letters, checklists, policies, onboarding, CVs

The private bundle also carries `title-renames.json` (job-title decisions, e.g. Business Analyst (Grade 1) → Consultant), `onboarding-letters.json`, `checklists.json`, `policies-brand-expenses.json`, `brand/` (logo files) and `cv-template/media/` (the icons and logo used on CV slides). `load-gb-all.js` loads them all; re-running is safe.

- **Expenses** follow GB's claim form. Every line needs its receipt or invoice (PDF, JPEG, PNG or WebP, up to 5 MB, stored in the database). Claims go to the leave approver unless an `expense_approver` setting is set; the approver's own claims go to another partner. People Ops marks approved claims paid.
- **Timesheets** draft each month from assignments: 8 hours per working day, minus public holidays and approved leave. People correct and submit; partners and People Ops approve and see man-hours per project.
- **Letters**: People Ops prints from the template on letterhead (browser print / save as PDF). Pay fields are typed at print time and never saved.
- **CV slides** are generated as .pptx in GB's layout (`/api/cv/<id>` or `/api/cv/all`). Set `CV_ASSET_DIR` only if the icons live somewhere other than `config/private/real/cv-template/media`.

## Email notifications (requests, approvals, messages)

The portal emails whoever must act: a project manager or the final approver for time off, the approver for an expense claim, People Ops and the leave approver for letters, profile changes, timesheets and gym registrations, members of a conversation for new messages (at most one email per conversation per hour), and the office administrators for expiring documents. People can switch these emails off in My profile. Emails carry a one-line summary and a link — never balances, pay or ratings.

To send them, add SMTP settings to the server settings file (never to GitHub or chat):
```bash
sudo nano /etc/gb-prism/env
```
Add these lines (Google Workspace example: a mailbox such as notifications@gb-advisory.com with 2-Step Verification on and an **app password** created at myaccount.google.com → Security → App passwords):
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=notifications@gb-advisory.com
SMTP_PASS=the-16-letter-app-password
MAIL_FROM=GB People <notifications@gb-advisory.com>
```
Then `sudo systemctl restart gb-prism`. Until SMTP is set, emails wait in the outbox (Admin → Reminders) and nothing is lost.

## CVs in Google Slides

“Open in Google Slides” creates the CV as a Google Slides file in the person’s own Drive. It uses the same Google sign-in client, asking each person once for access to files the portal creates (drive.file — it cannot see anything else). One-time setup in Google Cloud (same project as the sign-in client): **APIs & Services → Library → Google Drive API → Enable**, then **OAuth consent screen → Data access → Add or remove scopes** → tick `.../auth/drive.file` → Save. No new redirect address is needed.

## Office expenses and company documents

`office.json` names who keeps them (GB decision: Abdullah Abu-Alhija). It is applied only while nobody has been chosen in the portal; after that, partners change it on the Office expenses page. Office administrators, People Ops and partners see both pages; nobody else does. Documents expiring within 60 days, or expired, appear in their inbox. Receipts and scans are stored in the database (PDF or photo).

## Leave approver and LeaveBoard cutover (GB decisions)

```bash
cd /opt/gb-prism && sudo -u gbprism node --no-warnings scripts/set-leave-rules.js --db /var/lib/gb-prism/prism-people.db --approver layan@gb-advisory.com --cutover 2026-11-24
```

Until opening balances are posted, Time off tells people to keep using LeaveBoard. At close of business on the cutover day, export a fresh LeaveBoard **Annual situation** report (and the **Leaves** report for bookings after the cutover). Upload them in Admin → Imports, apply, then **Post opening balances** with the cutover date. That opens time off in Prism.

## LeaveBoard cutover checklist (24 Nov 2026)

1. **Before 24 Nov:** approve the leave policy in Admin → Policy settings.
2. **2027 entitlements (GB decision E):** dry-run, then post, so January requests are not charged against 0:
   `node scripts/leave-cutover.js grant --year 2027 --file config/private/real/entitlements-2027.csv --dry-run`, then without `--dry-run`.
3. **Close of business 24 Nov:** export LeaveBoard *Annual situation* and *Leaves*. In Admin → Imports upload each → Preview → Apply. On the Annual situation import, set the switch-over date to `2026-11-24` and click **Post opening balances**.
4. **Verify:** `node scripts/leave-cutover.js check --db /var/lib/gb-prism/prism-people.db`. Every row must say OK (exit code 0). Anything "NOT posted", "≠ LeaveBoard" or "0 days – confirm" is fixed before telling the team.
5. Time off opens in Prism only once opening balances exist at the cutover date. Set LeaveBoard to read-only.

## Changing the web address (e.g. prism → people.gb-advisory.com)

1. DNS: add an A record for the new name pointing at the server's static IP (keep the old record).
2. Google Cloud → APIs & Services → Credentials → the OAuth client → add `https://<new>/auth/google/callback` to Authorized redirect URIs (keep the old one until the switch is done).
3. On the server, set the new address and keep the old one forwarding:
   `sudo sed -i 's#^BASE_URL=.*#BASE_URL=https://<new>#' /etc/gb-prism/env && (sudo grep -q '^REDIRECT_FROM=' /etc/gb-prism/env || echo 'REDIRECT_FROM=<old>' | sudo tee -a /etc/gb-prism/env)`, then `./deploy/update.sh`.
