# Business agents and cost-aware model routing

`npm start` loads non-secret `deployment/business.env` defaults. Runtime variables take precedence. Keys (`OPENROUTER_API_KEY`, optional `TYPESAFE_API_KEY`, existing `CPK_INTELLIGENCE_API_KEY`) stay on the server. Preserve the owner identity/token and SQLite volume. This is a single-owner application; Spaces separate agent access, not human accounts.

HIBA, VIGON Presales and VIGON Sales retain separate Spaces, migrated knowledge and owner instructions. Routing depends on the current task, never a permanently expensive agent profile. A greeting in Presales uses the same inexpensive path as a greeting in Sales. Existing permissions and publication requirements remain unchanged.

## Seven stages

These are selection stages, not seven paid calls for every request.

| Stage | Role                                                       | Default                     |
| ----- | ---------------------------------------------------------- | --------------------------- |
| 0     | Deterministic validation, routing rules and file rendering | Local code; no model charge |
| 1     | Classification, triage and sorting                         | Jev typed decisions         |
| 2     | Short daily drafting, translation, summaries               | Qwen3.8 Flash               |
| 3     | Ordinary tool use and research                             | GLM-5.3 Flash               |
| 4     | Multi-step analysis and document plans                     | DeepSeek V4 Pro             |
| 5     | Explicit premium reasoning choice                          | GPT-6.1 Sol                 |
| 6     | Explicit expert/second-opinion choice                      | Claude Sonnet 5.5           |

Auto uses stages 2–4, preceded only when necessary by Jev. Local simple-task rules bypass Jev. Ambiguous tasks default to GLM, not Claude. Technical/document tasks use inexpensive reasoning. Jev receives at most 4,000 characters, needs confidence >=0.9, and cannot select a premium tier. Invalid, unavailable or uncertain Jev responses retain the bounded local fallback. A routing judgment never grants tools or permissions. Premium mode explicitly chooses GPT; Specific model can pin any approved model. There is no silent model fallback or automatic premium escalation.

`Classify directly with Jev` in each chat accepts 1–20 short items and 2–8 categories. It calls Jev once without an LLM, groups the returned suggestions, and flags confidence below 0.9. `classify_with_jev` is also available to agents for natural-language triage requests. Neither path executes actions based on classifications.

