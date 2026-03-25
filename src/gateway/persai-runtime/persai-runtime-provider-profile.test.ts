import { afterEach, describe, expect, test } from "vitest";
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
