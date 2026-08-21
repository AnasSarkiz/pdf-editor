import { beforeEach, expect, mock, test } from "bun:test";

let createWorkerImplementation;

mock.module("tesseract.js", () => ({
  PSM: { SPARSE_TEXT: "11" },
  createWorker: (...args) => createWorkerImplementation(...args),
}));

const {
  LocalOcrError,
  createHighResolutionOcrSession,
} = await import("../app/lib/local-ocr.ts");

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function fakeWorker(overrides = {}) {
  const listeners = new Map();
  return {
    worker: {
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      removeEventListener(type, listener) {
        if (listeners.get(type) === listener) listeners.delete(type);
      },
      terminate() {},
    },
    async setParameters() {},
    async recognize() {
      return { data: { blocks: [] } };
    },
    async terminate() {},
    ...overrides,
  };
}

beforeEach(() => {
  createWorkerImplementation = async () => fakeWorker();
});

test("known Tesseract initialization failures reject instead of leaving createWorker pending", async () => {
  createWorkerImplementation = (_languages, _oem, options) => {
    setTimeout(() => options.errorHandler(new Error("language model unavailable")), 0);
    return new Promise(() => {});
  };

  const startedAt = Date.now();
  try {
    await createHighResolutionOcrSession({
      initializationTimeoutMs: 500,
      terminationTimeoutMs: 10,
    });
    throw new Error("expected OCR initialization to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(LocalOcrError);
    expect(error.code).toBe("initialization-failed");
    expect(error.message).toMatch(/could not start/i);
  }
  expect(Date.now() - startedAt).toBeLessThan(250);
});

test("a silent createWorker hang times out and a late worker is reclaimed", async () => {
  let resolveWorker;
  let terminationCount = 0;
  const lateWorker = fakeWorker({
    async terminate() {
      terminationCount += 1;
    },
  });
  createWorkerImplementation = () => new Promise((resolve) => {
    resolveWorker = resolve;
  });

  const initialization = createHighResolutionOcrSession({
    initializationTimeoutMs: 15,
    terminationTimeoutMs: 15,
  });
  await expect(initialization).rejects.toMatchObject({ code: "initialization-timeout" });

  resolveWorker(lateWorker);
  await delay(25);
  expect(terminationCount).toBe(1);
});

test("recognition timeout stops the unusable worker and future calls reject immediately", async () => {
  let terminationCount = 0;
  createWorkerImplementation = async () => fakeWorker({
    recognize() {
      return new Promise(() => {});
    },
    async terminate() {
      terminationCount += 1;
    },
  });
  const session = await createHighResolutionOcrSession({
    initializationTimeoutMs: 100,
    recognitionTimeoutMs: 15,
    terminationTimeoutMs: 15,
  });
  const canvas = { width: 100, height: 100 };

  await expect(session.recognize(canvas, { width: 100, height: 100 }))
    .rejects.toMatchObject({ code: "recognition-timeout" });
  expect(terminationCount).toBe(1);
  await expect(session.recognize(canvas, { width: 100, height: 100 }))
    .rejects.toMatchObject({ code: "session-closed" });
  await session.terminate();
  expect(terminationCount).toBe(1);
});

test("a browser worker crash rejects an in-flight recognition without waiting for its timeout", async () => {
  let errorListener;
  let terminationCount = 0;
  createWorkerImplementation = async () => fakeWorker({
    worker: {
      addEventListener(type, listener) {
        if (type === "error") errorListener = listener;
      },
      removeEventListener() {},
      terminate() {},
    },
    recognize() {
      return new Promise(() => {});
    },
    async terminate() {
      terminationCount += 1;
    },
  });
  const session = await createHighResolutionOcrSession({
    initializationTimeoutMs: 100,
    recognitionTimeoutMs: 500,
    terminationTimeoutMs: 15,
  });
  const recognition = session.recognize({ width: 100, height: 100 }, { width: 100, height: 100 });

  errorListener({ type: "error" });
  await expect(recognition).rejects.toMatchObject({ code: "worker-failed" });
  expect(terminationCount).toBe(1);
});

test("termination is bounded and the default quality model avoids the larger floating-point data", async () => {
  let creationOptions;
  let forcedTerminationCount = 0;
  createWorkerImplementation = async (_languages, _oem, options) => {
    creationOptions = options;
    return fakeWorker({
      worker: {
        addEventListener() {},
        removeEventListener() {},
        terminate() {
          forcedTerminationCount += 1;
        },
      },
      terminate() {
        return new Promise(() => {});
      },
    });
  };
  const session = await createHighResolutionOcrSession({
    initializationTimeoutMs: 100,
    terminationTimeoutMs: 15,
  });

  expect(creationOptions.langPath).toBeUndefined();
  const startedAt = Date.now();
  await session.terminate();
  expect(Date.now() - startedAt).toBeLessThan(250);
  expect(forcedTerminationCount).toBeGreaterThan(0);
});
