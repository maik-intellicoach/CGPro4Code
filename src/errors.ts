import { errors as browserErrors } from "patchright";

export class CgproError extends Error {
  readonly exitCode: number;
  readonly hint?: string;
  constructor(message: string, exitCode: number, hint?: string) {
    super(message);
    this.name = "CgproError";
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export class NotLoggedInError extends CgproError {
  constructor() {
    super("No active ChatGPT session.", 2, "Run `cgpro login` first.");
    this.name = "NotLoggedInError";
  }
}

export class ProfileLockedError extends CgproError {
  constructor() {
    super(
      "Another `cgpro` process is using the profile directory.",
      3,
      "Wait for it to finish, or pass `--profile <other-path>`.",
    );
    this.name = "ProfileLockedError";
  }
}

export class ModelUnavailableError extends CgproError {
  constructor(model: string) {
    super(
      `Your plan does not include the model \`${model}\`.`,
      4,
      "Run `cgpro models` to see what's available.",
    );
    this.name = "ModelUnavailableError";
  }
}

export class SelectorBrokenError extends CgproError {
  constructor(selectorName: string) {
    super(
      `ChatGPT UI changed: selector "${selectorName}" no longer resolves.`,
      5,
      "Run `cgpro doctor` and file a bug at https://github.com/yannabadie/CGPro4Code/issues.",
    );
    this.name = "SelectorBrokenError";
  }
}

export class TurnTimeoutError extends CgproError {
  constructor(seconds: number) {
    super(
      `The refreshed conversation showed neither a completed response nor active generation after ${seconds}s.`,
      6,
      "Check the conversation in ChatGPT or your network before retrying the prompt.",
    );
    this.name = "TurnTimeoutError";
  }
}

/** Evidence reads failed repeatedly; this is an HTTP status, not a quota diagnosis. */
export class ConnectorEvidenceRateLimitError extends Error {
  readonly httpStatus = 429;
  readonly consecutiveFailures = 3;

  constructor(cause: unknown) {
    super("conversation connector state fetch failed with HTTP 429 (3 consecutive evidence reads)", { cause });
    this.name = "ConnectorEvidenceRateLimitError";
  }
}

export class BotChallengeError extends CgproError {
  constructor() {
    super(
      "Cloudflare or sentinel bot-check triggered.",
      7,
      "Run `cgpro login` to refresh the session interactively.",
    );
    this.name = "BotChallengeError";
  }
}

export type PreSubmitInteractionCode =
  | "model_control_activation_timeout"
  | "model_control_unresolved"
  | "chat_surface_unconfirmed"
  | "connector_control_activation_timeout"
  | "prompt_delivery_incomplete"
  | "pro_usage_limit_reached"
  | "preflight_draft_protected";

export type PreSubmitInteractionPhase =
  | "model_verification"
  | "connector_selection"
  | "prompt_delivery";

/**
 * Optional extra evidence a pre-submit refusal may carry. Only set on the codes
 * that have it; `pro_usage_limit_reached` is the first, and it carries when the
 * account's Pro tier becomes available again plus the capped tooltip it read.
 */
export interface PreSubmitInteractionDetails extends ErrorOptions {
  /** ISO 8601 local instant Pro becomes available, or null when not parsed. */
  availableAfter?: string | null;
  /** The capped `[role="tooltip"]` text behind a disabled Pro item. */
  limitText?: string | null;
}

/** A browser-control failure that is proven to occur before Send. */
export class PreSubmitInteractionError extends Error {
  readonly promptSubmitted = false;
  /** Set only for `pro_usage_limit_reached`; omitted on every other code. */
  readonly availableAfter?: string | null;
  readonly limitText?: string | null;

  constructor(
    readonly code: PreSubmitInteractionCode,
    readonly phase: PreSubmitInteractionPhase,
    message: string,
    options?: PreSubmitInteractionDetails,
  ) {
    super(message, options);
    this.name = "PreSubmitInteractionError";
    if (options?.availableAfter !== undefined) this.availableAfter = options.availableAfter;
    if (options?.limitText !== undefined) this.limitText = options.limitText;
  }
}


/** Content-free refusal: the page must be left exactly as found. */
export class PreflightDraftProtectedError extends PreSubmitInteractionError {
  constructor() {
    super("preflight_draft_protected", "prompt_delivery", "Interaction preflight cannot establish safe draft ownership");
    this.name = "PreflightDraftProtectedError";
  }
}

export type AccountDiagnosticCode =
  | "account_identity_mismatch"
  | "account_expected_identity_missing"
  | "account_identity_absent"
  | "account_http_failure"
  | "account_abort_timeout"
  | "account_network_failure"
  | "account_parse_error"
  | "account_evaluation_rejection";

export class AccountRequirementError extends Error {
  readonly code: AccountDiagnosticCode;
  readonly httpStatus?: number;

  constructor(code: AccountDiagnosticCode, options?: { httpStatus?: number }) {
    super(AccountRequirementError.formatMessage(code, options?.httpStatus));
    this.name = "AccountRequirementError";
    this.code = code;
    this.httpStatus = options?.httpStatus;
  }

  private static formatMessage(code: AccountDiagnosticCode, httpStatus?: number): string {
    switch (code) {
      case "account_identity_mismatch":
        return "ChatGPT account identity mismatch";
      case "account_expected_identity_missing":
        return "ChatGPT account expected identity missing";
      case "account_identity_absent":
        return "ChatGPT account identity absent";
      case "account_http_failure":
        return typeof httpStatus === "number"
          ? `ChatGPT account session HTTP failure (HTTP ${httpStatus})`
          : "ChatGPT account session HTTP failure";
      case "account_abort_timeout":
        return "ChatGPT account session timeout";
      case "account_network_failure":
        return "ChatGPT account session network error";
      case "account_parse_error":
        return "ChatGPT account session invalid JSON";
      case "account_evaluation_rejection":
        return "ChatGPT account session evaluation failure";
    }
  }
}

export interface InteractionFailure {
  code: PreSubmitInteractionCode | "selector_unresolved" | "not_logged_in"
    | "browser_operation_timeout" | "project_list_unavailable"
    | "project_identity_unverified" | AccountDiagnosticCode | "unclassified_error";
  httpStatus?: number;
}

/** Closed classification boundary: never return message, name, URL, stack or cause. */
export function classifyInteractionFailure(error: unknown): InteractionFailure {
  if (error instanceof PreSubmitInteractionError) return { code: error.code };
  if (error instanceof SelectorBrokenError) return { code: "selector_unresolved" };
  if (error instanceof NotLoggedInError) return { code: "not_logged_in" };
  if (error instanceof browserErrors.TimeoutError) return { code: "browser_operation_timeout" };
  if (error instanceof AccountRequirementError) {
    return {
      code: error.code,
      ...(typeof error.httpStatus === "number" ? { httpStatus: error.httpStatus } : {}),
    };
  }
  if (error instanceof Error) {
    const status = /^ChatGPT project list unavailable \(HTTP ([1-5][0-9]{2})\)$/.exec(error.message);
    if (status) return { code: "project_list_unavailable", httpStatus: Number(status[1]) };
    if (error.message === "Requested ChatGPT Project could not be uniquely identified") {
      return { code: "project_identity_unverified" };
    }
    if (error.message === "ChatGPT account identity mismatch") {
      return { code: "account_identity_mismatch" };
    }
    if (error.message === "ChatGPT account expected identity missing") {
      return { code: "account_expected_identity_missing" };
    }
    if (error.message === "ChatGPT account identity absent") {
      return { code: "account_identity_absent" };
    }
    const httpMatch = /^ChatGPT account session HTTP failure \(HTTP ([1-5][0-9]{2})\)$/.exec(error.message);
    if (httpMatch) {
      return { code: "account_http_failure", httpStatus: Number(httpMatch[1]) };
    }
    if (error.message === "ChatGPT account session timeout") {
      return { code: "account_abort_timeout" };
    }
    if (error.message === "ChatGPT account session network error") {
      return { code: "account_network_failure" };
    }
    if (error.message === "ChatGPT account session invalid JSON") {
      return { code: "account_parse_error" };
    }
    if (error.message === "ChatGPT account session evaluation failure") {
      return { code: "account_evaluation_rejection" };
    }
  }
  return { code: "unclassified_error" };
}
