import { describe, it, expect } from "vitest";

import { startCandidateDeadline } from "../../open-sse/services/candidateDeadline.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("combo candidate deadline", () => {
  it("is not armed for the last candidate (last seat must fail open)", () => {
    expect(startCandidateDeadline({ hasNext: false })).toBeNull();
    expect(startCandidateDeadline()).toBeNull();
    expect(startCandidateDeadline({ hasNext: false, deadlineMs: 10 })).toBeNull();
  });

  it("cuts the seat with a TimeoutError once the deadline elapses", async () => {
    const seat = startCandidateDeadline({ hasNext: true, deadlineMs: 20 });
    expect(seat.aborted).toBe(false);
    await wait(80);
    expect(seat.aborted).toBe(true);
    expect(seat.signal.reason?.name).toBe("TimeoutError");
  });

  it("stops aborting after disarm, so a committed stream is never cut", async () => {
    const seat = startCandidateDeadline({ hasNext: true, deadlineMs: 20 });
    seat.disarm();
    await wait(80);
    expect(seat.aborted).toBe(false);
  });

  it("hands the follow-up peek the remaining time, floored at one second", async () => {
    const roomy = startCandidateDeadline({ hasNext: true, deadlineMs: 5000 });
    expect(roomy.remainingMs()).toBeGreaterThan(1000);
    roomy.disarm();

    const spent = startCandidateDeadline({ hasNext: true, deadlineMs: 1 });
    await wait(40);
    expect(spent.remainingMs()).toBe(1000);
    spent.disarm();
  });

  it("never disables itself on a non-positive deadline", () => {
    const seat = startCandidateDeadline({ hasNext: true, deadlineMs: 0 });
    expect(seat.ms).toBe(45 * 1000);
    seat.disarm();
    const negative = startCandidateDeadline({ hasNext: true, deadlineMs: -5 });
    expect(negative.ms).toBe(45 * 1000);
    negative.disarm();
  });
});
