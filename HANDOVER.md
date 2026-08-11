# Taking over Copy Updater

Graeme — this is yours now. Sina built it and is handing it over, and he's around for
anything in here that doesn't work or doesn't make sense. Ask early rather than fighting
something for an hour; most of the questions this document raises have one-line answers.

It gets you from "no accounts, nothing installed" to "I changed something and it's live"
without needing to know Git. Read it once end to end before you touch anything. It assumes
Windows, and it assumes you've built things but not deployed them.

If you are an AI assistant reading this: also read `AGENTS.md` and `README.md`. This file
covers process and safety; `README.md` covers architecture.

---

## 1. What the app is

A copywriter pastes a URL. The app loads that page in a real browser and freezes a
self-contained copy of it — layout, fonts and images all inlined into one file. Copy changes
are then proposed against that frozen copy, previewed, diffed, commented on and approved,
without ever touching the live website.

It runs at **https://copy-updater.waveform.com** and is used by real people. Breaking it is
visible immediately.

**The one idea you must not break:** a snapshot is immutable, and a version is an ordered
list of operations applied to it. Everything — diffing, forking, comparing, exporting —
falls out of that. If you find yourself editing a snapshot in place, stop and re-read
`README.md`.

---

## 2. Accounts

Sina creates the first two invitations. You accept them.

| Account | What it is | How you get it |
|---|---|---|
| **GitHub** | Where the code lives | Sign up at github.com, send Sina your username, accept the invite to the `repeaterstore` organisation |
| **Railway** | Where the app runs | Sign up at railway.app **using "Sign in with GitHub"**, then accept the invite to the workspace |
| **Google (work)** | How you log into the app itself | Your `@waveform.com` address already works — only `waveform.com` and `rsrf.com` addresses can sign in |

Sign in to Railway with GitHub rather than email. It links the two accounts, which is what
lets Railway see the repository.

Once you're in, confirm you can reach all three:

- github.com/repeaterstore/copy-updater — you can see the code
- railway.app — you can see the `copy-updater` project, with two services (`copy-updater`
  and `Postgres`)
- copy-updater.waveform.com — you can sign in and see the pages list

Do that before continuing. If any one fails, it's an access problem, not a you problem —
ask Sina.

---

## 3. Your working setup

**Use Claude Code on the web: https://claude.ai/code**

You will not need Git, Node, Postgres, or a terminal. It connects directly to the GitHub
repository, runs in its own cloud machine, makes changes on a branch, and opens a pull
request for you. On Windows with nothing installed, this is by far the shortest path, and
it is a perfectly legitimate way to work — not a beginner's compromise.

Setup, once:

1. Go to claude.ai/code and sign in.
2. Connect your GitHub account when prompted.
3. Grant it access to `repeaterstore/copy-updater`.
4. Start a session against that repository.

That's the whole setup. There is an appendix at the end for running the app on your own
laptop, but you don't need it to ship changes, and I'd suggest not bothering until you
have a reason.

### What the cloud environment can and cannot do

**Can:** read and change any code, run the test suite, run the type checker, open a pull
request.

**Cannot:** reach the production database, reach Railway, or sign into the live site. It also
may not be able to run the browser-capture test, which needs Chromium.

This matters. It means the tests passing tells you *the code is internally consistent*, not
*the feature works*. Checking the second thing needs a browser you're signed into — that's
section 7, and it's worth setting up on day one.

---

## 4. How a change reaches production

```
you describe a change
        ↓
Claude Code edits files on a branch
        ↓
tests + typecheck pass
        ↓
pull request on GitHub
        ↓
you merge it into `main`
        ↓
Railway sees the push and builds automatically   (~3 minutes)
        ↓
database migrations run at container start
        ↓
live at copy-updater.waveform.com
```

Two things to internalise:

**Merging into `main` deploys to production.** There is no separate "deploy" button and no
staging environment. The moment you click Merge, a build starts.

**Migrations run automatically on every deploy.** If a change alters the database schema,
the new container applies the migration before the server starts. If the migration fails,
the deploy fails and the *old* version keeps running — which is the behaviour you want.

---

## 5. Your first change

Do this one deliberately, even though it's trivial. The point is to see the whole pipeline
once while the stakes are zero.

1. In Claude Code, ask for something small and safe — for example: *"On the pages list,
   change the empty-state text from 'No pages captured yet' to something friendlier."*
