# Creative Studio V1 — implementation ledger

Updated: 2026-10-29 (UTC+7). This is an implementation checkpoint, not a declaration that all V1 acceptance criteria have passed. No deployment, data reset or production migration was performed.

## First working slice

- Separate Studio frontend shell and feature routes, loaded independently of legacy chat. Warm LCG orange/cream UI, accessible mobile menu and one main page scroll.
- Server-side Team membership (`seller` / `leader`) and Store assignments. Existing company `admin` remains the administrative role. Team is separate from the legacy Project model.
- Administrative creation/update of Teams and Stores; product, instruction and master-photo library. Existing account, weekly credit budget and administration pages remain available.
- Four-step Idea Board flow, incomplete server drafts and serialized autosave. PATCH and approval use explicit revisions, with conflicts reported instead of silent overwrites.
- Leader approval creates an immutable snapshot of the source photo, store master, product instructions, skill documents, model and requested count. Editing an approved idea creates a new draft; an existing dispatched ticket retains its original snapshot.
- Persisted approval outbox, one-shot selection ticket and deterministic image slot IDs. Reconciliation repairs missing ticket/slot dispatches. BullMQ payloads contain identifiers only, using the existing global/per-user queue concurrency limits.
- Each redesign image request sends its saved final prompt and both source/master images through a provider-neutral `composeImage` adapter. Gemini and the compatible ShopAIKey adapter reuse the current transports, private audit context and individual weekly budget ledger. No hidden mockup-transfer prompt is substituted.
- Server-side daily scheduling in UTC+7, default 22:00 and editable by an administrator in Management → Schedule operations. A selection is consumed once, not repeated every day. Overdue windows beyond five minutes become `missed`; only an administrator can request catch-up.
- Per-image progress, manual output review and an approved-output library, with PNG/JPG ZIP download. Unknown submitted calls are not automatically resubmitted. Existing encrypted image ownership/AAD remains unchanged; Team visibility uses server-checked business references.
- Legacy chat/history and the working photo-to-reference mockup tool remain available. Their private data is not silently moved into a Team.
- Revoking Store access also blocks the affected Studio output through legacy image content/preview routes. Asset encryption ownership is preserved; it is not used to bypass current Studio permissions.

## G2 — skill versions and creative preparation

ZIP upload reads exactly one `SKILL.md`, bundled Markdown/text references, file hashes and bundled master images. Imports are pending until an administrator reviews them. Executable dependencies/unknown file types block approval. Extraction uses bounded streams (50 MB ZIP, 100 MB total expanded, 16 MB per file, 150 files); paths/symlinks and multiple `SKILL.md` roots are rejected. Scripts are never executed.

