import type { OcrToken } from "./recognition";
import { detectTextMeta } from "./document-model";

const DEFAULT_MODULE_LOAD_TIMEOUT_MS = 15_000;
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 90_000;
const DEFAULT_RECOGNITION_TIMEOUT_MS = 60_000;
const DEFAULT_TERMINATION_TIMEOUT_MS = 2_000;

export type LocalOcrErrorCode =
  | "module-load-timeout"
  | "initialization-timeout"
  | "initialization-failed"
  | "recognition-timeout"
  | "recognition-failed"
  | "worker-failed"
  | "session-closed";

export class LocalOcrError extends Error {
  readonly code: LocalOcrErrorCode;

  constructor(code: LocalOcrErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "LocalOcrError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export interface LocalOcrProgress {
  phase: "initializing" | "recognizing" | "terminating";
  status: string;
  progress?: number;
}

export interface LocalOcrSessionOptions {
  onProgress?: (progress: LocalOcrProgress) => void;
  moduleLoadTimeoutMs?: number;
  initializationTimeoutMs?: number;
  recognitionTimeoutMs?: number;
  terminationTimeoutMs?: number;
}

interface NativeWorkerHandle {
  addEventListener?: (type: "error", listener: (event: Event) => void) => void;
  removeEventListener?: (type: "error", listener: (event: Event) => void) => void;
  terminate?: () => void;
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
}

function reportProgress(callback: LocalOcrSessionOptions["onProgress"], progress: LocalOcrProgress): void {
  try {
    callback?.(progress);
  } catch {
    // Progress reporting must never interrupt OCR or its cleanup path.
  }
}

function operationWithTimeout<T>(
  operation: PromiseLike<T>,
  timeoutMs: number,
  timeoutError: () => LocalOcrError,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        onTimeout?.();
      } finally {
        reject(timeoutError());
      }
    }, timeoutMs);

    Promise.resolve(operation).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function nativeWorkerHandle(worker: unknown): NativeWorkerHandle | null {
  if (!worker || typeof worker !== "object" || !("worker" in worker)) return null;
  const candidate = (worker as { worker?: unknown }).worker;
  return candidate && typeof candidate === "object" ? candidate as NativeWorkerHandle : null;
}

function forceTerminateWorker(worker: unknown): void {
  try {
    nativeWorkerHandle(worker)?.terminate?.();
  } catch {
    // The browser may already have killed the worker.
  }
}

async function terminateLateWorker(
  worker: { terminate(): Promise<unknown> },
  timeoutMs: number,
): Promise<void> {
  const termination = Promise.resolve().then(() => worker.terminate()).then(() => undefined);
  try {
    await operationWithTimeout(
      termination,
      timeoutMs,
      () => new LocalOcrError("worker-failed", "OCR cleanup took too long; the background worker was stopped."),
      () => forceTerminateWorker(worker),
    );
  } catch {
    forceTerminateWorker(worker);
  }
}

export interface TesseractBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TesseractLine {
  text: string;
  confidence: number;
  bbox: TesseractBox;
}

export interface TesseractParagraph {
  is_ltr: boolean;
  lines: TesseractLine[];
}

export interface TesseractBlock {
  paragraphs: TesseractParagraph[];
}

export interface LocalOcrSession {
  recognize(canvas: HTMLCanvasElement, page: { width: number; height: number }): Promise<OcrToken[]>;
  terminate(): Promise<void>;
}

/**
 * Starts a single browser-local Arabic + English OCR worker. The page image is
 * transferred only to this Web Worker; it is never posted to an OCR service.
 */
