/**
 * The two sinks every gate needs and neither should invent.
 *
 * `guardedHandler` already audits a *block*. An *override* — a gate that matched and was then
 * unlocked by a written justification (`REQ-CTX-06`) — is not a block, so nothing upstream
 * records it. The acceptance tests require exactly one `guard.override`
 * entry per successful override, which is why the gates get their own audit handle.
 */
export interface GuardServices {
  /** `pi.appendEntry`. Never throws: the wrapper below swallows a broken sink. */
  readonly audit: (customType: string, data: unknown) => void;
  /** Always present. Defaults to stderr, because `ctx.ui.*` is a no-op under `-p`/`--mode json`. */
  readonly log: (line: string) => void;
}

export function defaultServices(partial?: Partial<GuardServices>): GuardServices {
  const log = partial?.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const audit = partial?.audit ?? (() => {});
  return {
    log,
    audit: (customType, data) => {
      try {
        audit(customType, data);
      } catch (err) {
        // An audit sink that throws must not change a verdict.
        log(`[pi-config] guard: audit sink failed for "${customType}": ${String(err)}`);
      }
    },
  };
}
