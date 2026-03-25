import { afterEach, describe, expect, test, vi } from "vitest";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
import {
  extractPersaiRuntimeModelOverride,
  PersaiRuntimeProviderProfileValidationError,
  resolvePersaiRuntimeProviderProfile,
  validatePersaiRuntimeProviderProfileForApply,
} from "./persai-runtime-provider-profile.js";

const ORIGINAL_ENV = { ...process.env };

function createRuntimeConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        models: {
          "openai/gpt-5.4": {},
          "anthropic/claude-sonnet-4-5": {},
        },
      },
    },
  } as OpenClawConfig;
}

function createBootstrap() {
  return {
    schema: "openclaw.bootstrap.v1",
    governance: {
      runtimeProviderProfile: {
        schema: "persai.runtimeProviderProfile.v1",
        mode: "admin_managed",
        primary: {
          provider: "openai",
          model: "gpt-5.4",
          credentialRef: {
            refKey: "env:default:OPENAI_API_KEY",
            secretRef: {
              source: "env",
              provider: "default",
              id: "OPENAI_API_KEY",
            },
          },
        },
        fallback: {
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          credentialRef: {
            refKey: "env:default:ANTHROPIC_API_KEY",
            secretRef: {
              source: "env",
              provider: "default",
              id: "ANTHROPIC_API_KEY",
            },
          },
        },
      },
    },
  };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
});

describe("persai runtime provider profile", () => {
  test("returns null when bootstrap has no runtime provider profile", () => {
    expect(resolvePersaiRuntimeProviderProfile({ schema: "openclaw.bootstrap.v1" })).toBeNull();
    expect(extractPersaiRuntimeModelOverride({ schema: "openclaw.bootstrap.v1" })).toBeNull();
  });

  test("extracts primary provider/model override for admin-managed profile", () => {
    const override = extractPersaiRuntimeModelOverride(createBootstrap());
    expect(override).toEqual({
      provider: "openai",
      model: "gpt-5.4",
    });
  });

  test("validates allowlisted models and resolvable env credential refs", async () => {
    setRuntimeConfigSnapshot(createRuntimeConfig());
    process.env.OPENAI_API_KEY = "sk-openai-test";
    process.env.ANTHROPIC_API_KEY = "sk-anthropic-test";

    await expect(validatePersaiRuntimeProviderProfileForApply(createBootstrap())).resolves.toBeUndefined();
  });

  test("validates allowlisted models and resolvable persai credential refs", async () => {
    setRuntimeConfigSnapshot({
      ...createRuntimeConfig(),
      secrets: {
        providers: {
          "persai-runtime": {
            source: "persai",
            baseUrl: "http://api:3001",
            path: "/api/v1/internal/runtime/provider-secrets/resolve",
            tokenEnvVar: "OPENCLAW_GATEWAY_TOKEN",
          },
        },
      },
    } as OpenClawConfig);
    process.env.OPENCLAW_GATEWAY_TOKEN = "gateway-token";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              protocolVersion: 1,
              values: {
                "openai/api-key": "sk-openai-test",
                "anthropic/api-key": "sk-anthropic-test",
              },
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          ),
        ),
      ),
    );

    const bootstrap = createBootstrap() as {
      governance: {
        runtimeProviderProfile: {
          primary: {
            credentialRef: {
              refKey: string;
              secretRef: { source: string; provider: string; id: string };
            };
          };
          fallback: {
            credentialRef: {
              refKey: string;
              secretRef: { source: string; provider: string; id: string };
            };
          };
        };
      };
    };
    bootstrap.governance.runtimeProviderProfile.primary.credentialRef = {
      refKey: "persai:persai-runtime:openai/api-key",
      secretRef: {
        source: "persai",
        provider: "persai-runtime",
        id: "openai/api-key",
      },
    };
    bootstrap.governance.runtimeProviderProfile.fallback.credentialRef = {
      refKey: "persai:persai-runtime:anthropic/api-key",
      secretRef: {
        source: "persai",
        provider: "persai-runtime",
        id: "anthropic/api-key",
      },
    };

    await expect(validatePersaiRuntimeProviderProfileForApply(bootstrap)).resolves.toBeUndefined();
  });

  test("rejects missing provider credential refs in current runtime env", async () => {
    setRuntimeConfigSnapshot(createRuntimeConfig());
    process.env.OPENAI_API_KEY = "sk-openai-test";
    delete process.env.ANTHROPIC_API_KEY;

    await expect(validatePersaiRuntimeProviderProfileForApply(createBootstrap())).rejects.toThrow(
      PersaiRuntimeProviderProfileValidationError,
    );
    await expect(validatePersaiRuntimeProviderProfileForApply(createBootstrap())).rejects.toThrow(
      'Runtime provider credential ref "env:default:ANTHROPIC_API_KEY" could not be resolved by OpenClaw.',
    );
  });

  test("rejects models outside the configured allowlist", async () => {
    setRuntimeConfigSnapshot(createRuntimeConfig());
    process.env.OPENAI_API_KEY = "sk-openai-test";
    process.env.ANTHROPIC_API_KEY = "sk-anthropic-test";
    const bootstrap = createBootstrap();
    (
      bootstrap.governance.runtimeProviderProfile as {
        primary: { model: string };
      }
    ).primary.model = "gpt-not-allowed";

    await expect(validatePersaiRuntimeProviderProfileForApply(bootstrap)).rejects.toThrow(
      'Runtime provider profile model "openai/gpt-not-allowed" is not configured in the OpenClaw allowlist.',
    );
  });
});
