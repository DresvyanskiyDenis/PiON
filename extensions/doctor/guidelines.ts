/**
 * `D-10`'s ledger: what became of every tool `promptGuidelines` bullet once this configuration
 * supplied its own system prompt.
 *
 * ## The condition being watched
 *
 * `SYSTEM.md` at the repo root is PI's `customPrompt`. `buildSystemPrompt` returns early on that
 * branch: the `Available tools:` summary and the **whole `Guidelines:` section** are never built.
 * Project context files, the skills catalogue and the `cwd` line still append; the guidelines do
 * not.
 *
 * `Guidelines:` is the only place a tool's `promptGuidelines` array reaches the model. Replacing
 * the base prompt therefore discards every one of them at once — PI's own `read`/`write`/`edit`/
 * `bash`, every adopted package's, and every tool this repo registers. Losing the tools summary is
 * harmless, because the full tool schemas still travel with the request. Losing the guidelines is
 * not, and `SYSTEM.md` restates the ones that earn the space in its own words.
 *
 * What no one can restate is a guideline that does not exist yet. Install a package next month, or
 * take a routine version bump, and any new bullet it ships vanishes on arrival with nothing said.
 * That is a silent, accumulating loss, which is the failure mode this configuration refuses
 * everywhere else.
 *
 * So every live guideline is given a **disposition** here, and `D-10` warns about any that has
 * none — or whose text has moved on from what was recorded.
 *
 * ## Read this before adding a row
 *
 * `"dropped"` is an ordinary, expected value. A row states *what happened to* a bullet; it is not
 * a claim that the bullet survived and it is not a way to silence the check. Recording
 * `"system-prompt"` for something `SYSTEM.md` does not actually say is the single change that
 * would make this file worse than having none.
 *
 * ## Answering a `D-10` warning
 *
 * The finding names `tool:index` and quotes the text. Read it, decide which of the four
 * dispositions is true, and add the row — or restate the guideline in `SYSTEM.md` first and then
 * record `"system-prompt"`. Rows whose tool is not registered here are inert and are never
 * reported: a check that complains about a package you do not install is noise, and a stale row
 * costs one line.
 */

/** Where a guideline's substance lives now that `Guidelines:` is never rendered. */
export type GuidelineDisposition =
  /** Restated in `SYSTEM.md`, in its own words. */
  | "system-prompt"
  /** Carried by the tool's own `description` or its parameter-schema descriptions. Both travel
   *  inside the tool definition, so `customPrompt` does not touch them. */
  | "tool-contract"
  /** Carried by some other deliberate mechanism, named in the row's group comment. */
  | "elsewhere"
  /** Deliberately let go, for the reason in the group comment. Recorded so the loss is auditable
   *  rather than invisible. */
  | "dropped";

/** `[disposition, marker]`. `marker` is a distinctive fragment of the guideline **as recorded**.
 *  `D-10` warns when the live text stops containing it, which is what turns a package quietly
 *  rewording a bullet into a visible event instead of a silent one. */
export type GuidelineAck = readonly [GuidelineDisposition, string];

/**
 * Keyed `"<tool name>:<index in promptGuidelines>"`.
 *
 * The index is the key because it is what `getAllTools()` hands over and what survives a copy
 * edit. The `marker` is what makes a copy edit visible.
 */
