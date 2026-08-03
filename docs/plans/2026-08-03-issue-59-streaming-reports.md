# Issue #59: Streaming Reports and Bounded Output Plan

> **For implementation:** Follow the FoundryScript repo skill and strict TDD. Read GitHub issue #59's current Mechanical implementation contract in full; it is authoritative.

**Goal:** Make TAP report polling and subprocess diagnostic retention scale linearly and remain bounded without changing execution outcomes, early point publication, or cleanup behavior.

**Architecture:** Extract an incremental report reader with one retained file handle, identity/offset tracking, 64 KiB streaming chunks, per-block digests, and one final sequential integrity pass. Replace unbounded process strings with independent chunked newest-suffix tails while leaving output observers lossless.

**Tech stack:** TypeScript, Node `fs/promises` file handles and `crypto`, Vitest fakes/timers.

---

## Task 1: Build the incremental report-reader core

**Files:**
- Create: `src/testing/report-reader.test.ts`
- Create: `src/testing/report-reader.ts`

1. Define a narrow injectable file-access seam and an in-memory fake recording stat/open/read/close calls, positions, sizes, and maximum returned buffer.
2. Add failing tests for:
   - absent-before-first-byte behavior;
   - initial and appended range reads capped at 64 KiB;
   - unchanged polls performing no content read;
   - truncation and file-identity replacement;
   - same-identity consumed-prefix mutation found by final verification;
   - exact-size/identity final verification;
   - idempotent handle closure.
3. Run `npm test -- src/testing/report-reader.test.ts` and observe module/behavior failures.
4. Implement identity/offset tracking, fixed-block streamed hashes, at most one partial hashing state, incremental `readAvailable()`, `verifyFinal()`, and `close()`. Normalize filesystem errors without hiding non-ENOENT failures.
5. Re-run focused tests, typecheck, and lint.
6. Commit: `feat: stream and verify TAP report artifacts`.

## Task 2: Integrate incremental reads into test execution

**Files:**
- Modify: `src/testing/executor.test.ts`
- Modify: `src/testing/executor.ts`

1. Replace test fixtures' whole-buffer reader seam with the incremental file-access fake/helper.
2. Add failing executor tests proving:
   - at least 2 MiB over at least 256 growth steps stays within `2 * finalSize + 64 KiB` content bytes and 64 KiB max reads;
   - unchanged polling reads no content;
   - complete points publish before exit;
   - truncation/replacement/prefix mutation map to `malformed_report`;
   - handle closes before temporary-directory removal on success, cancellation, readiness timeout, parser/malformed failure, process failure, and read failure;
   - existing missing-final/partial-cancellation classifications remain exact.
3. Run `npm test -- src/testing/executor.test.ts` and observe failures.
4. Make `FoundryTestExecutor` own one report reader per execution. Feed only appended chunks to the parser, run final growth plus verification when appropriate, and close in `finally` before directory removal.
5. Preserve first-byte readiness, user-cancellation precedence, process-result details, and cleanup error isolation.
6. Re-run report-reader/executor tests, typecheck, and lint.
7. Commit: `feat: consume test reports incrementally`.

## Task 3: Bound subprocess diagnostic retention

**Files:**
- Modify: `src/testing/process.test.ts`
- Modify: `src/testing/process.ts`

1. Add failing tests for exact at/below/over-limit suffixes, multi-megabyte independent stdout/stderr, many small chunks, complete observer delivery, cancellation/hard-deadline bounds, and invalid injected limits.
2. Run `npm test -- src/testing/process.test.ts` and observe unbounded/validation failures.
3. Implement a chunked tail with default 65,536 UTF-16 code units per stream, O(new text + discarded chunks) append work, and one bounded join at result creation. Validate the injected limit synchronously as a positive integer.
4. Update result documentation to state stdout/stderr are diagnostic tails; do not change callers.
5. Re-run focused tests, typecheck, and lint.
6. Commit: `feat: bound test process diagnostic tails`.

## Task 4: Full-scale and regression audit

1. Run all three focused suites together and audit instrumentation: stable-report total bytes ≤ `2N + 64 KiB`, max read ≤ 64 KiB, no whole report buffer retained, observers receive all output.
2. Run the exact clean gate:

   ```bash
   npm ci
   npm run build
   npm run typecheck
   npm run lint
   npm test
   ```

3. Confirm no open handles, unhandled rejections, timer warnings, or material slow-suite regression.
4. Review every issue acceptance and mechanical-contract bullet. Add any missing boundary test before production repair and commit focused audit fixes separately.

No real engine or manual Extension Development Host check is required for this internal streaming/performance change.
