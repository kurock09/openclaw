import { describe, expect, it } from "vitest";
import { buildEmbeddedRunQueueWaitWarning } from "./pi-embedded-runner/run-queue-wait.js";

describe("embedded run queue wait warning", () => {
  it("reports the default main-lane active-turn ceiling", () => {
    const warning = buildEmbeddedRunQueueWaitWarning({
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "agent:main:web-1",
      globalLane: "main",
      waitedMs: 2400,
      queuedAhead: 3,
    });

    expect(warning).toContain("[throughput-backpressure]");
    expect(warning).toContain("lane=main");
    expect(warning).toContain("waitedMs=2400");
    expect(warning).toContain("queuedAhead=3");
    expect(warning).toContain("maxConcurrent=4");
    expect(warning).toContain("run=run-1");
    expect(warning).toContain("session=session-1");
    expect(warning).toContain("sessionKey=agent:main:web-1");
  });

  it("uses configured subagent concurrency when the wait is on the subagent lane", () => {
    const warning = buildEmbeddedRunQueueWaitWarning({
      runId: "run-2",
      sessionId: "session-2",
      globalLane: "subagent",
      waitedMs: 3100,
      queuedAhead: 1,
      config: {
        agents: {
          defaults: {
            subagents: {
              maxConcurrent: 3,
            },
          },
        },
      },
    });

    expect(warning).toContain("lane=subagent");
    expect(warning).toContain("maxConcurrent=3");
    expect(warning).not.toContain("sessionKey=");
  });
});