export const ACKNOWLEDGED_GUIDELINES: Readonly<Record<string, GuidelineAck>> = {
  // ---- PI's own read / write / edit --------------------------------------------------------
  // `SYSTEM.md` § "# Tools" carries all six: purpose-built tool before the shell equivalent,
  // `write` only for a new file or a top-to-bottom rewrite, and the full `edit` oldText
  // paragraph — matched against the file as it was, no overlap or nesting, no longer than
  // uniqueness requires, two entries in one call rather than one stretched across both.
  "read:0": ["system-prompt", "instead of cat or sed"],
  "write:0": ["system-prompt", "only for new files or complete rewrites"],
  "edit:0": ["system-prompt", "Use edit for precise changes"],
  "edit:1": ["system-prompt", "one edit call with multiple entries"],
  "edit:2": ["system-prompt", "matched against the original file"],
  "edit:3": ["system-prompt", "as small as possible while still being unique"],

  // ---- PI's own bash ------------------------------------------------------------------------
  // Present only when `exposeSessionEnvironment` is on. Dropped on purpose: the session-context
  // extension already injects the session facts a model would go hunting for, so sending it to
  // the shell to read `PI_*` costs a tool call and invites the two sources to disagree.
  "bash:0": ["dropped", "PI_* environment variables"],

  // ---- @juicesharp/rpiv-todo ----------------------------------------------------------------
  // Eight bullets ship. `SYSTEM.md` § "# Tools" restates the three about work discipline: when a
  // list is warranted, exactly one `in_progress` marked before starting, `completed` never while
  // the tests are red. The other five are call mechanics and already live in `TodoParamsSchema`'s
  // field descriptions — `status`, `activeForm`, `blockedBy`/`addBlockedBy`/`removeBlockedBy`,
  // `includeDeleted`, `subject`/`description` — which reach the model inside the tool definition.
  "todo:0": ["system-prompt", "for complex work with 3+ steps"],
  "todo:1": ["system-prompt", "mark it in_progress BEFORE beginning work"],
  "todo:2": ["system-prompt", "Never mark a task completed if tests are failing"],
  "todo:3": ["tool-contract", "4-state machine"],
  "todo:4": ["tool-contract", "call update with the task id"],
  "todo:5": ["tool-contract", "Use blockedBy to express dependencies"],
  "todo:6": ["tool-contract", "hides tombstoned"],
  "todo:7": ["tool-contract", "Subject must be short and imperative"],

  // ---- pi-subagents -------------------------------------------------------------------------
  // Kept out of `SYSTEM.md` deliberately: how to call `subagent` belongs to the tool, not to the
  // operator's doctrine, and the package supports a custom tool description
  // (`toolDescriptionMode`) that is the right home for it. `SYSTEM.md` § "# Keep bounded work in
  // your own hands" states the delegation boundary independently, which is the first sentence of
  // `subagent:0`; the remainder of that bullet is mechanics.
  "subagent:0": ["elsewhere", "only when delegation is needed"],
  "subagent:1": ["elsewhere", "Omit action for execution"],
  "subagent:2": ["elsewhere", "exactly one top-level subagent tool call"],
  "subagent:3": ["elsewhere", "resolves to an ordered array"],
  "subagent:4": ["elsewhere", "one writer per cwd/worktree"],
  "subagent:5": ["elsewhere", "copy an exact provider/id"],
  "subagent:6": ["elsewhere", "advanced scheduling, missions, steering"],

  // ---- @narumitw/pi-lsp ---------------------------------------------------------------------
  // Per-tool mechanics: each bullet names its own tool or its own parameter, and both tools carry
  // a description plus a described `server`/`kind` parameter. The third diagnostics bullet is
  // error etiquette with no home in the schema, and per-package error etiquette is not something
  // `SYSTEM.md` restates — so it is dropped, not covered.
  "lsp_diagnostics:0": ["tool-contract", "when files need diagnostics"],
  "lsp_diagnostics:1": ["tool-contract", "Use the server parameter only when"],
  "lsp_diagnostics:2": ["dropped", "report the configuration error"],
  "lsp_fix:0": ["tool-contract", "for files handled by a configured LSP"],
  "lsp_fix:1": ["tool-contract", "such as source.organizeImports"],

  // ---- pi-lean-ctx --------------------------------------------------------------------------
  // lean-ctx writes unusually long tool descriptions, and each of these is already stated inside
  // one: "Do NOT use ctx_shell to read files … use ctx_read instead", "Add mode=full to get
  // complete file content", "Pi's native edit tool is always available".
  "ctx_shell:0": ["tool-contract", "only for commands with side effects"],
  "ctx_read:0": ["tool-contract", "instead of cat or less"],
  "ctx_read:1": ["tool-contract", "mode=full"],
  "ctx_edit:0": ["tool-contract", "native edit is preferred"],
  "ctx_edit:1": ["tool-contract", "cache coherence matters"],

  // ---- pi-hermes-memory ---------------------------------------------------------------------
  // The package defaults to `memoryMode: "policy-only"` and injects its own memory policy into
  // context every session. That block, not `Guidelines:`, is where "when to reach for memory"
  // lives, and `customPrompt` does not touch it. The rest are call mechanics carried by each
  // tool's description and parameter schema.
  "memory:0": ["elsewhere", "proactively when the user corrects you"],
  "memory:1": ["elsewhere", "environment facts, project conventions"],
  "memory:2": ["elsewhere", "Do NOT use memory for temporary task state"],
  "memory:3": ["tool-contract", "target='failure' with category"],
  "memory_search:0": ["elsewhere", "beyond what is in the system prompt"],
  "memory_search:1": ["tool-contract", "project-specific memories or user preferences"],
  "memory_search:2": ["tool-contract", "with category filter"],
  // `sessionSearch.variant` defaults to `"legacy"`, which registers the two-bullet form. The
  // three-bullet `"anchors"` form is the same tool name with different guidelines and would warn.
  "session_search:0": ["tool-contract", "previous discussions or past work"],
  "session_search:1": ["tool-contract", "context from earlier sessions"],
  "skill_manage:0": ["dropped", "after completing complex tasks"],
  "skill_manage:1": ["tool-contract", "'create' to save a new reusable procedure"],
  "skill_manage:2": ["tool-contract", "Scope is required on create"],
  "skill_manage:3": ["tool-contract", "Prefer structured fields"],
  "skill_manage:4": ["tool-contract", "For patch, pass section plus"],
  "skill_manage:5": ["tool-contract", "Prefer 'update' for multi-section rewrites"],
  "skill_manage:6": ["tool-contract", "Use 'view' before patching"],
  "skill_manage:7": ["tool-contract", "only for durable, reusable procedures"],

  // ---- this repo's own tools ----------------------------------------------------------------
  // These were written beside the tools they describe and are already stated in those tools'
  // descriptions, which is why they were guidelines rather than prompt text in the first place.
  // The two `ask_user` exceptions are doctrine: `SYSTEM.md` § "# Argue first, build second" is
  // where "two readings that would produce materially different work are worth a question" lives,
  // and § "# Act" is where taking the conventional default instead of asking lives.
  "ask_user:0": ["system-prompt", "two readings that lead to materially different work"],
  "ask_user:1": ["system-prompt", "a choice with a conventional default"],
  "ask_user:2": ["tool-contract", "names the trade-off"],
  "ask_user:3": ["tool-contract", "up to four questions"],
  "ask_user:4": ["tool-contract", "A declined answer is an answer"],
  "web_answer:0": ["tool-contract", "call web_answer once instead of web_search"],
  "web_answer:1": ["tool-contract", "[n] markers back to the source list"],
  "web_answer:2": ["tool-contract", "SearXNG engine bang"],
  "expand_result:0": ["tool-contract", "instead of re-running the original tool"],
  "message_agent:0": ["tool-contract", "a message to an unknown name is refused"],
  "message_agent:1": ["tool-contract", "does not wait for an answer"],
  "message_agent:2": ["tool-contract", "target set to the sender's name"],
  "message_agent:3": ["tool-contract", "for peers you did not spawn"],
  "teammate:0": ["tool-contract", "only for multi-turn collaboration"],
  "teammate:1": ["tool-contract", "read a teammate's reply before sending"],
  "teammate:2": ["tool-contract", "UNDELIVERED produced nothing"],
  "teammate:3": ["tool-contract", "as soon as you are done with it"],
  "job:0": ["tool-contract", "longer than the bash timeout"],
  "job:1": ["tool-contract", "plain bash is cheaper"],
  "job:2": ["tool-contract", "find work started by an earlier session"],
  // Registered only inside a teammate child session, so these rows are inert in a parent's
  // `/doctor`. Kept because a child loads the same extensions, and the obligation is the opening
  // line of the tool's own description either way.
  "reply_to_lead:0": ["tool-contract", "before you stop"],
  "reply_to_lead:1": ["tool-contract", "prose outside it is not delivered"],
  "reply_to_lead:2": ["tool-contract", 'status="blocked"'],
};
