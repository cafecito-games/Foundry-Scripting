import { join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { LiveConformanceHost } from "./session.js";
import type { DapClient } from "./client.js";
import type { DapEvent, DapResponse } from "./protocol.js";

const required = process.env.FOUNDRY_DAP_CONFORMANCE_REQUIRED === "1";
const liveIt = required ? it : it.skip;
const enginePath = process.env.FOUNDRY_ENGINE_PATH;
const BREAKPOINT_LINE = 7;

function body(response: DapResponse): Record<string, unknown> {
  return response.body ?? {};
}

function records(value: unknown, description: string): Record<string, unknown>[] {
  expect(Array.isArray(value), description).toBe(true);
  return (value as unknown[]).map((entry) => {
    expect(entry, description).toBeTypeOf("object");
    expect(entry, description).not.toBeNull();
    return entry as Record<string, unknown>;
  });
}

async function succeeds(
  client: DapClient,
  command: string,
  argumentsValue: Record<string, unknown>,
  timeoutMs?: number,
): Promise<DapResponse> {
  const sequence = client.request(command, argumentsValue);
  const response = await client.response(sequence, timeoutMs);
  expect(response, JSON.stringify(response)).toMatchObject({
    type: "response",
    request_seq: sequence,
    command,
    success: true,
  });
  return response;
}

async function fails(
  client: DapClient,
  command: string,
  argumentsValue: Record<string, unknown>,
  message: string,
): Promise<DapResponse> {
  const sequence = client.request(command, argumentsValue);
  const response = await client.response(sequence, 10_000);
  expect(response, JSON.stringify(response)).toMatchObject({
    type: "response",
    request_seq: sequence,
    command,
    success: false,
    message,
  });
  expect(body(response).error).toBeTypeOf("object");
  return response;
}

interface StoppedState {
  readonly threadId: number;
  readonly frameId: number;
  readonly localsReference: number;
  readonly membersReference: number;
  readonly globalsReference: number;
}

async function inspectStop(
  client: DapClient,
  stopped: DapEvent,
  scriptPath: string,
  breakpointId: number,
): Promise<StoppedState> {
  expect(stopped.body).toMatchObject({
    reason: "breakpoint",
    threadId: 1,
  });
  expect(stopped.body?.hitBreakpointIds).toBeInstanceOf(Array);
  expect(stopped.body?.hitBreakpointIds as unknown[]).toContain(breakpointId);
  const threadId = stopped.body?.threadId;
  expect(threadId).toBe(1);

  const threadsResponse = await succeeds(client, "threads", {});
  const threads = records(body(threadsResponse).threads, "threads");
  expect(
    threads.some(
      (thread) => thread.id === threadId && typeof thread.name === "string",
    ),
  ).toBe(true);

  const stackResponse = await succeeds(client, "stackTrace", { threadId });
  const frames = records(body(stackResponse).stackFrames, "stackFrames");
  expect(frames.length).toBeGreaterThan(0);
  const frame = frames[0];
  expect(frame.name).toBe("_ready");
  expect(frame.line).toBe(BREAKPOINT_LINE);
  const source = frame.source as Record<string, unknown>;
  expect(normalize(String(source.path))).toBe(normalize(scriptPath));
  const frameId = frame.id;
  expect(frameId).toBeTypeOf("number");

  const scopesResponse = await succeeds(client, "scopes", { frameId });
  const scopes = records(body(scopesResponse).scopes, "scopes");
  const byName = new Map(scopes.map((scope) => [scope.name, scope]));
  expect([...byName.keys()]).toEqual(
    expect.arrayContaining(["Locals", "Members", "Globals"]),
  );
  expect(byName.get("Locals")?.presentationHint).toBe("locals");
  expect(byName.get("Members")?.presentationHint).toBe("members");
  expect(byName.get("Globals")?.presentationHint).toBe("globals");
  const localsReference = Number(byName.get("Locals")?.variablesReference);
  const membersReference = Number(byName.get("Members")?.variablesReference);
  const globalsReference = Number(byName.get("Globals")?.variablesReference);
  expect(localsReference).toBeGreaterThan(0);
  expect(membersReference).toBeGreaterThan(0);
  expect(globalsReference).toBeGreaterThan(0);
  expect(new Set([localsReference, membersReference, globalsReference]).size).toBe(
    3,
  );

  const localsResponse = await succeeds(client, "variables", {
    variablesReference: localsReference,
  });
  const localVariables = records(body(localsResponse).variables, "locals");
  expect(localVariables).toContainEqual(
    expect.objectContaining({
      name: "local_value",
      value: "7",
      type: "int",
      variablesReference: 0,
    }),
  );
  const membersResponse = await succeeds(client, "variables", {
    variablesReference: membersReference,
  });
  const memberVariables = records(body(membersResponse).variables, "members");
  expect(memberVariables).toContainEqual(
    expect.objectContaining({
      name: "member_value",
      value: "35",
      type: "int",
      variablesReference: 0,
    }),
  );
  const globalsResponse = await succeeds(client, "variables", {
    variablesReference: globalsReference,
  });
  records(body(globalsResponse).variables, "globals");

  for (const context of ["watch", "hover", "repl"]) {
    const evaluation = await succeeds(client, "evaluate", {
      expression: "local_value + member_value",
      frameId,
      context,
    });
    expect(body(evaluation)).toMatchObject({
      result: "42",
      variablesReference: 0,
    });
  }

  return {
    threadId: Number(threadId),
    frameId: Number(frameId),
    localsReference,
    membersReference,
    globalsReference,
  };
}

async function launchToBreakpoint(
  client: DapClient,
  launchArguments: Record<string, unknown>,
  afterIndex: number,
): Promise<{ readonly process: DapEvent; readonly stopped: DapEvent }> {
  const launchSequence = client.request("launch", launchArguments);
  const configurationSequence = client.request("configurationDone", {});
  const launchResponse = await client.response(launchSequence, 60_000);
  const configurationResponse = await client.response(
    configurationSequence,
    30_000,
  );
  expect(launchResponse.success).toBe(true);
  expect(configurationResponse.success).toBe(true);
  const process = await client.event("process", afterIndex);
  const stopped = await client.event("stopped", afterIndex, 30_000);
  expect(client.indexOf(process)).toBeLessThan(client.indexOf(stopped));
  return { process, stopped };
}

async function expectNaturalCompletion(
  client: DapClient,
  threadId: number,
  afterIndex: number,
): Promise<void> {
  await succeeds(client, "continue", { threadId });
  const exited = await client.event("exited", afterIndex);
  const terminated = await client.event("terminated", afterIndex);
  expect(exited.body?.exitCode).toBe(0);
  expect(client.indexOf(exited)).toBeLessThan(client.indexOf(terminated));
}

async function initializeClient(client: DapClient): Promise<void> {
  const initialize = await succeeds(client, "initialize", {
    adapterID: "foundry",
    linesStartAt1: true,
    columnsStartAt1: true,
    supportsVariableType: true,
  });
  expect(body(initialize)).toMatchObject({
    supportsSetVariable: false,
    supportsEvaluateForHovers: true,
    supportsRestartRequest: true,
  });
  expect(body(initialize).supportsConditionalBreakpoints).not.toBe(true);
  expect(body(initialize).supportsHitConditionalBreakpoints).not.toBe(true);
  expect(body(initialize).supportsLogPoints).not.toBe(true);
  await client.event("initialized", 0, 30_000);
}

describe("Foundry real-engine DAP conformance", () => {
  liveIt(
    "proves breakpoint, inspection, evaluation, stepping, restart, and sequential lifecycle conformance",
    async () => {
      expect(enginePath, "FOUNDRY_ENGINE_PATH").toBeTypeOf("string");
      await LiveConformanceHost.run(enginePath!, async (host) => {
        let client = host.client;
        const { projectPath } = host;
        await initializeClient(client);

        await fails(client, "stepOut", { threadId: 1 }, "not_running");
        await fails(
          client,
          "setVariable",
          { variablesReference: 1, name: "member_value", value: "12" },
          "unsupported_request",
        );
        await fails(
          client,
          "foundryNoSuchCommand",
          { payload: "unused" },
          "unsupported_request",
        );
        await succeeds(client, "threads", {});

        const scriptPath = join(projectPath, "breakpoint_hit.fs");
        const setBreakpoints = await succeeds(client, "setBreakpoints", {
          source: { path: scriptPath },
          breakpoints: [{ line: BREAKPOINT_LINE }],
        });
        const breakpoints = records(body(setBreakpoints).breakpoints, "breakpoints");
        expect(breakpoints).toHaveLength(1);
        expect(breakpoints[0]).toMatchObject({
          verified: true,
          line: BREAKPOINT_LINE,
        });
        expect(breakpoints[0].id).toBeTypeOf("number");
        const breakpointId = Number(breakpoints[0].id);
        const launchArguments = {
          project: projectPath,
          noDebug: false,
          scene: "main",
          playArgs: ["--foundryscript-dap-conformance"],
        };

        const firstMark = client.mark();
        const first = await launchToBreakpoint(client, launchArguments, firstMark);
        await inspectStop(
          client,
          first.stopped,
          scriptPath,
          breakpointId,
        );

        const restartMark = client.mark();
        const restart = await succeeds(
          client,
          "restart",
          { arguments: launchArguments },
          60_000,
        );
        expect(restart.success).toBe(true);
        const restartedProcess = await client.event("process", restartMark);
        const restartedStop = await client.event("stopped", restartMark);
        expect(client.indexOf(restartedProcess)).toBeLessThan(
          client.indexOf(restartedStop),
        );
        const restartLifecycle = client
          .receivedMessages()
          .filter(({ index }) => index >= restartMark)
          .flatMap(({ message }) =>
            message.type === "event" &&
            ["process", "exited", "terminated"].includes(message.event)
              ? [message.event]
              : [],
          );
        expect(restartLifecycle).toEqual(["process"]);
        const restartedState = await inspectStop(
          client,
          restartedStop,
          scriptPath,
          breakpointId,
        );
        let stepMark = client.mark();
        const nextResponse = await succeeds(client, "next", {
          threadId: restartedState.threadId,
        });
        const afterNext = await client.event("stopped", stepMark);
        expect(client.indexOf(nextResponse)).toBeLessThan(client.indexOf(afterNext));
        expect(afterNext.body?.reason).toBe("step");
        const afterNextStack = await succeeds(client, "stackTrace", {
          threadId: restartedState.threadId,
        });
        expect(
          records(body(afterNextStack).stackFrames, "step-over stack")[0],
        ).toMatchObject({ name: "_ready", line: 8 });

        stepMark = client.mark();
        const stepInResponse = await succeeds(client, "stepIn", {
          threadId: restartedState.threadId,
        });
        const afterStepIn = await client.event("stopped", stepMark);
        expect(client.indexOf(stepInResponse)).toBeLessThan(
          client.indexOf(afterStepIn),
        );
        expect(afterStepIn.body?.reason).toBe("step");
        const innerStack = await succeeds(client, "stackTrace", {
          threadId: restartedState.threadId,
        });
        expect(records(body(innerStack).stackFrames, "step-in stack")[0].name).toBe(
          "outer_step_target",
        );

        stepMark = client.mark();
        const stepOutResponse = await succeeds(client, "stepOut", {
          threadId: restartedState.threadId,
        });
        const afterStepOut = await client.event("stopped", stepMark);
        expect(client.indexOf(stepOutResponse)).toBeLessThan(
          client.indexOf(afterStepOut),
        );
        expect(afterStepOut.body?.reason).toBe("step");
        await expectNaturalCompletion(
          client,
          restartedState.threadId,
          client.mark(),
        );

        await succeeds(client, "disconnect", {
          restart: false,
          terminateDebuggee: false,
        });
        const firstClient = client;
        client = await host.reconnect();
        expect(client).not.toBe(firstClient);
        await initializeClient(client);
        const secondBreakpoints = await succeeds(client, "setBreakpoints", {
          source: { path: scriptPath },
          breakpoints: [{ line: BREAKPOINT_LINE }],
        });
        const secondRegistered = records(
          body(secondBreakpoints).breakpoints,
          "second-session breakpoints",
        );
        expect(secondRegistered).toHaveLength(1);
        expect(secondRegistered[0]).toMatchObject({
          verified: true,
          line: BREAKPOINT_LINE,
        });
        expect(secondRegistered[0].id).toBeTypeOf("number");
        const secondBreakpointId = Number(secondRegistered[0].id);

        const secondMark = client.mark();
        const second = await launchToBreakpoint(client, launchArguments, secondMark);
        const secondState = await inspectStop(
          client,
          second.stopped,
          scriptPath,
          secondBreakpointId,
        );
        expect(secondState.localsReference).toBeGreaterThan(0);
        expect(secondState.membersReference).toBeGreaterThan(0);
        expect(secondState.globalsReference).toBeGreaterThan(0);
        await expectNaturalCompletion(client, secondState.threadId, client.mark());

        await succeeds(client, "disconnect", {
          restart: false,
          terminateDebuggee: false,
        });
        client = await host.reconnect();
        await initializeClient(client);

        const pauseMark = client.mark();
        const idleLaunch = client.request("launch", {
          project: projectPath,
          noDebug: false,
          scene: "res://idle.tscn",
          playArgs: ["--foundryscript-dap-conformance-pause"],
        });
        const idleConfiguration = client.request("configurationDone", {});
        expect((await client.response(idleLaunch, 60_000)).success).toBe(true);
        expect((await client.response(idleConfiguration, 30_000)).success).toBe(true);
        await client.event("process", pauseMark);
        await client.event("output", pauseMark);
        const pauseSequence = client.request("pause", { threadId: 1 });
        const pauseResponse = await client.response(pauseSequence, 30_000);
        expect(pauseResponse.success).toBe(true);
        const paused = await client.event("stopped", pauseMark, 60_000);
        expect(paused.body).toMatchObject({ reason: "paused", threadId: 1 });
        expect(client.indexOf(pauseResponse)).toBeLessThan(client.indexOf(paused));
        const continueMark = client.mark();
        const continueResponse = await succeeds(client, "continue", { threadId: 1 });
        const continued = await client.event("continued", continueMark, 30_000);
        expect(client.indexOf(continueResponse)).toBeLessThan(
          client.indexOf(continued),
        );
        const terminateMark = client.mark();
        await succeeds(client, "terminate", {}, 60_000);
        await client.event("terminated", terminateMark, 60_000);

        await succeeds(client, "threads", {});
        await succeeds(client, "disconnect", {
          restart: false,
          terminateDebuggee: false,
        });
      });
    },
    480_000,
  );
});
