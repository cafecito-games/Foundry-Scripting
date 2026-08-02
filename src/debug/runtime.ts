import * as vscode from "vscode";
import type { ResolveWorkspaceProject } from "../project/workspace.js";
import type {
  DapSessionLease,
  DisposableHandle,
  ToolingEndpoint,
  ToolingHostCoordinator,
  ToolingHostCoordinatorState,
  ToolingHostMode,
} from "../tooling/coordinator.js";
import {
  FOUNDRYSCRIPT_DEBUG_TYPE,
  FoundryScriptDebugConfigurationProvider,
} from "./configuration.js";
import {
  contextualizeDebugStartupFailure,
  probeLoopbackDebugAdapter,
} from "./lifecycle.js";

export interface FoundryScriptDebugRuntimeOptions {
  readonly resolveProject: ResolveWorkspaceProject;
  readonly getCoordinator: () => ToolingHostCoordinator | undefined;
  readonly getMode: () => ToolingHostMode;
  readonly output: vscode.OutputChannel;
  readonly probeEndpoint?: (
    endpoint: ToolingEndpoint,
    signal: AbortSignal,
  ) => Promise<void>;
}

interface DebugSessionAcquisition {
  readonly controller: AbortController;
  readonly session: vscode.DebugSession;
  lease?: DapSessionLease;
  coordinatorSubscription?: DisposableHandle;
}

interface FailedSessionDrain {
  readonly session: vscode.DebugSession;
  stopRequest: "pending" | "fulfilled" | "rejected";
  terminationObserved: boolean;
}

export interface FoundryScriptDebugRuntime {
  dispose(): void;
  shutdown(): Promise<void>;
}

