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
const OPENSSH_COMMANDS_WITH_IDENTITY_FILE = new Set(["ssh", "scp", "sftp"]);

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
    const isSensitiveFlag = SENSITIVE_FLAG_SET.has(flag) || (isOpenSshCommandName(commandName) && flag === "-i");
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
    const valueStart = skipShellWhitespace(input, match.index + match[0].length);
    if (valueStart >= input.length) {
      continue;
    }
    const valueEnd = findCommandValueEnd(input, valueStart);
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
  const ranges: Array<{ start: number; end: number }> = [];
  collectSshIdentityRanges(input, 0, input.length, ranges);
  return redactRanges(input, ranges);
}

function collectSshIdentityRanges(input: string, start: number, end: number, ranges: Array<{ start: number; end: number }>): void {
  let cursor = start;
  while (cursor < input.length) {
    const sshStart = findNextSshWordStart(input, cursor);
    if (sshStart >= end) {
      break;
    }
    const sshEnd = findSshWordEnd(input, sshStart);
    if (!isOpenSshCommandName(input.slice(sshStart, sshEnd))) {
      cursor = sshEnd;
      continue;
    }
    cursor = sshEnd;
    for (;;) {
      const wordStart = skipShellWhitespace(input, cursor);
      if (wordStart >= end || isShellCommandBoundary(input[wordStart])) {
        break;
      }
      const wordEnd = findShellWordEnd(input, wordStart);
      const word = input.slice(wordStart, wordEnd);
      if (word === "--") {
        break;
      }
      if (word === "-i") {
        const valueStart = skipShellWhitespace(input, wordEnd);
        if (valueStart >= end) {
          break;
        }
        const valueEnd = Math.min(findCommandValueEnd(input, valueStart), end);
        ranges.push({ start: valueStart, end: valueEnd });
        cursor = valueEnd;
        continue;
      }
      if (word.startsWith("-i") && word.length > 2) {
        ranges.push({ start: wordStart + 2, end: wordEnd });
        cursor = wordEnd;
        continue;
      }
      if (!word.startsWith("-") || word === "-") {
        break;
      }
      const attachedValueStart = getAttachedSshOptionValueStart(word);
      if (attachedValueStart !== undefined) {
        collectSshIdentityRanges(input, wordStart + attachedValueStart, wordEnd, ranges);
        cursor = wordEnd;
      } else if (SSH_OPTIONS_WITH_VALUE.has(word)) {
        const valueStart = skipShellWhitespace(input, wordEnd);
        const valueEnd = Math.min(findShellWordEnd(input, valueStart), end);
        collectSshIdentityRanges(input, valueStart, valueEnd, ranges);
        cursor = valueEnd;
      } else {
        cursor = wordEnd;
      }
    }
  }
}

function redactRanges(input: string, ranges: Array<{ start: number; end: number }>): string {
  const sorted = ranges
    .filter((range) => range.start < range.end)
    .sort((left, right) => left.start - right.start || right.end - left.end);
  let output = "";
  let cursor = 0;
  for (const range of sorted) {
    if (range.end <= cursor) {
      continue;
    }
    output += input.slice(cursor, Math.max(range.start, cursor));
    output += "<redacted>";
    cursor = range.end;
  }
  return output + input.slice(cursor);
}

function getAttachedSshOptionValueStart(word: string): number | undefined {
  if (word.length <= 2 || !word.startsWith("-") || word.startsWith("--")) {
    return undefined;
  }
  const option = word.slice(0, 2);
  return SSH_OPTIONS_WITH_VALUE.has(option) ? 2 : undefined;
}

function isOpenSshCommandName(commandName: string | undefined): boolean {
  if (!commandName) {
    return false;
  }
  const basename = commandName.slice(commandName.lastIndexOf("/") + 1);
  return OPENSSH_COMMANDS_WITH_IDENTITY_FILE.has(basename);
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

function skipShellWhitespace(input: string, start: number): number {
  let index = start;
  for (;;) {
    while (index < input.length && /\s/.test(input[index])) {
      index += 1;
    }
    const continuationLength = shellLineContinuationLength(input, index);
    if (continuationLength === 0) {
      return index;
    }
    index += continuationLength;
  }
}

function shellLineContinuationLength(input: string, index: number): number {
  if (input[index] !== "\\") {
    return 0;
  }
  if (input[index + 1] === "\n") {
    return 2;
  }
  if (input[index + 1] === "\r") {
    return input[index + 2] === "\n" ? 3 : 2;
  }
  return 0;
}

function isShellCommandBoundary(char: string): boolean {
  return char === ";" || char === "&" || char === "|" || char === "(" || char === ")";
}

function findCommandValueEnd(input: string, start: number): number {
  if (input[start] === "'" || input[start] === "\"") {
    return findShellWordEnd(input, start);
  }
  let escaped = false;
  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (/\s/.test(char) || char === "'" || char === "\"" || char === "`" || isShellCommandBoundary(char)) {
      return index;
    }
  }
  return input.length;
}

function findShellWordEnd(input: string, start: number): number {
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  let substitutionDepth = 0;

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
    if (!quote && substitutionDepth === 0 && /\s/.test(char)) {
      return index;
    }
    if (!quote && isShellSubstitutionStart(input, index)) {
      substitutionDepth += 1;
      index += 1;
      continue;
    }
    if (!quote && substitutionDepth > 0 && char === ")") {
      substitutionDepth -= 1;
      continue;
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

function isShellSubstitutionStart(input: string, index: number): boolean {
  if (input[index + 1] !== "(") {
    return false;
  }
  return input[index] === "<" || input[index] === ">" || input[index] === "$";
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
