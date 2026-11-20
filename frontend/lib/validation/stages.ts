/**
 * buildingSMART's validation service, run in the browser (ADR 018): its stages,
 * their order, what blocks what, and the shape of a stage's result.
 *
 * Mirrors `buildingSMART/validate`, `backend/apps/ifc_validation/tasks/configs.py`.
 * Not run here: the virus scan (the file never leaves the device), digital
 * signatures (`lib/signing/` checks those) and bSDD (it would send the model's
 * classification references to a third party).
 *
 * Added here, last: `dice_rules`, our own rules (DiCE-IFC-Rules, pinned in
 * `validator/manifest.json`), when the build has them — never mixed into the
 * service's stages.
 */

export const VALIDATION_STAGES = [
  "header_syntax",
  "header",
  "syntax",
  "prerequisites",
  "schema",
  "normative_ia",
  "normative_ip",
  "industry_practices",
  "dice_rules",
] as const;

export type ValidationStage = (typeof VALIDATION_STAGES)[number];

/** As `configs.py`: a stage that fails stops these from running (and our rules, which need the same model). */
const AFTER_PREREQUISITES: ValidationStage[] = ["schema", "normative_ia", "normative_ip", "industry_practices", "dice_rules"];
export const STAGE_BLOCKS: Partial<Record<ValidationStage, ValidationStage[]>> = {
  header_syntax: ["header", "syntax", "prerequisites", ...AFTER_PREREQUISITES],
  syntax: AFTER_PREREQUISITES,
  prerequisites: AFTER_PREREQUISITES,
};

export type OutcomeSeverity = "NOT_APPLICABLE" | "EXECUTED" | "PASSED" | "WARNING" | "ERROR";

/** One outcome, as the service stores it, plus what the driver adds to show it. */
export type ValidationOutcome = {
  severity: OutcomeSeverity;
  outcome_code?: string;
  /** STEP id of the instance it is about — the viewer's expressId. */
  inst?: number | null;
  /** Its IFC class, when known. */
  entity?: string | null;
  /** Rule code (`GEM111`) and the rule's full title, for rule stages. */
  rule?: string;
  title?: string;
  /** The rule's published page. */
  doc?: string | null;
  feature?: string | null;
  expected?: unknown;
  observed?: unknown;
  /** Schema stage: the entity type and attribute the message is about. */
  type?: string | null;
  attribute?: string | null;
  /** Rules: the rule's own description ("The rule verifies that…"). */
  description?: string | null;
  /** Schema: the message's parts — its title, the sentence saying what is required,
   *  the EXPRESS expression of a rule, and why it was violated. */
  explanation?: string | null;
  expression?: string | null;
  detail?: string | null;
  /** The schema the file declares (`IFC4`). */
  schema?: string | null;
  /** Header: the originating system a derived field was read from. */
  source?: string | null;
  /** Header, FILE_DESCRIPTION: which check failed — `empty`, `unreadable` (an entry that is not
   *  "Keyword [value]", so no view is read), `noView`, `notAllowed`, `addOn`, or `type` — the
   *  entries at fault, and the views read. */
  reason?: string | null;
  unreadable?: string[] | null;
  views?: string[] | null;
};

export type StageStatus = "valid" | "warning" | "invalid" | "skipped" | "failed";

export type StageResult = {
  stage: ValidationStage;
  status: StageStatus;
  outcomes: ValidationOutcome[];
  info: {
    seconds?: number;
    /** Rule stages: rules run, and rules that crashed (a rule's bug, not the model's). */
    rules?: number;
    crashed?: Array<{ rule: string; step?: string; error: string }>;
    /** Header stage: the header as read. */
    header?: Record<string, unknown>;
    /** Why a stage was skipped (the stage that blocked it, or "memory") or failed to run. */
    reason?: string;
    /** It stopped because WebAssembly ran out of memory. */
    outOfMemory?: boolean;
  };
};

/** What `public/validator/build.json` says was built. */
export type ValidatorBuild = {
  service: Record<string, string>;
  pyodide: string;
  packages: string[];
  bytes: number;
  /** Our own rules, when shipped: the repository, its commit (or a local checkout's), the rule codes. */
  customRules?: {
    name: string;
    source: "github" | "local";
    github: string | null;
    commit: string | null;
    modified: boolean;
    rules: string[];
    docs: string | null;
  } | null;
};

/** The stages this build runs: the service's, and ours when it has rules of ours. */
export function stagesFor(build: ValidatorBuild | null | undefined): ValidationStage[] {
  return VALIDATION_STAGES.filter((stage) => stage !== "dice_rules" || Boolean(build?.customRules?.rules.length));
}

/** Our rules as a version: "DiCE-IFC-Rules 1a2b3c4" (with "+" for uncommitted changes), or null. */
export function customRulesLabel(build: ValidatorBuild | null | undefined): string | null {
  const custom = build?.customRules;
  if (!custom) return null;
  return [custom.name, custom.commit ? `${custom.commit.slice(0, 7)}${custom.modified ? "+" : ""}` : "(local)"].join(" ");
}

/**
 * The outcome code as the service names it. Rule outcomes arrive as Python's
 * `str()` of the enum ("ValidationOutcomeCode.PASSED"); the others as the code.
 */
export function outcomeCode(outcome: ValidationOutcome): string | undefined {
  return outcome.outcome_code?.replace(/^ValidationOutcomeCode\./, "");
}

/** The stages that do not run because an earlier one failed. */
export function blockedBy(results: Partial<Record<ValidationStage, StageResult>>): Map<ValidationStage, ValidationStage> {
  const blocked = new Map<ValidationStage, ValidationStage>();
  for (const stage of VALIDATION_STAGES) {
    const result = results[stage];
    if (!result || (result.status !== "invalid" && result.status !== "failed")) continue;
    for (const next of STAGE_BLOCKS[stage] ?? []) if (!blocked.has(next)) blocked.set(next, stage);
  }
  return blocked;
}

/**
 * Whether an error is WebAssembly running out of memory, as Pyodide reports it:
 * Python's MemoryError, Emscripten's abort on a failed allocation, or the memory
 * that could not grow. After one, the interpreter cannot be used again.
 */
export function isOutOfMemory(message: string): boolean {
  return /MemoryError|out of memory|Aborted\(OOM\)|Cannot enlarge memory|WebAssembly\.Memory|Array buffer allocation failed|memory access out of bounds/i.test(message);
}

/** What the worker hands back: the stages' results and what the run cost. */
export type ValidationOutput = {
  results: StageResult[];
  /** WebAssembly memory held at the end, in MB: it never shrinks, so this is the peak. */
  memoryMb: number;
  /** The run ran out of memory: the interpreter is gone. */
  outOfMemory: boolean;
};
