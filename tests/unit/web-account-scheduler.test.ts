import test from "node:test";
import assert from "node:assert/strict";

import { computeWebAccountDelayMs } from "../../open-sse/services/webAccountScheduler.ts";

test("computeWebAccountDelayMs does not delay the first request", () => {
  assert.equal(
    computeWebAccountDelayMs({
      lastStartAt: null,
      now: 10_000,
      randomValue: 0.5,
    }),
    0
  );
});

test("computeWebAccountDelayMs applies a bounded 2-8 second jitter", () => {
  assert.equal(
    computeWebAccountDelayMs({
      lastStartAt: 10_000,
      now: 10_000,
      randomValue: 0,
    }),
    2_000
  );
  assert.equal(
    computeWebAccountDelayMs({
      lastStartAt: 10_000,
      now: 10_000,
      randomValue: 1,
    }),
    8_000
  );
  assert.equal(
    computeWebAccountDelayMs({
      lastStartAt: 10_000,
      now: 20_000,
      randomValue: 1,
    }),
    0
  );
});