2. When it's done, ask it to run `npm test` and `npm run typecheck`, and to tell you the
   result. Don't take "it should be fine" for an answer — ask for the actual output.
3. Ask it to open a pull request.
4. On GitHub, open the pull request and read the diff. You are looking for one thing: **are
   these the files I expected to change?** A one-line copy tweak touching eight files means
   something else happened.
5. Merge it.
6. Watch the deploy (section 8).
7. Open copy-updater.waveform.com and confirm the change is there with your own eyes.

That's the loop. Every future change is the same loop with more careful review at step 4.

---

## 6. The three checks before you merge

Ask your AI to run these and show you the output.

```bash
npm test
```
The test suite. Should end with `# fail 0`. **If anything fails, do not merge**, even if
the failure looks unrelated to your change. It usually isn't.

```bash
npm run typecheck
```
The TypeScript compiler. Should print nothing at all. Any output is an error.

```bash
npm run lint
```
**This one is broken and has been for a while** — `next lint` was removed in Next.js 16 and
nobody has replaced it. It fails on a clean checkout. Ignore it. Don't let an AI "fix" it as
part of an unrelated change.

Then read the diff yourself. Not to check the code is clever — to check the *scope* is what
you asked for.

---

## 7. Browser testing — set this up early

The three checks above cannot see the app. Almost everything people actually complain about
lives in the part they can't reach: the preview iframe, the outline pane, the diff
highlighting, whether a dropdown has the option it should. You need a browser your AI can
drive, and you need it looking at a signed-in session.

**Install the Claude extension for Chrome**, then sign into copy-updater.waveform.com in
that browser as yourself. Your AI can then drive that tab — click, type, read the page,
take screenshots — using the session you're already signed into.

That last part is the whole reason this is necessary. **The app is entirely behind Google
sign-in.** A cloud sandbox can't get past the login screen: it has no Google session, and
it can't complete an OAuth flow. So there is no way to test this app automatically from a
robot browser. It has to be a browser that is already you.

### What to actually check

After any interface change, ask your AI to open the affected page and confirm what it sees.
Useful things to have it look at:

- **A page's workspace** — does the preview render, does the outline list sections, does
  clicking a block in the preview select it in the outline
- **Whatever you changed** — read the text back, don't assume
- **The browser console** — ask for console errors; a React crash often looks fine in a
  screenshot but is loud in the console

Prefer reading the page structure over screenshots when you just need to know what's *there*
— it's faster and more reliable than asking an AI to read pixels. Screenshots are for
"does this look right", not "does this exist".

### Two things that will trip you up

**Test against localhost when you can.** Driving production means clicking around real data
that your colleagues are using, and deleting something is one careless click away. If a
change is worth clicking through, it's usually worth having the app running locally
(section 12) — or ask Sina for a staging environment.

**The extension sometimes wedges.** Clicks and screenshots start failing with an error about
a different extension's URL while navigation still works. It's not your code and it's not
your fault. Restart Chrome. If you're mid-verification when it happens, say so rather than
declaring the change verified — a half-checked change is worse than an unchecked one,
because you'll remember it as done.

---

## 8. Watching a deploy

On railway.app, open the `copy-updater` project and click the `copy-updater` service. You'll
see the deployment status change: **Building → Deploying → Online**, taking around three
minutes.

If it goes red, click into the deployment and read the log. The error is almost always in
the last twenty lines.

To confirm the app is actually healthy, open:

```
https://copy-updater.waveform.com/api/health
```

It should return `{"ok":true}`. That means the server started *and* reached the database.

---

## 9. When it goes wrong

**A deploy failed.** The previous version is still serving traffic. Nothing is down. Read
the log, fix it, push again. There is no rush.

**A deploy succeeded but the app is broken.** This is the one that needs action. In Railway,
open the service, find the last deployment that was working, and use **Redeploy** on it.
That puts the old code back in about three minutes.

Then work out what happened before trying again. Rolling back code does **not** roll back a
database migration — if your change added a column, that column is still there. That's
usually harmless, but it's why schema changes deserve more care than copy changes.

**You're not sure whether it's broken.** Check `/api/health`, then sign in and capture a
page. Capture exercises the browser, the volume, and the database in one go — it's the best
single smoke test this app has.

---