Original ZIPs are retained with AES-256-GCM encryption in the existing private GridFS storage (ZIPs can exceed the private R2 image object's 32MB limit). The archive is integrity-checked before an administrator downloads it. Archive records contain private encryption metadata separately from the library catalog. No plaintext archive is written to disk.

Each upgrade creates a separate resource, family/version number, declared skill version and original ZIP. A unique family/version index rejects racing uploads. Import state must be `ready` before approval; incomplete imports are visible and cannot run. Existing references continue using the earlier resource ID and snapshot, including selected case-image hashes.

Local Markdown/code-path references are checked recursively from `SKILL.md`; missing files block approval. Referenced archive documents are retained for history and excluded from active instructions. JSON/YAML are retained but not executed; external links are disclosed as unsynchronized. This checks supported reference syntax, not every natural-language dependency a skill might express. No remote Drive/Sheets lookup or arbitrary runtime is added.

The administrator can select up to four bundled images as explicit context before approving a version. The source and store master are always images 1 and 2, with chosen examples following in saved order. The native vision adapter observes all selected images; analysis previews are resized to reduce context size. Full original source/master/example bytes are used for image generation.

New approvals use two durable preparation steps: (1) observe source/master/example images through the configured vision provider, (2) create exactly the requested number of distinct creative briefs using the existing text router (VyceAI health-checked preference, ShopAIKey fallback). Both use existing per-account billing/audit boundaries. Vision/text/image costs are additional real calls, not free or assumed zero. Analysis, invariants, editable features, source artifacts, risks and per-image briefs are saved and visible in the idea detail.

No image slots are dispatched until preparation validates. Missing/duplicate briefs or malformed analysis block the ticket. A submitted preparation request with unknown outcome is marked interrupted and is not retried automatically; there is no fallback to generic image prompts. A pre-submit lease reclaim uses an attempt ID, preventing a stale worker from submitting after a newer claim. Legacy tickets without `planningVersion` retain their original execution path.

For daytime runs, an optional sample count creates only the first approved slots, then pauses at `sample_review`. Owner/Leader explicitly continues the remaining approved slots. The completed slots, plans and result IDs are reused, including across double clicks; no completed image or preparation call is repeated. Nightly selections always dispatch the full approved count and never pause for sample confirmation.

New ideas default to an optional artwork-first path in the frontend; legacy approvals keep their original single-image behavior. Products require an admin-defined print specification before artwork-first submission: pixel width/height, DPI and white/transparent background, bounded by image safety limits. Product names, codes, instructions and the number of product groups are not a fixed list. Each new version has a separate resource ID and retains earlier snapshots.

For each brief, a durable artwork slot creates a standalone flat design first. Its dependent thumbnail slot cannot submit until that artwork exists, and sends the original artwork as image 1 and the saved master as image 2. Each thumbnail asset records its artwork parent. Missing/uncertain artwork blocks dependent output instead of generating a substitute. Sample continuation, delivery reconciliation, per-account/Team billing and stale-attempt protection apply to both stages.

Artwork is normalized to the configured dimensions/DPI without changing aspect ratio. This may resample the native result and does not create print detail. Opaque model output cannot be approved against a transparent-background requirement; transparent artwork must export PNG, since JPEG discards alpha. Artwork and thumbnails have separate reviews. Gallery-to-mockup handoff uses approved original artwork when available, and blocks until its separate review is approved. Legacy flattened outputs remain usable. Real visual quality acceptance against company-selected samples remains pending.

## G3 — Team budgets and schedule operations

The company-wide daily time is stored in MongoDB (HH:mm, default 22:00, Asia/Ho_Chi_Minh). Admin edits require a reason and revision check, with audit history. Changes affect newly approved selections; previously approved dueAt/cutoffs remain immutable. If the selected time has passed, approval uses the following day. Different time cutoffs on the same date have separate occurrences/batches; legacy 22:00 IDs remain compatible. Wizard, approval, dashboard, operations and guide use the configured or snapshotted time. Changing time does not enable the independently gated scheduler.

Trusted worker context assigns each preparation/image call to a Team. Both the existing individual weekly cap (default 50 credit under the company CREDIT policy) and the Team daily cap must admit a reservation before an upstream call. Team periods use UTC+7 midnight; a request belongs to the day it is admitted, including later settlement. Admin can set/increase/decrease a cap with a reason and policy-version conflict check. Zero blocks new requests; null leaves the Team uncapped while personal limits still apply. No monetary default is guessed for a Team.

Each ledger uses Mongo document compare-and-swap, including concurrent admissions and limit edits. The two ledgers are updated sequentially, not in a multi-document transaction. Failed/unknown storage transitions retain conservative holds; a periodic repair mirrors authoritative personal settlement into Team usage without repeating AI. Unknown provider outcomes stay reserved until existing administrator cost reconciliation. Cap enforcement depends on configured reserves covering potential call costs; actual provider cost can exceed an underestimated reservation. Journals are bounded and must be archived before reaching their documented size limits.

Night tickets reference one durable UTC+7 occurrence and a Team batch. The original dueAt/cutoff remain unchanged when an administrator catches up a missed batch. The operations panel paginates batch/ticket history, aggregates actual ticket states and exposes step/request errors. A dedicated Team budget tab shows spent/reserved/available and hold details. Only known pre-provider budget/price/access rejections may be resumed; completed outputs remain, uncertain calls cannot be resubmitted. A partially interrupted resume can continue from already-reset queued steps.

Real isolated Redis/BullMQ and Mongo tests cover two consumers, global/per-account concurrency, missing approval outbox delivery, a publish failure, API/worker restart and completed message redelivery. AI is mocked. This verifies application recovery, not infrastructure HA, provider idempotency or a real scheduled 22:00 UAT.

## G4 — Team mockup sets

The Studio mockup route now creates persistent Team jobs. Its two inputs are approved Gallery designs (with original ticket/store/product validation) or private uploaded source images explicitly submitted to a store. Approved scene images come from the Team library. Each source has its own selected scenes and optional material colors; shared settings can be applied to all sources. The UI shows the exact combination count before submission. Limits are 12 sources, 12 scenes/source, 8 colors/source and 100 combinations/set.

Submission records an immutable source/scene hash snapshot and an idempotency key. Each combination has a stable slot, full final prompt, source index, scene ID, color, request ID and result ID. Requests send original source first and target scene second through composeImage. The prompt preserves the target composition, applies source designs, limits color changes to material and forbids newly generated watermarks. This is an instruction, not an automated guarantee of visual fidelity.

Mockups reuse the real shared BullMQ queue, account concurrency, encrypted assets and dual budget context. Missing dispatches/slot records reconcile; stale pre-submit attempts cannot submit after reclaim. Submitted calls with unknown results stop for reconciliation. Explicit continuation only requeues known pre-provider failures, retains completed slots and rejects uncertain calls; stopped sets are not silently resumed. Store/member/source-review access is checked again before execution and on image routes, including legacy content routes.

Results retain input provenance, manual quality review, Team output-library visibility and PNG/JPG export. A mockup ZIP includes source/scene/color metadata in its manifest and filenames identify the combination. Gallery handoff passes authorized identifiers in the route and fetches current approval on the server; it does not cache shared image bytes in localStorage. A real Redis test runs jobs from two sellers and verifies that worker restart/redelivery preserves the completed outputs.

Artwork-first jobs retain separate original designs; legacy jobs can still supply flattened product images. Deterministic pixel-accurate rendering and automatic watermark/fidelity detection are not claimed. Human quality acceptance remains required.

## G5 — operational UI and release preparation

Dashboard metrics use Mongo aggregation against currently authorized Stores, counting actual idea/run/output/review states. Work counts and image counts are distinct; revocation applies before aggregation. Output pagination joins authorized parent jobs instead of truncating the source to the latest 1,000 jobs. An index supports the parent-ID lookups.

The administrator library has server-side search by name/code, type/Team filters and pagination. Wizard product/skill/master pickers and mockup product/scene pickers use the paginated catalog, resolve saved selections explicitly and are not restricted to the bootstrap resource slice. Organization bootstrap remains bounded for initial navigation; this is not an unlimited organization-directory claim.

Admin can version products/masters/scenes, including product-specific print settings. Earlier resources and approved snapshots remain unchanged; cloned scene assets retain valid encryption ownership by creating a new encrypted asset. Version history is visible. Review decisions are written to the existing company audit stream. The guide includes accessible vector illustrations distinguishing original artwork, source/target roles and the end-to-end approval flow; no mock metrics are rendered as production evidence.

The production backup CLI now quarantines unfinished Studio tickets/plans/image slots/mockup jobs on restore, preserves completed outputs and held costs, revokes sessions and pauses paid work. Approved ideas are returned for review so the outbox cannot silently recreate a scheduled job. An isolated rehearsal restores the actual encrypted archive, original skill GridFS bytes, schedule settings and Team ledger, then boots the real Studio module to verify additive index initialization. Current-schema indexes are used; older/different index definitions require explicit compatibility review rather than automatic deletion.

Disabled Studio handlers return without submitting AI, including already delivered queue messages. The release/rollback and acceptance checklist is in [studio-v1-release.md](studio-v1-release.md). No production deployment or live provider acceptance was performed.

## Enable locally / release gates

API: `STUDIO_ENABLED=true`. Frontend: `VITE_STUDIO_ENABLED=true` selects Studio as the default landing page; `/#studio` is its explicit route. `/#agent` retains the old assistant. Both build/runtime flags default off; no local secret file was changed because its Mongo connection is not verified as a local database.

`STUDIO_SCHEDULER_ENABLED=false` must remain off until cost rules, operational checks and a real 22:00 acceptance test are complete. With the flag off, new nightly approvals are rejected, and existing nightly selections are not dispatched. Run acceptance tests using a separate Mongo database/Redis prefix/R2 prefix, not the live database. When rolling out, update API and worker together before enabling Studio dispatch, so older consumers do not receive the new task kind.

For isolated tests use `npm run test:e2e -- --runInBand studio.e2e-spec.ts` and `npm test -- --runInBand skill-bundle.spec.ts`; the tests create/dispose a temporary MongoDB and mock external AI/R2/queue delivery. They do not use `.env` keys or spend provider credits. Frontend: `npm run test:e2e -- studio.spec.ts` uses mocked API responses.

## Remaining before the full V1 is ready

1. **Company acceptance**: representative samples and print specifications from the actual admin-configured catalog. There is no fixed five-product requirement. Verify text, color, print detail, transparency, geometry and watermarks with the intended providers.
2. **Operational acceptance**: observe the selected daily time in a real controlled run, reconcile actual provider credits/pricing and size load on the target server. Real Redis recovery tests do not establish infrastructure HA or provider idempotency.
3. **Release**: review the isolated restore evidence against the production configuration, record the maintenance backup and compatible rollback revision, then perform a coordinated rollout only when requested. Feature flags remain disabled by default; code checks are not a declaration of production readiness.

No automatic promotion of AI output to production-ready, no pixel-perfect claim and no arbitrary code execution from uploaded skills.

## Verified at this checkpoint

- API unit suite: 26 suites / 192 tests passed, including configurable UTC+7 times and artwork dimensions/DPI/alpha checks.
- Additional native provider contract test passed: final Studio prompt and ordered source/master images are forwarded verbatim without the old transfer wrapper.
- API integration regression: 78 tests passed across Studio, Team budget, legacy Agent, Workspace, credit pricing, real module wiring and backup restore. Studio covers 29 scenarios, including artwork dependencies, transparency, arbitrary product versions, catalog/Store scope and shared input access. Six Team budget scenarios cover final-credit admission and repair.
- Real isolated Redis/Mongo: two integration scenarios passed with open-handle detection, covering artwork-first scheduled dispatch and Team mockups across worker restart without duplicate completed AI calls.
- Additional production module-graph smoke: 1 test passed, boots actual Studio/Agent/AI/identity wiring with isolated external dependencies.
- Studio browser checks: 23 scenarios passed, including server metrics, illustrated mobile guide, arbitrary products/print settings, version editing, catalog search/pagination, separate artwork review and selecting scenes beyond bootstrap. Critical legacy root-auth/session/prompt/export regression checks also passed.
- Legacy browser regression subset: root authentication, session restoration, default legacy workspace/asset reuse/export, edited prompt/model lock/history/export passed.
- Screenshot review at 1440px and 390px: main page scroll and content fit confirmed. These screenshots use test fixtures, not production metrics.
- Imported the supplied SK02 v2.2 ZIP into an isolated temporary MongoDB with in-memory R2 substitute: 25 file entries, 16 stored context images, 1 master, 5 active instruction documents (including SKILL.md), declared version `2.2-creative-approved`, ready/pending approval, no dependency issues, original ZIP restored byte-for-byte. SHA-256 `75e577322d091c42941625b55aab89e0af4eb8f853c0e25df58d893b302291c1`. No paid model calls or production imports.


## 2026-11-02 — local audit corrections

- Admin diagnostics canonicalizes the configured log root before validating day/file paths. macOS parent aliases are supported; linked day directories/journal files remain rejected and `O_NOFOLLOW` remains in use.
- Budget/provider-routing test fixtures now preserve provider literal types and model-bearing mock arguments, allowing whole-repository TypeScript checks without weakening assertions. `npm run typecheck` is also required by CI so transpile-only tests cannot hide these errors again.
- Image deadlines default to 300 seconds; explicit deployed environment settings are unchanged. Unknown outcomes remain held for reconciliation, without paid retries or automatic model substitution.
- New artwork prompts distinguish printable content from physical product/material/master-photo instructions. New reference mockups/thumbnails explicitly preserve the target's original style, canvas, lighting and surroundings. Existing immutable slot prompts/results are retained.
- The artwork review UI now names physical borders, stitching, shadows and external white margins as rejection criteria. File dimensions/DPI remain technical checks only; no extra paid validator or claim of automatic print acceptance was added.

These changes address deterministic audit failures and strengthen generation/review instructions. Real output quality and the timed-out production model still require a controlled provider recheck; mock/unit/static success does not establish those outcomes. No production environment or data was changed.
