# Optional structured responses

OpenDots retains its existing chat, CopilotKit transport, agents, tools and Intelligence conversation history. No database migration or new service is required. Structured OpenUI uses the official Thesys `@openuidev/react-lang` renderer; it is distinct from CopilotKit Open Generative UI.

In a web conversation, enable **Interactive responses (optional)**, then ask for a comparison, metrics, chart or form. When enabled, structured answers such as pipeline summaries, deal status views, comparisons and metrics should use an OpenUI card without requiring the user to repeat “interactive” in the prompt. Simple conversational messages and explicit plain-text requests remain Markdown. This switch starts off and resets on conversation change or reload. To view a saved structured response after reconnecting, enable it again. The original fenced `openui` text remains in the original message and is always available with **View source** or by disabling interactive responses. Exports retain that original source.

Choices prepare a message in the existing composer, including the current form values. Review/edit it and press Send to run the same Dot in the same conversation. Existing typed text, source links and attachments are retained. A choice is not an approval receipt. Connection/page approvals continue through their existing dedicated controls. Unsubmitted form edits are local, ephemeral and reset on reload; submitted values are recorded as part of the normal user message.

## Controls

- Set `OPENUI_ENABLED=false` and restart to disable the capability server-side. The authenticated session response then hides the switch and the agent ignores the versioned request flag. Defaults permit the capability; each web chat still requires explicit opt-in.
- The server adds UI instructions only for a web request with `forwardedProps.openui === 1`. It never accepts client-supplied UI prompts or tool definitions. Slack, voice and scheduled turns do not opt in.
- Before the official renderer receives content, the app validates and normalizes a restricted literal grammar with at most 24 flat components and 24,000 characters. Allowed components are Panel, Text, Metric, Table, BarChart, Choice, Input and Select. Table/chart/form sizes and values are bounded. Cycles, duplicate references, unknown components, hidden expressions, Query/Mutation, HTML execution, URLs and tool providers are excluded. Text is escaped by React. OpenUI observability publication is disabled.
- UI actions are restricted to known choice labels and declared form fields. Hidden event parameters are discarded. Streaming, paused, unloaded and voice-active chats cannot prepare actions. The ordinary Send path retains authenticated transport, origin protection, member/Space/thread validation, budgets, permission checks and human review. A synchronous send latch prevents duplicate simultaneous submissions.
- Invalid/incomplete content and renderer failures show the original text. There is no automatic model retry or additional paid request.

## Verification

Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run check-format`, and `npm run build` with Node 24. OpenUI tests use the actual installed parser/renderer, not a mock renderer. They cover supported components, HTML escaping, rejected execution syntax, bad references, size bounds, action validation, form edits, disabled actions, and legacy/user-message fallback. Runtime tests verify opt-in prompt selection and server disabling.

For a deployed smoke test, use a dedicated test conversation: enable interactive responses, request a small illustrative comparison and form, edit a field, click a choice, verify nothing runs until Send, and verify the answer stays in that conversation. Reload and enable the switch again to check history rendering; disable it to check source fallback. Verify a prior conversation and existing tool cards still load. Do not interpret local fixture tests as proof of live model generation.

Rollback: set the capability to false or revert the integration commit and redeploy. Keep existing owner/member credentials, owner ID, Intelligence project and persistent volumes unchanged. No history conversion or cleanup is needed.

References: [OpenUI CopilotKit integration](https://www.openui.com/docs/build-agents/copilotkit), [renderer](https://www.openui.com/docs/openui-lang/renderer), [actions](https://www.openui.com/docs/openui-lang/interactivity).
