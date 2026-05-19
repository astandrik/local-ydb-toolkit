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
  return redactText(parts.map((part) => {
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
  }).join(""), extraRedactions);
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
    if (!inSingleQuote && !inDoubleQuote && /\s/.test(char)) {
      pushWord();
      whitespace += char;
      continue;
    }

    pushWhitespace();
    current += char;

    if (escaped) {
      escaped = false;
      continue;
    }

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
