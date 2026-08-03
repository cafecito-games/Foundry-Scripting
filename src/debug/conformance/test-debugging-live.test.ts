import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { FoundryTap13Parser } from "../../testing/report.js";
import { DapClient } from "./client.js";
import type { DapEvent, DapResponse } from "./protocol.js";
import { withTimeout } from "./protocol.js";
import { LiveConformanceHost } from "./session.js";

const required = process.env.FOUNDRY_TEST_DEBUG_CONFORMANCE_REQUIRED === "1";
const liveIt = required ? it : it.skip;
const enginePath = process.env.FOUNDRY_ENGINE_PATH;
const fixturePath = join(__dirname, "..", "fixtures", "test-debugging");
const breakpointLine = 49;

function body(response: DapResponse): Record<string, unknown> {
  return response.body ?? {};
}

async function succeeds(
  client: DapClient,
  command: string,
  argumentsValue: Record<string, unknown>,
  timeoutMs = 30_000,
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

async function initialize(client: DapClient): Promise<void> {
  await succeeds(client, "initialize", {
    adapterID: "foundry",
    linesStartAt1: true,
    columnsStartAt1: true,
    supportsVariableType: true,
  });
  await client.event("initialized", 0, 30_000);
}

function launchArguments(
  project: string,
  report: string,
  testIds: readonly string[],
  protocolVersion = 1,
): Record<string, unknown> {
  return {
    project,
    noDebug: false,
    "foundry/launch": {
      kind: "project_test",
      runner: "res://test_runner.fs",
      adapter: { protocolVersion, report, testIds: [...testIds] },
    },
  };
}

interface NaturalLaunch {
  readonly process: DapEvent;
  readonly exited: DapEvent;
  readonly terminated: DapEvent;
}

async function launchNaturally(
  client: DapClient,
  argumentsValue: Record<string, unknown>,
): Promise<NaturalLaunch> {
  const mark = client.mark();
  const launchSequence = client.request("launch", argumentsValue);
  const configurationSequence = client.request("configurationDone", {});
  expect((await client.response(configurationSequence, 30_000)).success).toBe(true);
  expect((await client.response(launchSequence, 60_000)).success).toBe(true);
  const process = await client.event("process", mark, 30_000);
  const exited = await client.event("exited", mark, 120_000);
  const terminated = await client.event("terminated", mark, 30_000);
  expect(client.indexOf(process)).toBeLessThan(client.indexOf(exited));
  expect(client.indexOf(exited)).toBeLessThan(client.indexOf(terminated));
  return { process, exited, terminated };
}

async function parseReport(
  reportPath: string,
  ids: readonly string[],
  exitCode: number,
): Promise<readonly string[]> {
  const points: string[] = [];
  const parser = new FoundryTap13Parser(
    ids.map((id) => ({ id, skipped: false, skipReason: null })),
    (point) => points.push(point.testId),
  );
  parser.push(await readFile(reportPath));
  expect(parser.finish({ kind: "exited", exitCode })).toMatchObject({
    valid: true,
    complete: true,
    classification: exitCode === 0 ? "conforming" : "test_failures",
  });
  return points;
}

async function waitForPartialReport(reportPath: string): Promise<Buffer> {
  return withTimeout(
    new Promise<Buffer>((resolve) => {
      const poll = (): void => {
        void readFile(reportPath).then(
          (bytes) => {
            if (bytes.toString().includes("  ...\n")) resolve(bytes);
            else setTimeout(poll, 20);
          },
          () => setTimeout(poll, 20),
        );
      };
      poll();
    }),
    30_000,
    `partial TAP report ${reportPath}`,
  );
}

function messagesSince(client: DapClient, mark: number): readonly string[] {
  return client
    .receivedMessages()
    .filter(({ index }) => index >= mark)
    .flatMap(({ message }) =>
      message.type === "event" ? [message.event] : [],
    );
}

describe("Foundry real-engine selected-test debugging", () => {
  liveIt(
    "proves the complete structured project_test DAP matrix",
    async () => {
      expect(enginePath, "FOUNDRY_ENGINE_PATH").toBeTypeOf("string");
      await LiveConformanceHost.run(
        enginePath!,
        async ({ client, projectPath }) => {
          await initialize(client);
          const projectText = await readFile(
            join(projectPath, "project.foundry"),
            "utf8",
          );
          expect(projectText).not.toContain("run/main_scene");

          const oneId = ["pass::one"];
          const oneReport = join(projectPath, "one.tap");
          const one = await launchNaturally(
            client,
            launchArguments(projectPath, oneReport, oneId),
          );
          expect(one.exited.body?.exitCode).toBe(0);
          expect(await parseReport(oneReport, oneId, 0)).toEqual(oneId);

          const twoIds = ["pass::first", "pass::second"];
          const twoReport = join(projectPath, "two.tap");
          const two = await launchNaturally(
            client,
            launchArguments(projectPath, twoReport, twoIds),
          );
          expect(two.exited.body?.exitCode).toBe(0);
          expect(await parseReport(twoReport, twoIds, 0)).toEqual(twoIds);

          const failureIds = ["fail::represented"];
          const failureReport = join(projectPath, "failure.tap");
          const failure = await launchNaturally(
            client,
            launchArguments(projectPath, failureReport, failureIds),
          );
          expect(failure.exited.body?.exitCode).toBe(1);
          expect(await parseReport(failureReport, failureIds, 1)).toEqual(
            failureIds,
          );

          const unknownReport = join(projectPath, "unknown.tap");
          const unknown = await launchNaturally(
            client,
            launchArguments(projectPath, unknownReport, ["unknown::id"]),
          );
          expect(unknown.exited.body?.exitCode).toBe(2);
          await expect(readFile(unknownReport)).rejects.toMatchObject({
            code: "ENOENT",
          });

          const malformedSequence = client.request(
            "launch",
            launchArguments(
              projectPath,
              join(projectPath, "unsupported.tap"),
              oneId,
              2,
            ),
          );
          await expect(client.response(malformedSequence, 10_000)).resolves.toMatchObject(
            { success: false, command: "launch", message: "invalid_launch" },
          );

          const runnerPath = join(projectPath, "test_runner.fs");
          const breakpoints = await succeeds(client, "setBreakpoints", {
            source: { path: runnerPath },
            breakpoints: [{ line: breakpointLine }],
          });
          const registered = body(breakpoints).breakpoints as Array<
            Record<string, unknown>
          >;
          expect(registered).toHaveLength(1);
          expect(registered[0]).toMatchObject({
            verified: true,
            line: breakpointLine,
          });

          const restartIds = ["restart::selected"];
          const restartReport = join(projectPath, "restart.tap");
          const restartArguments = launchArguments(
            projectPath,
            restartReport,
            restartIds,
          );
          let mark = client.mark();
          const launchSequence = client.request("launch", restartArguments);
          const configurationSequence = client.request("configurationDone", {});
          expect((await client.response(configurationSequence)).success).toBe(true);
          expect((await client.response(launchSequence, 60_000)).success).toBe(true);
          await client.event("process", mark, 30_000);
          let stopped = await client.event("stopped", mark, 30_000);
          expect(stopped.body).toMatchObject({ reason: "breakpoint", threadId: 1 });

          const stack = await succeeds(client, "stackTrace", { threadId: 1 });
          const frames = body(stack).stackFrames as Array<Record<string, unknown>>;
          expect(frames[0]).toMatchObject({ name: "run", line: breakpointLine });
          expect(normalize(String((frames[0].source as Record<string, unknown>).path))).toBe(
            normalize(runnerPath),
          );
          const frameId = Number(frames[0].id);
          const scopes = await succeeds(client, "scopes", { frameId });
          const scopeValues = body(scopes).scopes as Array<Record<string, unknown>>;
          const locals = scopeValues.find((scope) => scope.name === "Locals");
          expect(locals).toBeDefined();
          const variables = await succeeds(client, "variables", {
            variablesReference: Number(locals?.variablesReference),
          });
          expect(body(variables).variables).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                name: "inspection_value",
                value: "42",
                type: "int",
              }),
            ]),
          );
          for (const context of ["watch", "hover", "repl"]) {
            const evaluation = await succeeds(client, "evaluate", {
              expression: "inspection_value + selected_count",
              frameId,
              context,
            });
            expect(body(evaluation).result).toBe("43");
          }

          mark = client.mark();
          await succeeds(
            client,
            "restart",
            { arguments: restartArguments },
            60_000,
          );
          await client.event("process", mark, 30_000);
          stopped = await client.event("stopped", mark, 30_000);
          expect(stopped.body).toMatchObject({ reason: "breakpoint", threadId: 1 });
          expect(messagesSince(client, mark)).not.toContain("terminated");
          expect(messagesSince(client, mark)).not.toContain("exited");
          const completionMark = client.mark();
          await succeeds(client, "continue", { threadId: 1 });
          const restartExit = await client.event("exited", completionMark, 120_000);
          await client.event("terminated", completionMark, 30_000);
          expect(restartExit.body?.exitCode).toBe(0);
          expect(await parseReport(restartReport, restartIds, 0)).toEqual(
            restartIds,
          );

          await succeeds(client, "setBreakpoints", {
            source: { path: runnerPath },
            breakpoints: [],
          });
          const cancellationIds = ["cancel::first", "cancel::never"];
          const cancellationReport = join(projectPath, "cancel.tap");
          mark = client.mark();
          const cancellationLaunch = client.request(
            "launch",
            launchArguments(projectPath, cancellationReport, cancellationIds),
          );
          const cancellationConfiguration = client.request(
            "configurationDone",
            {},
          );
          expect((await client.response(cancellationConfiguration)).success).toBe(
            true,
          );
          expect((await client.response(cancellationLaunch, 60_000)).success).toBe(
            true,
          );
          await client.event("process", mark, 30_000);
          const partial = await waitForPartialReport(cancellationReport);
          const terminateMark = client.mark();
          await succeeds(client, "terminate", {}, 60_000);
          await client.event("terminated", terminateMark, 60_000);
          expect(messagesSince(client, terminateMark)).not.toContain("exited");
          const cancellationPoints: string[] = [];
          const cancellationParser = new FoundryTap13Parser(
            cancellationIds.map((id) => ({
              id,
              skipped: false,
              skipReason: null,
            })),
            (point) => cancellationPoints.push(point.testId),
          );
          cancellationParser.push(partial);
          expect(cancellationParser.finish({ kind: "cancelled" })).toMatchObject({
            valid: true,
            complete: false,
            classification: "cancelled",
          });
          expect(cancellationPoints).toEqual(["cancel::first"]);

          await succeeds(client, "threads", {});
        },
        fixturePath,
      );
    },
    480_000,
  );
});
