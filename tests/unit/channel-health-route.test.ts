import test from "node:test";
import assert from "node:assert/strict";

import { classifyChannelStatus } from "../../src/app/api/v1/channels/route.ts";

test("classifyChannelStatus distinguishes healthy, degraded, and down pools", () => {
  assert.equal(
    classifyChannelStatus({ configured: 2, active: 2, unavailable: 0, breakerState: "CLOSED" }),
    "healthy"
  );
  assert.equal(
    classifyChannelStatus({ configured: 2, active: 2, unavailable: 1, breakerState: "CLOSED" }),
    "degraded"
  );
  assert.equal(
    classifyChannelStatus({ configured: 2, active: 2, unavailable: 0, breakerState: "HALF_OPEN" }),
    "degraded"
  );
  assert.equal(
    classifyChannelStatus({ configured: 0, active: 0, unavailable: 0, breakerState: "CLOSED" }),
    "down"
  );
  assert.equal(
    classifyChannelStatus({ configured: 2, active: 2, unavailable: 0, breakerState: "OPEN" }),
    "down"
  );
});
