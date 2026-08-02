import * as vscode from "vscode";
import type { ResolveWorkspaceProject } from "../project/workspace.js";
import type {
  DapSessionLease,
  ToolingHostCoordinator,
  ToolingHostMode,
} from "../tooling/coordinator.js";
import {
  FOUNDRYSCRIPT_DEBUG_TYPE,
  FoundryScriptDebugConfigurationProvider,
} from "./configuration.js";

export interface FoundryScriptDebugRuntimeOptions {
  readonly resolveProject: ResolveWorkspaceProject;
  readonly getCoordinator: () => ToolingHostCoordinator | undefined;
  readonly getMode: () => ToolingHostMode;
  readonly output: vscode.OutputChannel;
}

interface DebugSessionAcquisition {
  readonly controller: AbortController;
  lease?: DapSessionLease;
}

export function registerFoundryScriptDebugRuntime(
  context: vscode.ExtensionContext,
  options: FoundryScriptDebugRuntimeOptions,
): void {
  const sessions = new Map<string, DebugSessionAcquisition>();
  const loggedLaunches = new Set<string>();
  const reportedFailures = new Set<string>();
  const contextualizeStartupFailure = (
    session: vscode.DebugSession,
    error: unknown,
  ): Error => {
    const detail = error instanceof Error ? error.message : String(error);
    return new Error(
      `FoundryScript debug startup failed in ${options.getMode()} mode ` +
        `for project ${String(session.configuration.project)}: ${detail} ` +
        "Check FoundryScript Debug output, verify foundryScript.lsp.mode, " +
        "stop the active debug session if one is running, and retry.",
      { cause: error },
    );
  };
  const reportStartupFailure = (
    session: vscode.DebugSession,
    error: Error,
  ): void => {
    options.output.appendLine(`[${session.id}] ${error.message}`);
    void vscode.window.showErrorMessage(error.message);
  };
  const logLaunch = (session: vscode.DebugSession): void => {
    if (loggedLaunches.has(session.id)) return;
    loggedLaunches.add(session.id);
    const configuration = session.configuration;
    const playArgumentCount = Array.isArray(configuration.playArgs)
      ? configuration.playArgs.length
      : 0;
    options.output.appendLine(
      `[${session.id}] Launching ${String(configuration.scene)} for project ` +
        `${String(configuration.project)} with noDebug=${String(configuration.noDebug === true)} ` +
        `and ${String(playArgumentCount)} play arguments.`,
    );
  };
  const endSession = (session: vscode.DebugSession, reason: string): void => {
    const acquisition = sessions.get(session.id);
    loggedLaunches.delete(session.id);
    if (acquisition === undefined) return;
    sessions.delete(session.id);
    acquisition.controller.abort();
    acquisition.lease?.release();
    options.output.appendLine(
      `[${session.id}] FoundryScript debug session ended (${reason}); released the DAP lease.`,
    );
  };
  const failSession = (session: vscode.DebugSession, error: Error): void => {
    if (reportedFailures.has(session.id)) return;
    reportedFailures.add(session.id);
    const message =
      `FoundryScript debug adapter failure in ${options.getMode()} mode ` +
      `for project ${String(session.configuration.project)}: ${error.message}. ` +
      "Check FoundryScript Debug output and the foundryScript.lsp.mode setting.";
    options.output.appendLine(`[${session.id}] ${message}`);
    void vscode.window.showErrorMessage(message);
    endSession(session, "debug adapter failure");
  };
  const provider = new FoundryScriptDebugConfigurationProvider({
    resolveProject: options.resolveProject,
    reportError: (message) => {
      options.output.appendLine(
        `FoundryScript debug configuration rejected: ${message}`,
      );
      void vscode.window.showErrorMessage(message);
    },
  });
  const createDescriptor = async (
    session: vscode.DebugSession,
  ): Promise<vscode.DebugAdapterServer> => {
    // VS Code 1.90 does not pass a CancellationToken to descriptor factories.
    // Create our controller synchronously before the first await so termination,
    // tracker stop, and runtime disposal can still cancel a pending lease. If VS
    // Code terminates a would-be session before invoking this factory, there is no
    // acquisition to cancel and therefore no lease to release.
    if (sessions.has(session.id)) {
      const error = contextualizeStartupFailure(
        session,
        new Error(
          `FoundryScript session ${session.id} already has a debug adapter.`,
        ),
      );
      reportStartupFailure(session, error);
      throw error;
    }
    reportedFailures.delete(session.id);
    const controller = new AbortController();
    const acquisition: DebugSessionAcquisition = { controller };
    sessions.set(session.id, acquisition);
    try {
      const coordinator = options.getCoordinator();
      if (coordinator === undefined) {
        const mode = options.getMode();
        throw new Error(
          mode === "off"
            ? "FoundryScript debugging is unavailable."
            : "The Foundry tooling host is not ready.",
        );
      }
      const lease = await coordinator.acquireDapLease(controller.signal);
      if (controller.signal.aborted || sessions.get(session.id) !== acquisition) {
        lease.release();
        const error = new Error("FoundryScript debug startup was cancelled.");
        error.name = "AbortError";
        throw error;
      }
      acquisition.lease = lease;
      options.output.appendLine(
        `[${session.id}] Connecting to FoundryScript DAP at 127.0.0.1:${String(lease.endpoint.port)}.`,
      );
      return new vscode.DebugAdapterServer(
        lease.endpoint.port,
        "127.0.0.1",
      );
    } catch (error) {
      if (sessions.get(session.id) === acquisition) {
        sessions.delete(session.id);
        controller.abort();
        acquisition.lease?.release();
      }
      if (!(error instanceof Error && error.name === "AbortError")) {
        const failure = contextualizeStartupFailure(session, error);
        reportStartupFailure(session, failure);
        throw failure;
      }
      throw error;
    }
  };
  const registrations = [
    vscode.debug.registerDebugConfigurationProvider(
      FOUNDRYSCRIPT_DEBUG_TYPE,
      provider,
    ),
    vscode.debug.registerDebugAdapterDescriptorFactory(
      FOUNDRYSCRIPT_DEBUG_TYPE,
      { createDebugAdapterDescriptor: (session) => createDescriptor(session) },
    ),
    vscode.debug.registerDebugAdapterTrackerFactory(
      FOUNDRYSCRIPT_DEBUG_TYPE,
      {
        createDebugAdapterTracker: (session) => ({
          onWillStartSession: () => logLaunch(session),
          onWillStopSession: () => endSession(session, "adapter stopping"),
          onError: (error) => failSession(session, error),
          onExit: (code, signal) =>
            endSession(
              session,
              code === undefined
                ? `adapter exit signal ${signal ?? "unknown"}`
                : `adapter exit code ${String(code)}`,
            ),
        }),
      },
    ),
    vscode.debug.onDidTerminateDebugSession((session) =>
      endSession(session, "VS Code termination"),
    ),
  ];
  context.subscriptions.push({
    dispose: () => {
      for (const acquisition of sessions.values()) {
        acquisition.controller.abort();
        acquisition.lease?.release();
      }
      sessions.clear();
      loggedLaunches.clear();
      reportedFailures.clear();
      for (const registration of registrations) registration.dispose();
    },
  });
}
