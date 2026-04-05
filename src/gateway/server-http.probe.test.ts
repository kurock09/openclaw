import { describe, expect, it } from "vitest";
import {
  AUTH_TOKEN,
  AUTH_NONE,
  createRequest,
  createResponse,
  dispatchRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";
import type { ReadinessChecker } from "./server/readiness.js";

function withEnv(env: NodeJS.ProcessEnv, run: () => Promise<void>) {
  const originalEnv = process.env;
  process.env = {
    ...originalEnv,
    ...env,
  };
  return run().finally(() => {
    process.env = originalEnv;
  });
}

describe("gateway probe endpoints", () => {
  it("returns detailed readiness payload for local /ready requests", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: true,
      failing: [],
      uptimeMs: 45_000,
    });

    await withGatewayServer({
      prefix: "probe-ready",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/ready" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(getBody())).toEqual({ ready: true, failing: [], uptimeMs: 45_000 });
      },
    });
  });

  it("returns only readiness state for unauthenticated remote /ready requests", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 8_000,
    });

    await withGatewayServer({
      prefix: "probe-not-ready",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({
          path: "/ready",
          remoteAddress: "10.0.0.8",
          host: "gateway.test",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({ ready: false });
      },
    });
  });

  it("returns detailed readiness payload for authenticated remote /ready requests", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 8_000,
    });

    await withGatewayServer({
      prefix: "probe-remote-authenticated",
      resolvedAuth: AUTH_TOKEN,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({
          path: "/ready",
          remoteAddress: "10.0.0.8",
          host: "gateway.test",
          authorization: "Bearer test-token",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({
          ready: false,
          failing: ["discord", "telegram"],
          uptimeMs: 8_000,
        });
      },
    });
  });

  it("returns typed internal error payload when readiness evaluation throws", async () => {
    const getReadiness: ReadinessChecker = () => {
      throw new Error("boom");
    };

    await withGatewayServer({
      prefix: "probe-throws",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/ready" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({ ready: false, failing: ["internal"], uptimeMs: 0 });
      },
    });
  });

  it("keeps /healthz shallow even when readiness checker reports failing channels", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord"],
      uptimeMs: 999,
    });

    await withGatewayServer({
      prefix: "probe-healthz-unaffected",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/healthz" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(getBody()).toBe(JSON.stringify({ ok: true, status: "live" }));
      },
    });
  });

  it("reflects readiness status on HEAD /readyz without a response body", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord"],
      uptimeMs: 5_000,
    });

    await withGatewayServer({
      prefix: "probe-readyz-head",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/readyz", method: "HEAD" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(getBody()).toBe("");
      },
    });
  });

  it("surfaces PersAI runtime cluster blockers on /ready when multi-replica mode is declared", async () => {
    await withEnv(
      {
        PERSAI_RUNTIME_READINESS_MODE: "multi_replica",
        PERSAI_RUNTIME_SPEC_STORE: "memory",
      },
      async () => {
        const getReadiness: ReadinessChecker = () => ({
          ready: false,
          failing: [
            "persai_runtime_spec_store_not_shared",
            "persai_runtime_session_store_not_cluster_proven",
            "persai_runtime_workspace_continuity_not_cluster_proven",
            "persai_runtime_session_ordering_process_local",
            "persai_runtime_multi_replica_session_not_supported",
          ],
          uptimeMs: 5_000,
        });

        await withGatewayServer({
          prefix: "probe-persai-runtime-multi-replica",
          resolvedAuth: AUTH_NONE,
          overrides: { getReadiness },
          run: async (server) => {
            const req = createRequest({ path: "/ready" });
            const { res, getBody } = createResponse();
            await dispatchRequest(server, req, res);

            expect(res.statusCode).toBe(503);
            expect(JSON.parse(getBody())).toEqual({
              ready: false,
              failing: [
                "persai_runtime_spec_store_not_shared",
                "persai_runtime_session_store_not_cluster_proven",
                "persai_runtime_workspace_continuity_not_cluster_proven",
                "persai_runtime_session_ordering_process_local",
                "persai_runtime_multi_replica_session_not_supported",
              ],
              uptimeMs: 5_000,
            });
          },
        });
      },
    );
  });

  it("does not present redis-backed apply storage as full multi-replica session safety", async () => {
    await withEnv(
      {
        PERSAI_RUNTIME_READINESS_MODE: "multi_replica",
        PERSAI_RUNTIME_SPEC_STORE: "redis",
      },
      async () => {
        const getReadiness: ReadinessChecker = () => ({
          ready: false,
          failing: [
            "persai_runtime_session_store_not_cluster_proven",
            "persai_runtime_workspace_continuity_not_cluster_proven",
            "persai_runtime_session_ordering_process_local",
            "persai_runtime_multi_replica_session_not_supported",
          ],
          uptimeMs: 6_000,
        });

        await withGatewayServer({
          prefix: "probe-persai-runtime-redis-not-enough",
          resolvedAuth: AUTH_NONE,
          overrides: { getReadiness },
          run: async (server) => {
            const req = createRequest({ path: "/ready" });
            const { res, getBody } = createResponse();
            await dispatchRequest(server, req, res);

            expect(res.statusCode).toBe(503);
            expect(JSON.parse(getBody())).toEqual({
              ready: false,
              failing: [
                "persai_runtime_session_store_not_cluster_proven",
                "persai_runtime_workspace_continuity_not_cluster_proven",
                "persai_runtime_session_ordering_process_local",
                "persai_runtime_multi_replica_session_not_supported",
              ],
              uptimeMs: 6_000,
            });
          },
        });
      },
    );
  });
});
