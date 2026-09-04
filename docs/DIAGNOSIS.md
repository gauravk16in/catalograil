# Phase 1 diagnosis — S0.1

Recorded 2026-09-05 against the deployed `dev` environment in `ap-south-1`,
account `149561018240`. Every line below is an **observed** value: a response
captured from the live system or a line read out of the deployed source. Where
a checklist item turned out not to be a cause, it says so — ruling something
out is worth as much here as finding it.

Deployed surfaces under test:

| Surface | URL |
| --- | --- |
| Merchant dashboard | `https://main.d21osrv849o4of.amplifyapp.com` |
| Buyer dashboard | `https://main.d1ypcvqs4kcq44.amplifyapp.com` |
| HTTP API | `https://hfrx7zmgu5.execute-api.ap-south-1.amazonaws.com` |

---

## The short version

Nothing is wrong with the network, the database, the workers, or the build.
All of that is healthy and measured below.

Every request from both dashboards fails at the API boundary, and it fails for
**four independent reasons at once** — each one sufficient on its own. That is
why the symptom reads as "everything is broken" rather than as one bad screen.

Underneath those four sits a fifth problem that the others were hiding: **four
of the seven endpoints the dashboards call have never been implemented.**
Fixing auth and CORS would move the failure from `403` to `404`, not to a
working dashboard.

---

## Ranked root causes

### 1. The CORS preflight itself returns 403 — blocks 100% of browser traffic

Observed:

```
$ curl -i -X OPTIONS https://hfrx7zmgu5.execute-api.ap-south-1.amazonaws.com/merchant/products \
    -H 'Origin: https://main.d21osrv849o4of.amplifyapp.com' \
    -H 'Access-Control-Request-Method: GET'
HTTP/2 403
access-control-allow-origin: *
access-control-allow-methods: GET,POST,PUT
access-control-allow-headers: authorization,content-type,x-merchant-id
```

The route is `ANY /merchant/{proxy+}` with `AuthorizationType: AWS_IAM`
(`aws apigatewayv2 get-routes`). `ANY` includes `OPTIONS`, so the authorizer
runs on the preflight, and an unsigned preflight is rejected. A browser treats
any non-2xx preflight as a CORS failure and **never sends the real request** —
which is why the Network tab shows failures with no useful status.

This is the first thing a browser hits and the first thing to fix.

### 2. Every route requires SigV4, which a browser cannot produce

Observed:

```
$ curl -i https://hfrx7zmgu5.execute-api.ap-south-1.amazonaws.com/merchant/products \
    -H 'Origin: https://main.d21osrv849o4of.amplifyapp.com'
HTTP/2 403
{"message":"Forbidden"}
```

Both routes are IAM-authorized:

```
POST /internal/{proxy+}   AWS_IAM
ANY  /merchant/{proxy+}   AWS_IAM
```

The same request signed with SigV4 from the `catalograil` profile returns
`200`, which confirms the backend is healthy and the gate is the only obstacle.

This is deliberate, not an oversight — `api-stack.ts:31` explains that
`POST /merchant/uploads` derives an S3 prefix from a caller-supplied merchant
id, so an ungated version would let anyone write into anyone's catalogue. **The
IAM gate is load-bearing and must be replaced, not removed** (see cause 5).

### 3. `Access-Control-Allow-Origin: *` is incompatible with the client's own fetch

Observed: the API returns the wildcard origin (above). The merchant client
sends credentials — `apps/merchant/src/lib/api.ts:31`:

```ts
credentials: 'include',
```

Browsers reject a wildcard `Access-Control-Allow-Origin` on any credentialed
request. Even with causes 1 and 2 fixed, this fails independently. The origin
must be echoed explicitly per S1.4.

### 4. The credentialed cookie could never have worked cross-site

`credentials: 'include'` sends cookies from `*.amplifyapp.com` to
`*.execute-api.ap-south-1.amazonaws.com` — different registrable domains, so
the cookie is cross-site and needs `SameSite=None; Secure`.

Observed: **no `Set-Cookie` is issued anywhere in the API.** `grep -rn
'Set-Cookie|SameSite|httpOnly' services/ packages/core/src` returns nothing.
There is no session cookie to send, correctly configured or otherwise. The
comment in `api.ts` describing an httpOnly session cookie documents an
intention, not something that exists.

S1.2's conclusion is the right one and is reinforced here: move to bearer
tokens in the `Authorization` header and delete the cookie path entirely.

### 5. Four of the seven endpoints the dashboards call do not exist

This is the finding the other four were masking. `services/api-merchant/src/handler.ts`
implements exactly two routes; everything else falls through to a 404.

| Endpoint | Called from | Implemented |
| --- | --- | --- |
| `GET /merchant/me` | `lib/session.ts:40` | **No** |
| `GET /merchant/products` | `app/products/page.tsx:28` | **No** |
| `GET /merchant/uploads` | `app/uploads/page.tsx:39` | **No** |
| `POST /merchant/policies` | `app/policies/page.tsx:34` | **No** |
| `POST /merchant/uploads` | `app/uploads/page.tsx:68` | Yes |
| `GET /merchant/uploads/templates/{name}` | template download | Yes |
| `POST /internal/search` | preview page, buyer page | Yes |