export function registerFoundryScriptDebugRuntime(
  context: vscode.ExtensionContext,
  options: FoundryScriptDebugRuntimeOptions,
): FoundryScriptDebugRuntime {
  const sessions = new Map<string, DebugSessionAcquisition>();
  const drainingSessions = new Map<string, FailedSessionDrain>();
  const loggedLaunches = new Set<string>();
  const reportedFailures = new Set<string>();
  const contextualizeStartupFailure = (
    session: vscode.DebugSession,
    error: unknown,
  ): Error =>
    contextualizeDebugStartupFailure(
      options.getMode(),
      session.configuration.project,
      error,
    );
  const reportStartupFailure = (
    session: vscode.DebugSession,
    error: Error,
  ): void => {
    if (reportedFailures.has(session.id)) return;
    reportedFailures.add(session.id);
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
    acquisition.coordinatorSubscription?.dispose();
    acquisition.lease?.release();
    options.output.appendLine(
      `[${session.id}] FoundryScript debug session ended (${reason}); released the DAP lease.`,
    );
  };
  const reportSessionFailure = (
    session: vscode.DebugSession,
    error: Error,
  ): boolean => {
    if (reportedFailures.has(session.id)) return false;
    reportedFailures.add(session.id);
    const acquisition = sessions.get(session.id);
    const message =
      `FoundryScript debug adapter failure in ${options.getMode()} mode ` +
      `for project ${String(session.configuration.project)}: ${error.message}` +
      (acquisition?.lease === undefined
        ? ". "
        : ` at endpoint ${acquisition.lease.endpoint.host}:${String(acquisition.lease.endpoint.port)}. `) +
      "Check FoundryScript Debug output and the foundryScript.lsp.mode setting.";
    options.output.appendLine(`[${session.id}] ${message}`);
    void vscode.window.showErrorMessage(message);
    return true;
  };
  const failSession = (session: vscode.DebugSession, error: Error): void => {
    if (!reportSessionFailure(session, error)) return;
    endSession(session, "debug adapter failure");
  };
  const completeFailedSessionDrain = (drain: FailedSessionDrain): void => {
    if (
      drainingSessions.get(drain.session.id) !== drain ||
      drain.stopRequest === "pending" ||
      (drain.stopRequest === "rejected" && !drain.terminationObserved)
    ) {
      return;
    }
    drainingSessions.delete(drain.session.id);
    endSession(drain.session, "owned tooling host failure");
    options.output.appendLine(
      `[${drain.session.id}] Owned tooling-host failure drain completed; ` +
        "replacement debug sessions may start.",
    );
  };
  const stopAfterHostFailure = (
    session: vscode.DebugSession,
    acquisition: DebugSessionAcquisition,
    state: ToolingHostCoordinatorState,
  ): void => {
    if (
      state.kind !== "failed" ||
      sessions.get(session.id) !== acquisition ||
      acquisition.lease?.ownership !== "owned"
    ) {
      return;
    }
    const error =
      state.error instanceof Error
        ? state.error
        : new Error(String(state.error));
    if (!reportSessionFailure(session, error)) return;
    const drain: FailedSessionDrain = {
      session,
      stopRequest: "pending",
      terminationObserved: false,
    };
    drainingSessions.set(session.id, drain);
    acquisition.controller.abort();
    void Promise.resolve()
      .then(() => vscode.debug.stopDebugging(session))
      .then(
        () => {
          drain.stopRequest = "fulfilled";
          completeFailedSessionDrain(drain);
        },
        (stopError: unknown) => {
          drain.stopRequest = "rejected";
          options.output.appendLine(
            `[${session.id}] Unable to stop the failed FoundryScript debug session: ` +
              `${stopError instanceof Error ? stopError.message : String(stopError)}`,
          );
          completeFailedSessionDrain(drain);
        },
      );
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
    const activeSession = sessions.values().next().value;
    const activeSessionId =
      activeSession?.session.id ?? drainingSessions.keys().next().value;
    if (activeSessionId !== undefined) {
      const error = contextualizeStartupFailure(
        session,
        new Error(
          `A FoundryScript debug session (${activeSessionId}) is already active. ` +
            "Stop it before starting another.",
        ),
      );
      reportStartupFailure(session, error);
      throw error;
    }
    reportedFailures.delete(session.id);
    const controller = new AbortController();
    const acquisition: DebugSessionAcquisition = { controller, session };
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
      if (typeof coordinator.onStateChange === "function") {
        acquisition.coordinatorSubscription = coordinator.onStateChange(
          (state) => stopAfterHostFailure(session, acquisition, state),
        );
      }
      if (lease.released) {
        throw new Error(
          "The Foundry tooling host endpoint became stale before debug adapter connection.",
        );
      }
      if (lease.ownership === "external") {
        options.output.appendLine(
          `[${session.id}] Checking external FoundryScript DAP endpoint ` +
            `${lease.endpoint.host}:${String(lease.endpoint.port)} before launch.`,
        );
        try {
          await (options.probeEndpoint ?? probeLoopbackDebugAdapter)(
            lease.endpoint,
            controller.signal,
          );
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") throw error;
          throw new Error(
            `External FoundryScript DAP endpoint ${lease.endpoint.host}:${String(lease.endpoint.port)} ` +
              `is unavailable. Verify the external tooling host and foundryScript.dap.port, then retry. ` +
              `${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }
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
        acquisition.coordinatorSubscription?.dispose();
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
    vscode.debug.onDidTerminateDebugSession((session) => {
      const drain = drainingSessions.get(session.id);
      if (drain !== undefined) drain.terminationObserved = true;
      endSession(session, "VS Code termination");
      if (drain !== undefined) completeFailedSessionDrain(drain);
    }),
  ];
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const acquisition of sessions.values()) {
      acquisition.controller.abort();
      acquisition.coordinatorSubscription?.dispose();
      acquisition.lease?.release();
    }
    sessions.clear();
    drainingSessions.clear();
    loggedLaunches.clear();
    reportedFailures.clear();
    for (const registration of registrations) registration.dispose();
  };
  const runtime: FoundryScriptDebugRuntime = {
    dispose,
    shutdown: async () => {
      if (disposed) return;
      const activeSessions = [...sessions.entries()];
      for (const [, acquisition] of activeSessions) {
        acquisition.controller.abort();
      }
      await Promise.all(
        activeSessions.map(async ([id, acquisition]) => {
          try {
            await vscode.debug.stopDebugging(acquisition.session);
          } catch (error) {
            options.output.appendLine(
              `[${id}] Unable to stop FoundryScript debugging during deactivation: ` +
                `${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }),
      );
      dispose();
    },
  };
  context.subscriptions.push(runtime);
  return runtime;
}
