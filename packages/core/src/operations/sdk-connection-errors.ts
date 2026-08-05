export type SdkConnectionPhase =
  | "remoteCredentialRead"
  | "dockerTargetResolution"
  | "sshListenerSetup"
  | "ydbTargetReadiness";

const SDK_CONNECTION_DIAGNOSTICS: Record<SdkConnectionPhase, string> = {
  remoteCredentialRead: "Remote YDB credential read failed.",
  dockerTargetResolution: "Docker SDK target resolution failed.",
  sshListenerSetup: "SSH listener setup failed.",
  ydbTargetReadiness: "YDB target readiness check failed.",
};

export class SdkConnectionPhaseError extends Error {
  constructor(readonly phase: SdkConnectionPhase) {
    super(SDK_CONNECTION_DIAGNOSTICS[phase]);
    this.name = "SdkConnectionPhaseError";
  }
}

export function sdkConnectionSetupDiagnostic(error: unknown): string | undefined {
  return error instanceof SdkConnectionPhaseError ? error.message : undefined;
}