export async function createHighResolutionOcrSession(options: LocalOcrSessionOptions = {}): Promise<LocalOcrSession> {
  const moduleLoadTimeoutMs = positiveTimeout(options.moduleLoadTimeoutMs, DEFAULT_MODULE_LOAD_TIMEOUT_MS);
  const initializationTimeoutMs = positiveTimeout(options.initializationTimeoutMs, DEFAULT_INITIALIZATION_TIMEOUT_MS);
  const recognitionTimeoutMs = positiveTimeout(options.recognitionTimeoutMs, DEFAULT_RECOGNITION_TIMEOUT_MS);
  const terminationTimeoutMs = positiveTimeout(options.terminationTimeoutMs, DEFAULT_TERMINATION_TIMEOUT_MS);
  reportProgress(options.onProgress, { phase: "initializing", status: "Loading the local OCR engine", progress: 0 });

  const tesseract = await operationWithTimeout(
    import("tesseract.js"),
    moduleLoadTimeoutMs,
    () => new LocalOcrError(
      "module-load-timeout",
      "OCR could not load in time. Check your connection and try opening the PDF again.",
    ),
  );
  const { createWorker, PSM } = tesseract;
  let initializing = true;
  let rejectInitialization: (error: LocalOcrError) => void = () => undefined;
  const initializationFailure = new Promise<never>((_resolve, reject) => {
    rejectInitialization = reject;
  });
  // Promise.race installs a rejection handler, even if the worker succeeds
  // before a later non-fatal Tesseract job reports an error.
  void initializationFailure.catch(() => undefined);
  const initializationDeadline = Date.now() + initializationTimeoutMs;
  const workerCreation = Promise.resolve().then(() => createWorker("ara+eng", 1, {
    // Tesseract's default LSTM-only `best_int` data is the integerized
    // tessdata_best model. It retains the quality-focused model while avoiding
    // the substantially larger floating-point `4.0.0_best` mobile download.
    logger: (message) => {
      const status = typeof message.status === "string" ? message.status : "Preparing local OCR";
      const progress = typeof message.progress === "number"
        ? Math.max(0, Math.min(1, message.progress))
        : undefined;
      reportProgress(options.onProgress, {
        phase: status.toLowerCase().includes("recogniz") ? "recognizing" : "initializing",
        status,
        ...(progress === undefined ? {} : { progress }),
      });
    },
    errorHandler: (error) => {
      if (!initializing) return;
      rejectInitialization(new LocalOcrError(
        "initialization-failed",
        "OCR could not start. Check your connection and try opening the PDF again.",
        error,
      ));
    },
  }));

  let worker: Awaited<typeof workerCreation>;
  try {
    worker = await operationWithTimeout(
      Promise.race([workerCreation, initializationFailure]),
      initializationTimeoutMs,
      () => new LocalOcrError(
        "initialization-timeout",
        "OCR took too long to start. Check your connection and try opening the PDF again.",
      ),
    );
  } catch (error) {
    initializing = false;
    // Tesseract 6 can resolve after its public createWorker promise has already
    // timed out here. Reclaim that late worker instead of leaking it.
    void workerCreation.then(
      (lateWorker) => terminateLateWorker(lateWorker, terminationTimeoutMs),
      () => undefined,
    );
    if (error instanceof LocalOcrError) throw error;
    throw new LocalOcrError(
      "initialization-failed",
      "OCR could not start. Check your connection and try opening the PDF again.",
      error,
    );
  }
  initializing = false;

  let stopped = false;
  let fatalWorkerError: LocalOcrError | null = null;
  let rejectFatalWorker: (error: LocalOcrError) => void = () => undefined;
  const fatalWorkerFailure = new Promise<never>((_resolve, reject) => {
    rejectFatalWorker = reject;
  });
  void fatalWorkerFailure.catch(() => undefined);
  const browserWorker = nativeWorkerHandle(worker);
  const onWorkerError = (event: Event): void => {
    if (stopped || fatalWorkerError) return;
    fatalWorkerError = new LocalOcrError(
      "worker-failed",
      "OCR stopped unexpectedly on this device. Reopen the PDF to try again.",
      event,
    );
    rejectFatalWorker(fatalWorkerError);
  };
  try {
    browserWorker?.addEventListener?.("error", onWorkerError);
  } catch {
    // A timeout still protects browsers that do not expose worker events.
  }

  let termination: Promise<void> | null = null;
  const stopWorker = (): Promise<void> => {
    if (termination) return termination;
    stopped = true;
    reportProgress(options.onProgress, { phase: "terminating", status: "Stopping local OCR", progress: 0 });
    const rawTermination = Promise.resolve().then(() => worker.terminate()).then(() => undefined);
    termination = operationWithTimeout(
      rawTermination,
      terminationTimeoutMs,
      () => new LocalOcrError("worker-failed", "OCR cleanup took too long; the background worker was stopped."),
      () => forceTerminateWorker(worker),
    ).catch(() => {
      // Cleanup is best-effort and must not turn an otherwise successful PDF
      // import into a failure. The returned termination promise still settles.
      forceTerminateWorker(worker);
      reportProgress(options.onProgress, {
        phase: "terminating",
        status: "OCR cleanup took too long; the background worker was stopped",
        progress: 1,
      });
    }).finally(() => {
      try {
        browserWorker?.removeEventListener?.("error", onWorkerError);
      } catch {
        // The worker may already be gone.
      }
      reportProgress(options.onProgress, { phase: "terminating", status: "Local OCR stopped", progress: 1 });
    });
    return termination;
  };

  try {
    const remainingInitializationMs = Math.max(1, initializationDeadline - Date.now());
    const parameters = Promise.resolve().then(() => worker.setParameters({
      user_defined_dpi: "300",
      tessedit_pageseg_mode: PSM.SPARSE_TEXT,
      preserve_interword_spaces: "1",
    }));
    await operationWithTimeout(
      Promise.race([parameters, fatalWorkerFailure]),
      remainingInitializationMs,
      () => new LocalOcrError(
        "initialization-timeout",
        "OCR took too long to start. Check your connection and try opening the PDF again.",
      ),
    );
  } catch (error) {
    await stopWorker();
    if (error instanceof LocalOcrError) throw error;
    throw new LocalOcrError(
      "initialization-failed",
      "OCR could not start. Check your connection and try opening the PDF again.",
      error,
    );
  }
  reportProgress(options.onProgress, { phase: "initializing", status: "Local OCR is ready", progress: 1 });

  return {
    async recognize(canvas, page) {
      if (stopped) {
        throw fatalWorkerError ?? new LocalOcrError(
          "session-closed",
          "OCR is no longer available for this document. Reopen the PDF to try again.",
        );
      }
      reportProgress(options.onProgress, { phase: "recognizing", status: "Recognizing text on this page", progress: 0 });
      const recognition = Promise.resolve().then(() => worker.recognize(canvas, {}, { blocks: true }));
      try {
        const result = await operationWithTimeout(
          Promise.race([recognition, fatalWorkerFailure]),
          recognitionTimeoutMs,
          () => new LocalOcrError(
            "recognition-timeout",
            "OCR took too long to read this page. Try opening a smaller or lower-resolution PDF.",
          ),
        );
        reportProgress(options.onProgress, { phase: "recognizing", status: "Text recognition complete", progress: 1 });
        return tokensFromTesseractBlocks((result.data.blocks ?? []) as unknown as TesseractBlock[], canvas.width, canvas.height, page);
      } catch (error) {
        if (error instanceof LocalOcrError && (error.code === "recognition-timeout" || error.code === "worker-failed")) {
          await stopWorker();
          throw error;
        }
        throw new LocalOcrError(
          "recognition-failed",
          "OCR could not read this page. The PDF can still be opened without recognized text.",
          error,
        );
      }
    },
    async terminate() {
      await stopWorker();
    },
  };
}

export function tokensFromTesseractBlocks(
  blocks: TesseractBlock[],
  imageWidth: number,
  imageHeight: number,
  page: { width: number; height: number },
): OcrToken[] {
  if (!imageWidth || !imageHeight) return [];
  const scaleX = page.width / imageWidth;
  const scaleY = page.height / imageHeight;
  return blocks.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines.flatMap((line) => {
    const text = line.text.trim();
    if (!text) return [];
    const meta = detectTextMeta(text);
    const direction = meta.direction === "auto" ? (paragraph.is_ltr ? "ltr" : "rtl") : meta.direction;
    return [{
      text,
      polygon: [
        { x: line.bbox.x0 * scaleX, y: line.bbox.y0 * scaleY },
        { x: line.bbox.x1 * scaleX, y: line.bbox.y0 * scaleY },
        { x: line.bbox.x1 * scaleX, y: line.bbox.y1 * scaleY },
        { x: line.bbox.x0 * scaleX, y: line.bbox.y1 * scaleY },
      ],
      confidence: Math.max(0, Math.min(1, line.confidence / 100)),
      language: meta.language,
      direction,
    }];
  })));
}
