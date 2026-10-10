# Business agents and model routing

`npm start` loads the non-secret defaults in `deployment/business.env`, enabling the native router and business-agent preparation for this fork. Coolify runtime variables take precedence; set `MODEL_ROUTER_ENABLED=false` or `PREPARE_BUSINESS_AGENTS=false` to disable either feature. Add `OPENROUTER_API_KEY`, `TYPESAFE_API_KEY` (optional), and the existing required `CPK_INTELLIGENCE_API_KEY`. Keep the owner token, owner ID and persistent SQLite volume unchanged. Never commit real keys or put them in frontend/build variables.

This deployment uses a native OpenDots policy router and OpenRouter directly. LiteLLM/PostgreSQL are not required or installed. A future gateway can add accounting and broader provider support; do not claim that its budget enforcement exists here.

## Agents

| Agent                  | Space            | Automatic routing                                                                                 |
| ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| VYANIS Assistant HIBA  | VYANIS · HIBA    | Routine drafting → routine; proposals, strategy → reasoning; commercial risk → expert             |
| VIGON Presale engineer | VIGON · Presales | Reasoning minimum; uncertain/technical/compliance/pricing work → expert                           |
| VIGON Sales Assistant  | VIGON · Sales    | Routine correspondence → routine; qualification/proposals → reasoning; pricing/contracts → expert |

Startup creates these only once and preserves owner edits. Global memory is disabled on these profiles because upstream OpenDots memories are shared. Use authorized Space pages for dated, sourced context. Each agent initially has access only to its own Space. Spaces separate agent tool access, not human accounts: this remains a single-owner application.

Reusable instructions have been adapted from the owner's established workflows. Old chats, private client documents, local scripts, connectors, learning containers, computer runtimes and browser sessions are **not** automatically migrated. Upload only the reviewed reference materials each agent needs into its Space. VIGON buying prices and margins belong to the internal Presales Space, never client-facing packs or Sales by default. Commercial publication and sending require explicit approval.

## Routing behavior

Every conversation exposes Auto, Economical, Best quality and Specific model. Preferences are persisted server-side. Manual model IDs are restricted to the server-configured allowlist. Manual selection overrides Auto, and provider failure never silently changes models. Switch modes/models explicitly to retry. OpenRouter can choose a different hosting provider for the same model; requests require parameter support and disallow provider data collection.

Auto evaluates the recent user requests. Deterministic high-consequence rules run first. Jev receives at most 6,000 characters and the profile identifier for ambiguous work; confidence below 0.8, timeout or malformed output falls back to the conservative agent default. Presales cannot be downgraded below reasoning in Auto. Jev is a classifier, not the chat model and never grants tools or permissions.

Initial model IDs were checked against OpenRouter's catalog on 2026-10-10: routine `google/gemini-3.8-flash`, reasoning `anthropic/claude-sonnet-5.5`, expert `anthropic/claude-opus-5.5`. These are initial candidates, not an accuracy guarantee; benchmark on reviewed HIBA/presales/sales examples before relying on outputs. Override using `ROUTER_MODEL_ROUTINE`, `ROUTER_MODEL_REASONING`, `ROUTER_MODEL_EXPERT`.

The UI reports the last **selected** model and the reason, not a provider-confirmed receipt or billing record. Text/compute routing also applies to scheduled and voice-compute turns through DotAgent. Realtime speech uses the separate voice provider.

## Limits and validation

`ROUTER_DAILY_TURN_LIMIT` defaults to 100 attempted turns per agent per UTC day, persisted atomically in SQLite. Failed attempts count. Per model call output limits: routine 3,000, reasoning 6,000, expert 10,000 tokens. Existing turn time and tool-loop limits remain. These are operational limits, **not currency budgets**. Set a spending limit on the OpenRouter key and TypeSafe account before production usage. Input tokens, repeated tool calls, retries and Jev usage still incur provider costs. Native accounting, billing alerts and automatic retry on another model are not implemented.

Deploy, then verify Settings shows the configured providers. Create a conversation and test Auto, explicit model pinning across reload, a tool-assisted draft, unavailable-provider errors and cross-Space denial using non-sensitive examples. Configuration presence alone does not verify provider authentication.

References: [TypeSafe API](https://docs.typesafe.ai/api), [OpenRouter API](https://openrouter.ai/docs/api_reference/overview), [OpenRouter model catalog](https://openrouter.ai/api/v1/models).
