# Saffron POS

A downloadable, mobile-friendly point-of-sale app: ring up sales, manage inventory and customers, run reports, and handle multiple employee logins. The database lives in the cloud, so every device you run this on -- your computer, a tablet at the register, a phone -- sees the same live data.

## What's inside

- **Sales / checkout** — item grid, cart, tax + discount, cash/card, printable receipt
- **Inventory** — items, categories, stock levels, low-stock flags
- **Customers** — records, loyalty points, purchase history
- **Reports** — daily summary, top products, sales by employee, low-stock list
- **Employee logins** — admin / manager / cashier roles
- **Mobile-friendly** — the same app works on a laptop, tablet, or phone browser. On a phone it switches to a bottom tab bar with a slide-out menu, card-style lists, bottom-sheet forms, and a pinned Cash / Card pay bar on the sale screen
- **Installable** — add it to a phone's home screen or install it as a Windows desktop app (see below)
- **Cloud database** — one shared Postgres database, always online, no manual sync step

## Step 1: Get a free cloud Postgres database

Pick one:

- **[Supabase](https://supabase.com)** — free tier, easy setup. Note: free projects pause after a week of no activity and need a manual "unpause" click in their dashboard.
- **[Neon](https://neon.tech)** — free tier with true auto-wake (scale-to-zero) and no manual steps, a better fit if the store might go a few days without use.

Either way: create a project, then find its **connection string** (looks like `postgresql://user:password@host/dbname`) in the project's connection settings.

**If you're using Supabase:** use the **Connection pooling** string (Project Settings → Database → Connection pooling), not the direct `db.xxxxx.supabase.co` one. The direct host is IPv6-only on current Supabase plans, which fails to connect on networks without working IPv6 (surprisingly common on some home/mobile networks) — the pooler string works over IPv4 and avoids that entirely.

## Step 2: Configure and run

1. Unzip this folder anywhere on your computer.
2. Copy `.env.example` to `.env` and paste your connection string into `DATABASE_URL`. Also set a real `JWT_SECRET` (any long random string).
3. Double-click `start.bat` (Windows) or `start.sh` (Mac/Linux) — or from a terminal in this folder:
   ```
   npm install
   npm start
   ```
4. The terminal prints two links:
   ```
   On this computer:  http://localhost:3000
   On your network:   http://192.168.1.42:3000   (use this on phones/tablets)
   ```
5. Log in with the default account: **admin / admin123** — go to Settings and change this immediately (or just create a new admin employee and disable this one).

The very first time the app connects to an empty database, it automatically creates all the tables and that default admin account.

## Platform admin (managing companies)

One special account sits above every company. Signing in with it opens a console that lists every company using this install, where you can add a company (with its first admin), pause or resume it, remove it, and add admins or reset passwords inside any company.

It's switched on from the environment (your `.env` locally, or the environment variables on your host) -- the password is never stored in the code:

```
JWT_SECRET=<a long random string>
PLATFORM_ADMIN_PASSWORD=<the platform admin password>
PLATFORM_ADMIN_COMPANY=admin-saffron   # optional -- the "company code" you type to sign in
PLATFORM_ADMIN_USER=admin              # optional -- the username
```

Then sign in on the normal login page with that company code, username and password; you'll land on the console. If `PLATFORM_ADMIN_PASSWORD` or `JWT_SECRET` isn't set, the platform account stays off.

- **Pause** blocks sign-in and cuts off anyone already signed in, right away. Nothing is deleted.
- **Remove** permanently deletes the company and all of its data, and asks you to type the company code first.
- The platform company code can't be registered by customers, and repeated wrong passwords lock that address out for 15 minutes.
- To close public sign-up (`register.html`) and onboard companies only from the console, set `ALLOW_SELF_SIGNUP=false`.

## Getting "access from anywhere" (not just your Wi-Fi)

Because the database is already online, any copy of this app pointed at the same `DATABASE_URL` sees the same data. Two ways to get to it from outside your home/store network:

- **Run it on each device that needs it.** Every register/computer/tablet can have its own copy of this same zip, each with the same `.env` `DATABASE_URL`. They'll all read and write the same live data.
- **Deploy the app itself to a cloud host** (e.g. Render, Railway, Fly.io) with the same `DATABASE_URL`, and everyone just opens a URL instead of running anything locally. This is also the easiest path to a phone-installable app on Android (see below), since Android has no way to run the Node server locally.

### Deploying to Render (free tier)

1. Push this project to GitHub (see the next section) if you haven't already.
2. Create a free account at [render.com](https://render.com), then **New → Web Service**, and connect your GitHub repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Environment variables:** add `DATABASE_URL` and `JWT_SECRET` with the same values from your local `.env`.
4. Deploy. Render gives you a URL like `https://saffron-pos.onrender.com` — that's now the shared address for every device, including phones.
5. Free-tier services spin down after inactivity, so the first request after a quiet spell takes a few extra seconds to wake up — normal, not a bug.

## Installing it as an app (no app store needed)

Saffron POS is a Progressive Web App: once you're on a URL over `https://` (or `http://localhost` while testing locally), the browser will offer to install it with its own icon and window, no separate download required.

- **Android (Chrome):** open the site → menu (⋮) → **Add to Home screen** / **Install app**. It then behaves like any other installed app icon.
- **iPhone (Safari):** open the site → Share → **Add to Home Screen**.
- **Windows/Mac/Linux (Chrome or Edge):** open the site → click the install icon in the address bar (or menu → **Install Saffron POS**).

This only works once the app is served over HTTPS (e.g. the Render URL above) or `http://localhost` — a plain `http://192.168.x.x:3000` LAN address won't offer the install prompt, since browsers require a secure context for it.

## Windows desktop app (.exe)

There's an Electron wrapper (`electron/main.js`) that runs the exact same server in the background and opens it in its own window — no browser tab needed. It needs to be built on a machine with normal internet access (it downloads the Electron runtime), so this step isn't done for you in this repo.

1. `npm install` (this pulls in `electron` and `electron-builder` as dev dependencies).
2. Try it first without packaging: `npm run electron` — this should behave exactly like `npm start` but open its own window instead of telling you to visit `localhost:3000`.
3. Build the installer: `npm run dist:win`. The finished installer shows up in `dist/` (e.g. `dist/Saffron POS Setup 1.0.0.exe`) — that's the file to share/download.

**Database credentials in the installer:** if there's a real `.env` in the project root (the same one `npm start` uses) when you run `npm run dist:win`, it gets bundled straight into the installer — every computer that installs it connects immediately, no setup screen at all. This is meant for devices you control (your own registers) since anyone with the installer could in principle extract that connection string. If you'd rather each new computer type in its own connection string, delete/rename `.env` before running `npm run dist:win` — installs will then show a one-time settings screen instead (same flow used to set this machine up).

`npm run dist:mac` / `npm run dist:linux` build the equivalent Mac/Linux packages from the same Electron code, if you ever need those.

## Putting this on GitHub

```
cd quickbooks-pos-lite
git init
git add .
git commit -m "Initial commit: Saffron POS"
```

Then create an empty repository on GitHub.com (don't initialize it with a README), and run the two commands it shows you, e.g.:

```
git remote add origin https://github.com/YOUR-USERNAME/quickbooks-pos-lite.git
git branch -M main
git push -u origin main
```

`.gitignore` already excludes `node_modules/` and your `.env` secrets (including your database connection string), so those won't get pushed.

## Project structure

```
quickbooks-pos-lite/
  server/           Express API + Postgres database logic
    routes/         products, customers, sales, reports, users, settings
    db.js           schema + default admin seed, Postgres connection pool
    auth.js         login + JWT session checks
    asyncHandler.js small helper so async route errors don't hang requests
    index.js        app entry point
  public/           the frontend (plain HTML/CSS/JS, no build step needed)
    index.html      main app shell (sidebar/tabs + views)
    login.html
    register.html
    manifest.json   PWA install metadata
    sw.js           service worker (makes the app installable)
    icons/          app icons used by the PWA manifest + Electron window
    css/style.css
    js/app.js       all screens: Sale, Inventory, Customers, Reports, Employees, Settings
    js/api.js       fetch helper
    js/pwa.js       registers the service worker
  electron/
    main.js         Electron wrapper: runs the same server, opens it in its own window
  build/
    icon.png, icon.ico   installer/app icons used by electron-builder
  .env.example      copy to .env and fill in DATABASE_URL + JWT_SECRET
```

## Notes

- Passwords are hashed (scrypt); sessions use JWTs that expire after 12 hours.
- Payment methods are recorded as "cash" or "card" for reporting; this app does not process real card payments — wire up a real payment processor's SDK if you need that.
- Barcode scanners that act as keyboards work out of the box: just focus the item search box and scan.
- Because the database is cloud-hosted, this app needs an internet connection to work — there's no offline mode in this version.
