const SENSITIVE_FLAGS = new Set([
  "--password",
  "--password-file",
  "--token-file",
  "--auth-token-file",
  "--access-token",
  "--private-key",
  "--sa-key-file"
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
    const isSensitiveFlag = SENSITIVE_FLAGS.has(flag) || (commandName === "ssh" && flag === "-i");
    if (isSensitiveFlag) {
      if (part.text.includes("=")) {
        return `${flag}=<redacted>`;
      }
      redactNext = true;
    }
    return part.text;
  }).join("");
  return redactText(redactSensitiveFlagValues(topLevelRedacted), extraRedactions);
}

function redactSensitiveFlagValues(input: string): string {
  const flagPattern = /--(?:password-file|auth-token-file|token-file|access-token|private-key|sa-key-file|password)(?:=|\s+)/g;
  let output = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = flagPattern.exec(input)) !== null) {
    const valueStart = match.index + match[0].length;
    if (valueStart >= input.length) {
      continue;
    }
    const valueEnd = findShellWordEnd(input, valueStart);
    output += input.slice(lastIndex, valueStart);
    output += "<redacted>";
    lastIndex = valueEnd;
    flagPattern.lastIndex = valueEnd;
  }

  return output + input.slice(lastIndex);
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
