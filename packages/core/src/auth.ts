const SENSITIVE_FLAGS = new Set([
  "--password",
  "--password-file",
  "--token-file",
  "--auth-token-file",
  "--access-token",
  "--private-key",
  "--sa-key-file",
  "-f",
  "-i"
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
  const parts = command.split(/(\s+)/);
  let redactNext = false;
  return redactText(parts.map((part) => {
    if (/^\s+$/.test(part)) {
      return part;
    }
    if (redactNext) {
      redactNext = false;
      return "<redacted>";
    }
    const flag = part.includes("=") ? part.slice(0, part.indexOf("=")) : part;
    if (SENSITIVE_FLAGS.has(flag)) {
      if (part.includes("=")) {
        return `${flag}=<redacted>`;
      }
      redactNext = true;
    }
    return part;
  }).join(""), extraRedactions);
}
