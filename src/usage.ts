import { savePlanUsage, loadPlanUsage } from "./db.js";
import { broadcast, registerConnectSnapshot } from "./wsServer.js";

// Plan usage, the bars Claude Code's /usage shows: the rolling five-hour
// session window and the weekly window, each as percent used and when it
// resets. Claude Code exposes these only to a status-line command
// (`rate_limits` in its input, Pro/Max accounts), so the status line in
// src/scripts/statusline.mjs forwards them here. They're account-wide: any
// interactive session reporting keeps them current. Jarvis's own --print
// runs don't run a status line.

export interface UsageWindow {
  usedPercentage: number;
  resetsAt: number; // ms
}

interface PlanUsage {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  updatedAt: number;
}

let latest = loadPlanUsage() as PlanUsage | undefined;

function parseWindow(raw: any): UsageWindow | undefined {
  const used = Number(raw?.used_percentage);
  const resets = Number(raw?.resets_at); // epoch seconds
  if (!Number.isFinite(used) || used < 0 || used > 100 || !Number.isFinite(resets) || resets <= 0) return undefined;
  return { usedPercentage: used, resetsAt: resets * 1000 };
}

// A window missing from a report is kept from the last one until it resets:
// Claude Code may leave either out, and drops one once it has reset.
function stillCurrent(w: UsageWindow | undefined, now: number): UsageWindow | undefined {
  return w && w.resetsAt > now ? w : undefined;
}

export function recordRateLimits(rateLimits: any): void {
  const now = Date.now();
  const fiveHour = parseWindow(rateLimits?.five_hour) ?? stillCurrent(latest?.fiveHour, now);
  const sevenDay = parseWindow(rateLimits?.seven_day) ?? stillCurrent(latest?.sevenDay, now);
  if (!fiveHour && !sevenDay) return;
  latest = { fiveHour, sevenDay, updatedAt: now };
  savePlanUsage(latest);
  broadcast(usageSnapshot());
}

function usageSnapshot() {
  return { type: "usage", ...(latest ?? {}), now: Date.now() };
}

registerConnectSnapshot(usageSnapshot);
