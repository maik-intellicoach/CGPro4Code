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
  | "prompt_delivery_incomplete";

export type PreSubmitInteractionPhase =
  | "model_verification"
  | "connector_selection"
  | "prompt_delivery";

/** A browser-control failure that is proven to occur before Send. */
export class PreSubmitInteractionError extends Error {
  readonly promptSubmitted = false;

  constructor(
    readonly code: PreSubmitInteractionCode,
    readonly phase: PreSubmitInteractionPhase,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PreSubmitInteractionError";
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
