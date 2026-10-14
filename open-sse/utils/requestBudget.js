// Cancellation belongs to the waiter, not to shared credential refresh work.
export function createRequestBudget({ signal, deadlineAt = Infinity } = {}) {
  const controller = new AbortController();
  let timer;
  let committed = false;
  const abort = () => controller.abort(signal?.reason || new DOMException("Request aborted", "AbortError"));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  if (Number.isFinite(deadlineAt)) {
    timer = setTimeout(() => controller.abort(Object.assign(new Error("Request precommit deadline exceeded"), { name: "TimeoutError", status: 504 })), Math.max(0, deadlineAt - performance.now()));
    timer?.unref?.();
  }
  const check = () => {
    if (!committed && performance.now() >= deadlineAt && !controller.signal.aborted) {
      controller.abort(Object.assign(new Error("Request precommit deadline exceeded"), { name: "TimeoutError", status: 504 }));
    }
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  return {
    signal: controller.signal,
    deadlineAt,
    check,
    async wait(work) {
      // Eager callers may already have started work; always observe its rejection.
      const observed = typeof work === "function" ? null : Promise.resolve(work);
      observed?.catch(() => {});
      check();
      let listener;
      try {
        return await Promise.race([
          observed || Promise.resolve().then(() => { check(); return work(); }),
          new Promise((_, reject) => {
            listener = () => reject(controller.signal.reason);
            controller.signal.addEventListener("abort", listener, { once: true });
            if (controller.signal.aborted) listener();
          }),
        ]);
      } finally {
        controller.signal.removeEventListener("abort", listener);
      }
    },
    disableDeadline() { deadlineAt = Infinity; this.deadlineAt = Infinity; clearTimeout(timer); },
    commit() { check(); committed = true; clearTimeout(timer); },
    dispose() { clearTimeout(timer); signal?.removeEventListener("abort", abort); },
  };
}

export function localTerminationResult(error) {
  const status = error?.name === "TimeoutError" || error?.status === 504 ? 504 : 499;
  const message = status === 504 ? "Request timed out before response started" : "Request aborted";
  return { success: false, status, error: message, localTermination: true,
    response: new Response(JSON.stringify({ error: { message } }), {
      status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    }),
  };
}
