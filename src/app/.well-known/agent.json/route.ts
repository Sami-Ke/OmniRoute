/**
 * Agent Card Endpoint — /.well-known/agent.json
 *
 * Serves the OmniRoute A2A Agent Card for discovery by other agents.
 * Conforms to A2A Protocol v0.3.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { buildAgentCard } from "@/lib/a2a/agentCard";

/**
 * GET /.well-known/agent.json
 */
export async function GET(request?: NextRequest) {
  const agentCard = await buildAgentCard(request);

  return NextResponse.json(agentCard, {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/json",
    },
  });
}
