import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "../package.json";

const telemetry = { enabled: false, shutdown: async () => {} };
const registerTelemetry = vi.fn(() => telemetry);
const installShutdownFlush = vi.fn();
vi.mock("@asafarim/telemetry", () => ({ registerTelemetry, installShutdownFlush }));

const { register } = await import("../instrumentation");

describe("instrumentation: telemetry for the console (P6.2)", () => {
  const runtime = process.env.NEXT_RUNTIME;
  beforeEach(() => {
    registerTelemetry.mockClear();
    installShutdownFlush.mockClear();
  });
  afterEach(() => {
    if (runtime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = runtime;
  });

  it("registers as service admin with the package's version, and flushes it on shutdown", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    await register();
    expect(registerTelemetry).toHaveBeenCalledExactlyOnceWith({ appId: "admin", version: pkg.version });
    expect(installShutdownFlush).toHaveBeenCalledExactlyOnceWith(telemetry);
  });

  it("does nothing outside the Node.js runtime", async () => {
    for (const value of ["edge", undefined]) {
      if (value === undefined) delete process.env.NEXT_RUNTIME;
      else process.env.NEXT_RUNTIME = value;
      await register();
    }
    expect(registerTelemetry).not.toHaveBeenCalled();
    expect(installShutdownFlush).not.toHaveBeenCalled();
  });
});
