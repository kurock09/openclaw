function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** P2: read persona instructions from materialized openclaw.workspace.v1 for native hydrate / echo hints. */
export function extractPersonaInstructionsFromWorkspace(workspace: unknown): string | null {
  if (!isRecord(workspace)) {
    return null;
  }
  const persona = workspace.persona;
  if (!isRecord(persona)) {
    return null;
  }
  const instructions = persona.instructions;
  if (typeof instructions !== "string" || !instructions.trim()) {
    return null;
  }
  return instructions.trim().slice(0, 4000);
}

const VALID_GENDERS = new Set(["male", "female", "neutral"]);

export function extractAssistantGenderFromWorkspace(workspace: unknown): string | null {
  if (!isRecord(workspace)) {
    return null;
  }
  const persona = workspace.persona;
  if (!isRecord(persona)) {
    return null;
  }
  const gender =
    typeof persona.assistantGender === "string"
      ? persona.assistantGender.trim().toLowerCase()
      : null;
  return gender && VALID_GENDERS.has(gender) ? gender : null;
}

export function buildSchedulingContext(params: {
  currentTimeIso?: string;
  userTimezone?: string;
}): string | null {
  if (!params.currentTimeIso) {
    return null;
  }
  const currentTimeMs = Date.parse(params.currentTimeIso);
  if (!Number.isFinite(currentTimeMs)) {
    return null;
  }

  const lines = ["# Scheduling Context", `- Current UTC time: ${params.currentTimeIso}`];
  if (params.userTimezone) {
    lines.push(`- User timezone: ${params.userTimezone}`);
    try {
      const localTime = new Intl.DateTimeFormat("en-US", {
        timeZone: params.userTimezone,
        dateStyle: "full",
        timeStyle: "long",
      }).format(new Date(currentTimeMs));
      lines.push(`- Current local time in the user's timezone: ${localTime}`);
    } catch {
      // Ignore invalid timezone formatting and keep the raw timezone string.
    }
  }
  lines.push(
    "- For relative reminders like 'in 5 minutes', calculate from this current time instead of guessing.",
  );
  return lines.join("\n");
}

export function mergeSystemPrompt(
  base: string | undefined,
  addition: string | null,
): string | undefined {
  if (!addition) {
    return base;
  }
  return base ? `${base}\n\n${addition}` : addition;
}