Consequences worth stating plainly:

- The merchant dashboard has **no data source for its product list.** T1.12's
  create/update/archive handlers exist in `handlers/products.ts` and are fully
  tested, but nothing routes to them.
- `useSession()` calls `/merchant/me`, gets a 404, and swallows it — the catch
  block treats failure as "not signed in". So the dashboard renders a
  signed-out shell and looks merely empty rather than broken.

### 6. Merchant identity is a client-supplied header

`services/api-merchant/src/handler.ts:83`:

```ts
const merchantId = event.headers['x-merchant-id'];
```

Any caller past the IAM gate can act as any merchant by changing one header.
This is exactly the horizontal privilege escalation S2.3 describes, and it is
the reason cause 2 cannot simply be relaxed: **IAM auth is the only thing
making this safe today.** Cognito (Block B) has to land in the same change that
opens the API to browsers, not after it.

### 7. No health endpoint

`grep -rn "'/health" services/` returns nothing. There is no `/health` or
`/health/deep`, so there is no way to answer "is the API up" without an
IAM-signed call to a business route. S1.5 stands.

### 8. CSV templates are served from an IAM-gated API route

`GET /merchant/uploads/templates/{name}` is implemented and returns a correct
`Content-Disposition`, but it sits behind the same IAM gate, so the browser
download fails with 403 — the reported symptom. `apps/merchant/public/templates/`
does not exist.

S4.1's instruction to generate the files at build time and serve them as static
assets removes the API, the auth, and the failure mode together.

---

## Ruled out — checked, and healthy

These are on the S0.1 checklist and are **not** contributing. Recorded so the
next person does not re-investigate them.

| Check | Observed | Verdict |
| --- | --- | --- |
| `NEXT_PUBLIC_API_BASE_URL` baked into the bundle | Found in `/_next/static/chunks/app/products/page-920b68bba17a8d42.js` as `https://hfrx7zmgu5.execute-api.ap-south-1.amazonaws.com` | Correct |
| Amplify env vars set | Both apps carry `NEXT_PUBLIC_API_BASE_URL` and `NEXT_PUBLIC_STAGE` | Correct |
| Lambda VPC egress / NAT | `nat-04028daeb39ddf6cf` available; Bedrock, Secrets Manager and SQS all reachable from Lambda in the last backfill | Working |
| VPC endpoints | S3 and DynamoDB gateway endpoints present | Working |
| Lambda timeouts | Merchant 29s, Internal 29s — not the 3s default | Fine |
| RDS Proxy reachability | `POST /internal/search` returns real rows in 37ms warm | Working |
| Migrations applied to deployed DB | Migration Lambda reports `migrationsApplied: true`; 61 products indexed | Applied |
| Worker pipeline | All five DLQs at 0 messages | Healthy |
| Search correctness | `"something to record my drive"` returns dashcams — semantic match on real Embed v4 vectors | Working |

### One checklist item where the premise does not apply

S0.1 asks whether the Amplify platform is `WEB_COMPUTE`, on the grounds that
App Router with server components requires it.

Observed: both apps are `platform: WEB`, and both set `output: 'export'` in
`next.config`. Every page that fetches data is a client component; the only
files without `'use client'` are two `layout.tsx` and the merchant `page.tsx`,
which render static markup and call nothing. There is no server runtime to
host, so `WEB` is correct and `WEB_COMPUTE` would deploy a server with nothing
to do — and its runtime expects a real `node_modules` in the app directory,
which a pnpm workspace does not produce.

**No change needed here.** This is recorded because it is the kind of item that
gets "fixed" on a second pass and quietly breaks the deployment.

### One real but minor defect, unrelated to the outage

Trailing-slash URLs 404 while their bare forms work:

```
/products   200      /products/   404
/policies   (n/a)    /policies/   404
```

The static export writes `products.html`, and the SPA rewrite
(`/<*>` → `/index.html`, `404-200`) is not catching the directory form. In-app
navigation uses the bare paths, so nothing in the UI hits this; a shared or
bookmarked link with a trailing slash does. Worth fixing with `trailingSlash`
handling, not urgent.

---

## What this means for the sprint order

The blocks are already in the right order, and the diagnosis explains why:

1. **Block A cannot fully succeed on its own.** Its acceptance is "every page
   performs a real API call that returns 200", and four of those endpoints do
   not exist. Block A can fix preflight, CORS, health and the template
   download; the product, session and policy screens need endpoints built.
2. **Block B is not optional and cannot be deferred.** Cause 6 means the IAM
   gate is the only access control in the system. Opening the API to browsers
   without Cognito in the same change turns a broken dashboard into an open
   one.

Recommended sequencing within Block A, tightest loop first:

1. Add `/health` and `/health/deep` unauthenticated — gives a signal that does
   not depend on anything else being fixed.
2. Make `OPTIONS` unauthenticated and echo explicit origins.
3. Generate CSV templates as static assets, removing that API dependency.
4. Implement the four missing merchant endpoints behind the existing IAM gate,
   so they are testable by signed request before Cognito lands.
5. Then Block B replaces the gate and the `x-merchant-id` header together.