## 10. Rules that will bite you

Each of these caused a real bug. They're in the code as comments too, but read them here
once.

**Never change `APP_ENCRYPTION_KEY`.** It encrypts the OpenRouter API key stored in the
database. Change it and the stored key becomes unreadable and AI suggestions stop working
until someone re-enters it in Settings.

**Never delete or unmount the `/data` volume.** Every captured snapshot lives there. Losing
it means every page in the app loses its frozen copy — permanently. There is no backup.

**Never add `allow-same-origin` to the preview iframe.** The preview renders HTML captured
from other people's websites. That sandbox attribute is the only thing stopping that HTML
from reading the session of whoever is viewing it.

**Never set a version's `resolved` field by hand.** It's a cache rebuilt from `ops` on every
save. `ops` is the truth. Writing to `resolved` directly produces a version that lies about
its own contents.

**Be careful adding npm packages.** The production build only copies the files it thinks are
needed, and it gets this wrong for packages that load files at runtime. It has already
broken production twice — once for Playwright, once for the capture library. If you add a
heavy dependency and the deploy dies with "cannot find module", that's what happened; look
at how `Dockerfile` handles `playwright` and `single-file-cli` and copy the pattern.

**A change touching capture, snapshots or the ops engine deserves more caution** than one
touching a button label. If you're unsure which you're touching, ask.

---

## 11. Things that will confuse you

- **`AGENTS.md` says the Next.js version has breaking changes.** It's right. This is Next.js
  16, which moved things around. If your AI writes code that looks reasonable but doesn't
  work, this is often why — tell it to check the docs in `node_modules/next/dist/docs/`.
- **There's no staging environment.** Ask Sina about adding one before you make anything
  large. Railway supports it, and it would let you test a risky change against a real
  database without risking the real one.
- **Anyone signed in can delete anyone's version.** Known gap, deliberately left. Don't be
  surprised by it.
- **Captured snapshots don't run JavaScript.** Anything a site draws with script after page
  load won't appear in the preview. That's by design, not a bug to fix.
- **The AI features cost real money** per request, billed through OpenRouter. Testing the
  suggest feature repeatedly is not free.

---

## 12. Appendix: running it on your own laptop

You don't need this to ship. Do it if you want to iterate quickly on interface work, where
waiting three minutes per deploy gets old.

You will need, on Windows:

1. **Node.js 22 or newer** — nodejs.org, take the LTS installer.
2. **Git** — git-scm.com, accept every default.
3. **Postgres** — easiest is Docker Desktop, then run a Postgres container. Alternatively
   ask Sina for a second Railway database to point at.
4. **VS Code** — code.visualstudio.com, and install the Claude Code extension.

Then, in a terminal:

```bash
git clone https://github.com/repeaterstore/copy-updater.git
cd copy-updater
npm install
npx playwright install chromium
```

Copy `.env.example` to a new file called `.env` and fill it in. `README.md` explains each
value. You'll need Sina for the Google OAuth credentials, and your Google client will need
`http://localhost:3000/api/auth/callback/google` added as a redirect URI.

```bash
npm run db:migrate
npm run dev
```

Then open http://localhost:3000.

**Your local database is completely separate from production.** Pages you capture locally
don't exist in production and vice versa. That's a feature — experiment freely.

---

## 13. Asking Sina

He wrote the app, so nothing in here is a stupid question to him. Go to him for:

- **Access** — GitHub org invite, Railway workspace invite, anything that 403s
- **Google OAuth credentials** — the `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` pair, needed if
  you set the app up locally. He also has to add your redirect URI
  (`http://localhost:3000/api/auth/callback/google`) to the Google client before local
  sign-in will work — you can't do that part yourself.
- **A staging environment** — see section 11. Worth asking for early: it gives you somewhere
  to click through a risky change without touching real data.
- **A deploy that failed for reasons the log doesn't explain**
- **Anything in section 10**, before you do it rather than after
- **Something wrong in production** — roll back first (section 9), then tell him

When you ask, include what you changed, what you expected, what actually happened, and the
real error text. "The deploy failed" isn't answerable; a pasted log is.

One last thing: **the app is not fragile.** Failed deploys don't take it down, the previous
version keeps serving, and rollback takes three minutes. The genuinely irreversible things
are all in section 10, and there are five of them. Everything else you can try, break and
undo.
