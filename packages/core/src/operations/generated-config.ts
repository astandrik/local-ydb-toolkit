import { shellQuote } from "../api-client.js";

const GENERATED_CONFIG_CANDIDATES = [
  "/ydb_data/cluster/kikimr_configs/config.yaml",
  "/ydb_data/kikimr_configs/config.yaml"
] as const;

export function generatedConfigDiscoveryLines(variableName: string): string[] {
  assertShellVariableName(variableName);
  return [
    `${variableName}=`,
    `for candidate in ${GENERATED_CONFIG_CANDIDATES.map(shellQuote).join(" ")}; do`,
    "  if [ -f \"$candidate\" ]; then",
    `    ${variableName}=$candidate`,
    "    break",
    "  fi",
    "done",
    `if [ -z "$${variableName}" ]; then`,
    "  matches=$(find /ydb_data -maxdepth 4 -type f -path '*/kikimr_configs/config.yaml' 2>/dev/null | sort)",
    "  match_count=$(printf '%s\\n' \"$matches\" | grep -c . || true)",
    "  case \"$match_count\" in",
    "    0)",
    "      printf '%s\\n' 'local-ydb generated config.yaml was not found under /ydb_data' >&2",
    "      exit 1",
    "      ;;",
    "    1)",
    `      ${variableName}=$matches`,
    "      ;;",
    "    *)",
    "      printf '%s\\n' 'multiple local-ydb generated config.yaml files found under /ydb_data:' >&2",
    "      printf '%s\\n' \"$matches\" >&2",
    "      exit 1",
    "      ;;",
    "  esac",
    "fi"
  ];
}

export function commandForStaticGeneratedConfigPath(staticContainer: string): string {
  const variableName = "generated_config";
  const script = [
    ...generatedConfigDiscoveryLines(variableName),
    `printf '%s\\n' "$${variableName}"`
  ].join("\n");
  return `docker exec ${shellQuote(staticContainer)} sh -lc ${shellQuote(script)}`;
}

function assertShellVariableName(variableName: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variableName)) {
    throw new Error(`Invalid shell variable name: ${variableName}`);
  }
}
