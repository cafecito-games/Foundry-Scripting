import { describe, expect, it } from "vitest";
import {
  DapMessageStream,
  DapTranscript,
  encodeDapRequest,
  withTimeout,
} from "./protocol.js";

describe("DAP conformance protocol", () => {
  it("decodes split and coalesced Content-Length frames", () => {
    const stream = new DapMessageStream();
    const first = Buffer.from(
      'Content-Length: 46\r\n\r\n{"type":"event","event":"initialized","seq":1}',
    );
    const second = Buffer.from(
      'Content-Length: 45\r\n\r\n{"type":"event","event":"terminated","seq":2}',
    );

    expect(stream.accept(first.subarray(0, 19))).toEqual([]);
    expect(
      stream.accept(Buffer.concat([first.subarray(19), second])),
    ).toEqual([
      { type: "event", event: "initialized", seq: 1 },
      { type: "event", event: "terminated", seq: 2 },
    ]);
  });

  it("frames requests and retains ordered diagnostic directions", () => {
    const transcript = new DapTranscript();
    const request = {
      seq: 7,
      type: "request" as const,
      command: "threads",
      arguments: {},
    };
    transcript.record("send", request);
    transcript.record("receive", {
      seq: 8,
      type: "response",
      request_seq: 7,
      command: "threads",
      success: true,
    });

    const encoded = encodeDapRequest(request);
    expect(encoded.toString()).toContain("Content-Length: 61\r\n\r\n");
    expect(transcript.format()).toBe(
      '[send] {"seq":7,"type":"request","command":"threads","arguments":{}}\n' +
        '[receive] {"seq":8,"type":"response","request_seq":7,"command":"threads","success":true}',
    );
  });

  it("reports the bounded operation in timeout diagnostics", async () => {
    await expect(
      withTimeout(new Promise<never>(() => undefined), 10, "evaluate response"),
    ).rejects.toThrow("Timed out after 10ms waiting for evaluate response.");
  });
});
