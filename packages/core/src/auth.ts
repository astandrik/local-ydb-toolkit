const SENSITIVE_FLAGS = [
  "--password",
  "--password-file",
  "--token-file",
  "--auth-token-file",
  "--access-token",
  "--private-key",
  "--sa-key-file"
] as const;
const SENSITIVE_FLAG_SET = new Set<string>(SENSITIVE_FLAGS);
const SENSITIVE_FLAG_PATTERN = buildSensitiveFlagPattern(SENSITIVE_FLAGS);
const SSH_OPTIONS_WITH_VALUE = new Set([
  "-B",
  "-b",
  "-c",
  "-D",
  "-E",
  "-e",
  "-F",
  "-I",
  "-J",
  "-L",
  "-l",
  "-m",
  "-O",
  "-o",
  "-P",
  "-p",
  "-Q",
  "-R",
  "-S",
  "-W",
  "-w"
]);

export function redactText(input: string, extraRedactions: string[] = []): string {
  let output = input;
  for (const value of extraRedactions.filter(Boolean)) {
    output = output.split(value).join("<redacted>");
  }
  output = output.replace(/(password|token|secret|private[_-]?key)=([^ \n\t]+)/gi, "$1=<redacted>");
  output = output.replace(/(PASSWORD|TOKEN|SECRET)=([^ \n\t]+)/g, "$1=<redacted>");
  return output;
}

export function redactCommand(command: string, extraRedactions: string[] = []): string {
  const parts = splitTopLevelShellParts(command);
  let redactNext = false;
  let commandName: string | undefined;
  const topLevelRedacted = parts.map((part) => {
    if (!part.isWord) {
      return part.text;
    }
    commandName ??= part.text;
    if (redactNext) {
      redactNext = false;
      return "<redacted>";
    }
    const flag = part.text.includes("=") ? part.text.slice(0, part.text.indexOf("=")) : part.text;
    const isSensitiveFlag = SENSITIVE_FLAG_SET.has(flag) || (isSshCommandName(commandName) && flag === "-i");
    if (isSensitiveFlag) {
      if (part.text.includes("=")) {
        return `${flag}=<redacted>`;
      }
      redactNext = true;
    }
    return part.text;
  }).join("");
  return redactText(redactSshIdentityValues(redactSensitiveFlagValues(topLevelRedacted)), extraRedactions);
}

function redactSensitiveFlagValues(input: string): string {
  let output = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  SENSITIVE_FLAG_PATTERN.lastIndex = 0;
  while ((match = SENSITIVE_FLAG_PATTERN.exec(input)) !== null) {
    const valueStart = match.index + match[0].length;
    if (valueStart >= input.length) {
      continue;
    }
    const valueEnd = findShellWordEnd(input, valueStart);
    output += input.slice(lastIndex, valueStart);
    output += "<redacted>";
    lastIndex = valueEnd;
    SENSITIVE_FLAG_PATTERN.lastIndex = valueEnd;
  }

  return output + input.slice(lastIndex);
}

function buildSensitiveFlagPattern(flags: readonly string[]): RegExp {
  const pattern = [...flags]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join("|");
  return new RegExp(`(?:${pattern})(?:=|\\s+)`, "g");
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function redactSshIdentityValues(input: string): string {
  let output = "";
  let lastIndex = 0;
  let cursor = 0;

  while (cursor < input.length) {
    const sshStart = findNextSshWordStart(input, cursor);
    if (sshStart >= input.length) {
      break;
    }
    const sshEnd = findSshWordEnd(input, sshStart);
    if (!isSshCommandName(input.slice(sshStart, sshEnd))) {
      cursor = sshEnd;
      continue;
    }
    cursor = sshEnd;
    for (;;) {
      const wordStart = skipWhitespace(input, cursor);
      if (wordStart >= input.length || isShellCommandBoundary(input[wordStart])) {
        break;
      }
      const wordEnd = findShellWordEnd(input, wordStart);
      const word = input.slice(wordStart, wordEnd);
      if (word === "--") {
        break;
      }
      if (word === "-i") {
        const valueStart = skipWhitespace(input, wordEnd);
        if (valueStart >= input.length) {
          break;
        }
        const valueEnd = findShellWordEnd(input, valueStart);
        output += input.slice(lastIndex, valueStart);
        output += "<redacted>";
        lastIndex = valueEnd;
        cursor = valueEnd;
        continue;
      }
      if (!word.startsWith("-") || word === "-") {
        break;
      }
      cursor = SSH_OPTIONS_WITH_VALUE.has(word) ? findShellWordEnd(input, skipWhitespace(input, wordEnd)) : wordEnd;
    }
  }

  return output + input.slice(lastIndex);
}

function isSshCommandName(commandName: string | undefined): boolean {
  return commandName === "ssh" || commandName?.endsWith("/ssh") === true;
}

function findNextSshWordStart(input: string, start: number): number {
  let index = start;
  while (index < input.length && isSshScanBoundary(input[index])) {
    index += 1;
  }
  return index;
}

function findSshWordEnd(input: string, start: number): number {
  let index = start;
  while (index < input.length && !isSshScanBoundary(input[index])) {
    index += 1;
  }
  return index;
}

function isSshScanBoundary(char: string): boolean {
  return /\s/.test(char) || char === "'" || char === "\"" || char === "`" || isShellCommandBoundary(char);
}

function skipWhitespace(input: string, start: number): number {
  let index = start;
  while (index < input.length && /\s/.test(input[index])) {
    index += 1;
  }
  return index;
}

function isShellCommandBoundary(char: string): boolean {
  return char === ";" || char === "&" || char === "|" || char === ")";
}

function findShellWordEnd(input: string, start: number): number {
  let quote: "'" | "\"" | undefined;
  let escaped = false;

  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      return index;
    }
    if (!quote && (char === "'" || char === "\"")) {
      quote = char;
      continue;
    }
    if (quote && char === quote) {
      quote = undefined;
      continue;
    }
  }

  return input.length;
}

function splitTopLevelShellParts(input: string): Array<{ text: string; isWord: boolean }> {
  const parts: Array<{ text: string; isWord: boolean }> = [];
  let current = "";
  let whitespace = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  function pushWord(): void {
    if (current) {
      parts.push({ text: current, isWord: true });
      current = "";
    }
  }

  function pushWhitespace(): void {
    if (whitespace) {
      parts.push({ text: whitespace, isWord: false });
      whitespace = "";
    }
  }

  for (const char of input) {
    if (escaped) {
      pushWhitespace();
      current += char;
      escaped = false;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && /\s/.test(char)) {
      pushWord();
      whitespace += char;
      continue;
    }

    pushWhitespace();
    current += char;

    if (char === "\\" && !inSingleQuote) {
      escaped = true;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (char === "\"" && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    }
  }

  pushWord();
  pushWhitespace();
  return parts;
}