The five model IDs and input/vision/tool support were checked against the [OpenRouter catalog](https://openrouter.ai/api/v1/models) on 2026-10-10. Quality on these business tasks has not yet been evaluated with paid production calls. Price ceilings in `modelRates` must be reviewed when adding a model. All requests retain the no-data-collection policy and required parameter support, prefer cheaper providers, and enforce provider `max_price`. Missing compatible providers cause a visible failure; protections are not relaxed.

Use `ROUTER_V2_MODEL_ROUTINE`, `STANDARD`, `REASONING`, `COMPLEX`, `EXPERT` and `ROUTER_V2_REVIEW_MODEL`. Legacy `ROUTER_MODEL_*` and, when routing is enabled, `DOCUMENT_REVIEW_MODEL` are intentionally ignored so old Claude defaults cannot silently defeat the cheaper policy. Opus is removed from the default allowlist; old manual pins require a new choice.

## Cost controls

Initial defaults: $1/workspace/day, $0.50/Dot/day, $0.20/request, 12 provider calls/request and 100 turn attempts/Dot/day, in UTC. Configure `ROUTER_DAILY_USD`, `ROUTER_DOT_DAILY_USD`, `ROUTER_TURN_USD`, `ROUTER_MAX_CALLS`, `ROUTER_DAILY_TURN_LIMIT`. A request encompasses all its model iterations, Jev routing and document visual-review calls. Manual premium choices cannot bypass the budgets. SDK retries are disabled.

SQLite atomically reserves a conservative maximum before each provider call. Provider-reported `usage.cost` settles each reservation once; absent usage, aborted streams and uncertain failures retain their reservation rather than counting as free. UTF-8 size plus framing and image allowances bound estimates; provider price ceilings prevent a more expensive host from invalidating them. These controls are intentionally conservative and can reject a request below its eventual billed cost. Provider invoices remain authoritative; use a provider-side key cap as an independent backstop. Historical charges before deployment are not backfilled into the local ledger. External search, computer hosting, CopilotKit services and realtime speech fees are outside this model ledger.

The UI shows reported and reserved/unconfirmed amounts separately. The recorded selected model is a routing decision, not proof of a completed provider response. Budget errors stop before the next provider request; existing saved files remain available.

Only four recent complete user-turn groups (soft 90,000-character limit) enter model context. Tool calls remain with their results. Older messages remain saved; agents must retrieve missing facts from authorized history/knowledge. Any single model context above 200,000 text bytes is refused rather than silently truncated. Normal response ceilings are 2k/4k/8k by tier; document plans get 20k. Normal agent loops allow 3–6 rounds; document work up to 12, within the same dollar budget and ten-minute deadline.

Document visual review defaults to Qwen3.8 Flash and remains source-image based. Changing the model does not waive rendering, template preservation, ownership checks or honest review status.

References: [TypeSafe typed decisions](https://docs.typesafe.ai/introduction), [OpenRouter provider price ceilings](https://openrouter.ai/docs/guides/routing/provider-selection#max-price), [OpenAI model selection](https://developers.openai.com/api/docs/models).

### Context efficiency and administrator usage

OpenDots keeps stable role/tool instructions before changing time, page and task context. Requests carry a hashed per-Dot/per-conversation OpenRouter session identifier for provider affinity. Claude receives a cache breakpoint on the stable system message; other selected models use their provider's supported implicit caching. Unsupported explicit Qwen cache flags are not forced. Reservations include a 25% input cache-write allowance; cache hits and savings are never assumed.

When memory is enabled, original user requests are retained in SQLite per conversation. Agents can save a structured working checkpoint (goal, constraints, decisions, open questions, next steps, source references), search prior requests, and read their exact paginated text. Checkpoints are model-written working notes, not authoritative approval or replacements for source files. Relevant prior requests and imported knowledge snippets are selected locally before inference. The last four complete user-turn groups remain in immediate context, together with the checkpoint for substantive work. Owner-saved preferences and role instructions remain intact. Skills and exact prices/specifications must be read from their original sources. File and Drive retrieval continue through the existing authorized file tools. Disabling memory prevents this context from being read or updated; it does not delete previously saved records. No lossy token compressor or paid external memory service is introduced.

The **AI consumption → Admin only** panel appears below Model routing in conversations and Settings. It refreshes every two seconds while expanded and the browser is visible. It shows UTC daily workspace totals, budgets, reported input/output/cache tokens, and the latest 200 model calls with agent, conversation, lifecycle state and cost. Reservations are shown separately from provider-reported charges, and missing usage is unknown rather than zero. A completed call can still have an unconfirmed charge. Older costs remain visible but token details start with this release. Voice audio and external service fees are not included.

`GET /api/admin/usage` and all member-management routes require the configured `OWNER_TOKEN`; anonymous local development does not grant admin access. General routing responses do not include spending totals. The existing owner credential remains the administrator credential.

In **Settings → Member access**, create a named member, select agents and Spaces, then share their one-time-displayed access code privately. Codes are randomly generated and stored only as SHA-256 hashes; the optional email is a contact label, not a verified email login. Replacing a code invalidates the previous code. Unchecking Access active revokes requests and stops active agent work on its next permission check. No email is sent automatically.

Member requests run under a separate identity, including CopilotKit Intelligence. Each member has private conversations and task checkpoints. Agent Space access is intersected with the member’s grants, with permission checks in routes and agent tools. Shared pages/files/knowledge in explicitly granted Spaces are accessible; owner global memories and conversations are not. The owner can grant a member no agents initially. Configuration, scheduling, account connections, Google OAuth/picker tokens, shared computers, voice, usage and membership management are owner-only. Members can upload local files, work with allowed stored files/pages, and chat with assigned agents; provider secrets never leave the server. All members share the existing workspace/Dot model budgets.
