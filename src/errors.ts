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
