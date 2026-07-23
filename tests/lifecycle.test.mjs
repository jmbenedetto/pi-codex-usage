import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fakeContext(modelId) {
  let disposed = false;
  let modelReadsAfterDisposal = 0;
  const statusValues = [];

  const ctx = {
    hasUI: true,
    get model() {
      if (disposed) modelReadsAfterDisposal++;
      return { id: modelId };
    },
    ui: {
      notify() {},
      setStatus(_id, value) {
        statusValues.push(value);
      },
      theme: {
        fg(_color, value) {
          return value;
        },
      },
    },
  };

  return {
    ctx,
    dispose() {
      disposed = true;
    },
    modelReadsAfterDisposal() {
      return modelReadsAfterDisposal;
    },
    statusValues,
  };
}

test("shutdown/reload ignores stale startup refresh after preferences finish loading", async () => {
  const handlers = new Map();
  const pi = {
    on(event, handler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    registerCommand() {},
  };

  const originalReadFile = fs.readFile;
  let readCount = 0;
  let resolvePendingSettings;
  const pendingSettings = new Promise((resolve) => {
    resolvePendingSettings = resolve;
  });

  fs.readFile = async () => {
    readCount++;
    if (readCount === 1) return pendingSettings;
    const error = new Error("not found");
    error.code = "ENOENT";
    throw error;
  };

  const oldSession = fakeContext("old-model");
  const newSession = fakeContext("new-model");

  try {
    const jiti = createJiti(import.meta.url, { moduleCache: false });
    const imported = await jiti.import("../extensions/codex-usage-status.ts");
    const register = imported.default ?? imported;
    register(pi);

    const start = handlers.get("session_start")[0];
    const shutdown = handlers.get("session_shutdown")[0];

    start({}, oldSession.ctx);
    await waitFor(() => readCount === 1, "old session did not begin loading preferences");

    oldSession.dispose();
    shutdown({}, oldSession.ctx);
    start({}, newSession.ctx);
    resolvePendingSettings("{}");

    await waitFor(() => newSession.statusValues.length > 0, "new session did not complete its refresh");

    assert.equal(
      oldSession.modelReadsAfterDisposal(),
      0,
      "stale startup work read the disposed session model after shutdown",
    );
    assert.deepEqual(
      oldSession.statusValues,
      [undefined],
      "the old session should only receive the shutdown status clear",
    );

    shutdown({}, newSession.ctx);
  } finally {
    fs.readFile = originalReadFile;
  }
});
