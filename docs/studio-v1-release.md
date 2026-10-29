# Studio V1 — acceptance and release checklist

Studio is implemented behind disabled-by-default flags. This file describes the release procedure; writing it does not deploy, migrate production or enable paid work.

## Business configuration

There is no fixed product count or fixed set of product groups. Admin defines Teams, memberships, Stores, products/codes/instructions, skill versions, masters and scenes. Print dimensions, DPI and background are product-specific; obtain these from the actual print supplier. A new product/master/scene version has a separate ID. Assign the new product version to a Store when ready; existing approved runs retain their original snapshots.

Admin configures a daily run time in Management → Schedule operations (HH:mm, default 22:00, UTC+7). Changes apply to newly approved selections, not existing dates. Every selection runs once. A missed five-minute dispatch window needs explicit catch-up. Changing time does not enable the schedule flag.

## Isolated acceptance first

1. Use a dedicated MongoDB database, Redis prefix and storage prefix. Do not load production credentials or reuse the production database for tests.
2. Run API unit tests, Studio/Team-budget/module integration, real Redis queue tests and backup restore tests. Run Studio browser checks and auth/legacy regression checks. AI transports remain mocked during automated tests.
3. Populate the catalog with arbitrary representative products, defined by the company rather than a hardcoded five-product list. Include a product with transparent artwork and another with white background, different aspect ratios and user-defined codes.
4. Seller creates a draft, closes/reopens it, submits it, and cannot approve it. Leader requests changes, then approves an immutable version. A second browser editing the old revision must receive a conflict.
5. For artwork-first runs, confirm analysis → briefs → original artwork → thumbnail. Inspect each artwork separately; opaque output must not pass a transparent-file requirement. Confirm exact pixel dimensions and exported DPI, but assess image detail visually: resizing/metadata cannot create print detail that the model did not produce.
6. Generate partial samples and continue the remaining designs. Completed preparation/artwork/thumbnails must keep their IDs and not incur new calls. Unknown provider outcomes require reconciliation. Do not treat a transport redelivery as permission for another AI request.
7. Select approved original artwork for Team mockups, or submit uploaded originals. Validate per-source scene/color combinations, total request count, cancellation, known-failure continuation and the exported manifest. Verify source/target roles and human review of text, colors, geometry and watermarks.
8. Revoke Store membership and ensure Studio and legacy image routes both reject access. Dashboard counts and output pages must exclude revoked Stores. Check resources by search/page rather than relying on the bounded bootstrap snapshot.
9. Verify actual provider pricing/reservations against the company's chosen unit (credit or USD). Run two employees against the final available Team credit. Unknown costs retain holds; reconciliation must settle once. Test real provider images only with agreed company samples and a recorded spend limit.
10. Observe a real daily schedule at the selected time. Before the cutoff, jobs remain scheduled; within the window they enter the queue once. Restart before/after dispatch and inspect occurrence/batch IDs. Clock-controlled tests are evidence for logic, not a substitute for this operational check.

## Backup and migration rehearsal

- Pause writes and stop dispatch/consumers before making the authenticated encrypted backup. The supplied backup CLI requires maintenance confirmation; a copied live collection is not a consistent backup.
- Restore into an empty isolated database using the shipped restore command. Verify original skill GridFS bytes, encrypted images, resource versions, time settings and both usage ledgers. Keep original encryption keys available through the company's secret storage; never commit them.
- Restore revokes sessions, pauses the global paid queue, blocks active Studio tickets/mockups, marks unfinished plan/image slots interrupted and returns approved ideas for review. Done images and cost holds remain intact. Do not automatically unpause or retry uncertain requests.
- Boot the current Studio module against the restored database to exercise additive index initialization. Do not point this rehearsal at production. Verify zero paid AI calls.

## Coordinated rollout

1. Record the API/frontend/worker revision, selected schedule, billing configuration and recovery point. Confirm all automated checks and company UAT observations.
2. Keep STUDIO_ENABLED=false, STUDIO_SCHEDULER_ENABLED=false and VITE_STUDIO_ENABLED=false while staging artifacts. Stop old consumers before introducing artwork-dependent slots. API and all workers must use the same compatible release.
3. Take and verify the maintenance backup. Apply the additive database/index initialization through the new API. Existing user/asset owners, authentication AAD, personal conversations and billing history are retained.
4. Enable Studio for the intended rollout with a known test account, verify Store permissions and the real provider configuration. The frontend flag is a Vite build argument; changing Nginx runtime variables alone does not replace the bundle.
5. Enable the separate scheduler only after pricing, the selected daily time and operational acceptance are confirmed. Observe the first live batch and record actual calls, costs, output IDs and unresolved holds. The browser need not stay open.

## Rollback and incidents

- Pause paid work and keep records/assets/ledgers. Never clear the database or enqueue the whole batch again as a recovery shortcut.
- A frontend-only rollback can retain the current compatible API/worker while dispatch is paused. Backend rollback requires a version that understands artwork dependencies and the new queue task kinds; an older worker can otherwise ignore a dependency.
- With Studio disabled, current Studio worker handlers do not send requests. Retain pending Mongo records and identify their request IDs before resuming. Prefer the compatible release and operator reconciliation over deleting Redis or resetting slot state.
- Review unknown requests against provider logs and actual usage, reconcile costs once, then decide explicitly whether a new paid request is warranted. A correct prompt is not proof that a model followed it; visual acceptance remains a human decision.

Release evidence must include who accepted the actual product samples, provider/model, request IDs, spend, observed scheduled run, verified backup and rollback revision. Until these observations are recorded, mark production acceptance pending.
