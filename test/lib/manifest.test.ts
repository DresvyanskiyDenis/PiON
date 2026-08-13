import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  absentModules,
  apiInventory,
  DECLARED_MODULES,
  declareModule,
  eventInventory,
  failedModules,
  loadedModules,
  manifestReport,
  moduleStatus,
  recordHeartbeat,
  recordLoad,
  recordLoadFailure,
  resetManifest,
  silentModules,
  undeclaredModules,
} from "../../extensions/lib/manifest.ts";

describe("manifest — the load registry", () => {
  beforeEach(() => resetManifest());

  it("a fresh registry reports every declared module as expected-but-absent", () => {
    assert.deepEqual(loadedModules(), []);
    assert.deepEqual(absentModules(), [...DECLARED_MODULES]);
    assert.deepEqual(failedModules(), []);
  });

  it("recordLoad moves a module out of the absent report", () => {
    recordLoad("guard");
    assert.deepEqual(loadedModules(), ["guard"]);
    assert.equal(absentModules().includes("guard"), false);
    assert.equal(moduleStatus("guard").state, "loaded");
  });

  it("recordLoadFailure keeps the error text and names the module", () => {
    recordLoadFailure("trust", new TypeError("cannot read x of undefined"));
    assert.deepEqual(failedModules(), [["trust", "TypeError: cannot read x of undefined"]]);
    assert.equal(moduleStatus("trust").state, "failed");
    assert.equal(moduleStatus("trust").error, "TypeError: cannot read x of undefined");
    assert.equal(
      absentModules().includes("trust"),
      false,
      "a module that failed is not absent — the two need different fixes",
    );
  });

  it("a non-Error throw is still reported", () => {
    recordLoadFailure("web", "boom");
    assert.deepEqual(failedModules(), [["web", "boom"]]);
  });

  it("a module that loads after a failure is no longer reported as failed", () => {
    recordLoadFailure("bash", new Error("first try"));
    recordLoad("bash");
    assert.deepEqual(failedModules(), []);
    assert.deepEqual(loadedModules(), ["bash"]);
  });

  it("loadedModules keeps DECLARED_MODULES order, not insertion order", () => {
    recordLoad("doctor");
    recordLoad("guard");
    assert.deepEqual(loadedModules(), ["guard", "doctor"]);
  });

  it("D-05: all seven loaded means loadedModules() equals DECLARED_MODULES", () => {
    for (const id of DECLARED_MODULES) recordLoad(id);
    assert.deepEqual(loadedModules(), [...DECLARED_MODULES]);
    assert.deepEqual(absentModules(), []);
  });

  it("a module registering under an undeclared id is reported, not ignored", () => {
    recordLoad("frobnicate");
    assert.deepEqual(undeclaredModules(), ["frobnicate"]);
    assert.equal(loadedModules().includes("frobnicate" as never), false);
    assert.equal(moduleStatus("frobnicate").declared, false);
  });

  it("the deadman: loaded but never seen at session_start is silent, not absent", () => {
    recordLoad("guard");
    recordLoad("trust");
    recordHeartbeat("guard");
    assert.deepEqual(silentModules(), ["trust"]);
    assert.equal(moduleStatus("guard").heartbeat, true);
    assert.equal(moduleStatus("trust").heartbeat, false);
  });

  it("declareModule implies a heartbeat and records version, events and apis", () => {
    recordLoad("guard");
    declareModule({
      id: "guard",
      version: "1.0.0",
      events: ["tool_call", "session_start"],
      apis: ["on", "appendEntry"],
    });
    const st = moduleStatus("guard");
    assert.equal(st.version, "1.0.0");
    assert.equal(st.heartbeat, true);
    assert.deepEqual(st.events, ["tool_call", "session_start"]);
    assert.deepEqual(silentModules(), []);
  });

  it("EXT-31: the event and api inventories are deduped and sorted", () => {
    declareModule({ id: "guard", version: "1", events: ["tool_call"], apis: ["on", "appendEntry"] });
    declareModule({ id: "bash", version: "1", events: ["tool_call", "user_bash"], apis: ["on", "exec"] });
    assert.deepEqual(eventInventory(), ["tool_call", "user_bash"]);
    assert.deepEqual(apiInventory(), ["appendEntry", "exec", "on"]);
  });

  it("EXT-10: the report separates loaded, failed, absent, undeclared and silent", () => {
    recordLoad("guard");
    declareModule({ id: "guard", version: "1", events: [], apis: [] });
    recordLoad("trust");
    recordLoadFailure("web", new Error("bad regex"));
    recordLoad("bolt-on");

    const r = manifestReport();
    assert.deepEqual(r.declared, [...DECLARED_MODULES]);
    assert.deepEqual(r.loaded, ["guard", "trust"]);
    assert.deepEqual(r.failed, [["web", "Error: bad regex"]]);
    // Derived, not hardcoded: DECLARED_MODULES grows every time a module joins the composition
    // root's ORDER, and a literal list here rots into a false failure on the next module.
    // What this asserts is the *rule* — absent == declared minus loaded minus failed.
    assert.deepEqual(
      r.absent,
      DECLARED_MODULES.filter((id) => !["guard", "trust", "web"].includes(id)),
    );
    assert.deepEqual(r.undeclared, ["bolt-on"]);
    assert.deepEqual(r.silent, ["trust", "bolt-on"]);
    assert.equal(r.modules.length, DECLARED_MODULES.length + 1);
  });

  it("the report is a snapshot, not a live view", () => {
    recordLoad("guard");
    const first = manifestReport();
    recordLoad("trust");
    assert.deepEqual(first.loaded, ["guard"]);
    assert.deepEqual(manifestReport().loaded, ["guard", "trust"]);
  });
});

describe("manifest — path reconciliation", () => {
  it("extensions/manifest.ts and extensions/lib/manifest.ts are the same registry", async () => {
    resetManifest();
    const shim = await import("../../extensions/manifest.ts");
    shim.recordLoad("credentials");
    assert.deepEqual(
      loadedModules(),
      ["credentials"],
      "two module instances would make index.ts record loads that /doctor never sees",
    );
  });
});
