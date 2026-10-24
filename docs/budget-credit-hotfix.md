# Production budget configuration

The October 24 planning failure (`BUDGET_PRICING_UNAVAILABLE`) occurred before an AI call: the company budget policy had no model prices. It was not an R2 upload error.

The company selected **50 ShopAIKey credits per account per week**, with the existing Monday 00:00 UTC+7 reset. This is provider credit, not cash USD. The API now returns `currency: CREDIT`; existing numeric field names ending in `Usd` remain for compatibility and use the policy's unit. Reported cash-USD costs are ignored in credit mode in favor of verified model rates.

Initial currency selection requires an empty pricing policy and no usage history. Subsequent currency changes are rejected to protect historical accounting. Pricing updates remain admin-only, audited and guarded by `updatedAt`.

Apply only the prices for the API key's assigned groups. Public ShopAIKey `/pricing` amounts already include the group ratio; do not multiply it again. Fixed-request models use one request fee; token-priced models require both input and output rates. A reservation is a temporary hold, not the final charge. Unresolved billing continues to require reconciliation rather than an automatic retry.

VyceAI text models without verified health/text pricing are skipped before any paid health probe. The existing ShopAIKey text fallback then applies. Budget exhaustion and unresolved billing still stop execution.

The client displays credits throughout employee budgets and admin price forms. Regression coverage includes credit settlement, cash-cost isolation, initial currency selection, missing pricing, exhausted limits and unpriced text fallback. Deploy API and client before selecting credit accounting. Failed user jobs are not replayed automatically.
