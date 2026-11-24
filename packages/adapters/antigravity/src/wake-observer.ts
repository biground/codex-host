import type { HostTurnSnapshot } from "@codexhost/harness-adapter";
import { projectReplayedEventsToTurns } from "./acp-projection.js";
import { readNativeConversationStatus } from "./background-tasks.js";
import { readNativeHistory } from "./native-replay.js";

const COMMIT_POLL_MS = 100;
const COMMIT_WAIT_MS = 10_000;
const ACTIVITY_LEASE_MS = 90_000;
const EXPECT_WAKE_WAIT_MS = 90_000;
const RUNNING_HARD_CAP_MS = 30 * 60_000;

interface ExpectedWake {
  stepIndex: number;
  taskId?: string;
  cursorAtStart: number;
  pendingCount: number;
  deadline: number;
}

export interface AntigravityWakeObserverOptions {
  nativeSessionId: string;
  cwd: string;
  home: string;
  cursor: number;
  outputLimit: number | undefined;
  pollIntervalMs?: number;
  commitWaitMs?: number;
  activityLeaseMs?: number;
  expectWakeWaitMs?: number;
  runningHardCapMs?: number;
  canPublish(): boolean;
  /** Whether output that started at this native time was streamed into a live prompt's Turn. */
  streamedIntoPrompt?(startedAtMs: number | undefined): boolean;
  publish(snapshot: HostTurnSnapshot): void;
  onExpectedWakeTimeout?(info: { stepIndex: number; taskId?: string }): void;
  onObservingChange?(observing: boolean): void;
}

/** Idle ACP updates have no response/stop boundary or native Turn identity.
 * Publish the committed SQLite Turn, not a second, timer-segmented transcript. */
export class AntigravityWakeObserver {
  #cursor: number;
  #deadline = 0;
  #runningCapDeadline = 0;
  #revision = 0;
  #settledRevision = -1;
  #sawNativeRunning = false;
  #expectedWake: ExpectedWake | undefined;
  #work: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #closed = false;
  #wasObserving = false;

  readonly #pollIntervalMs: number;
  readonly #commitWaitMs: number;
  readonly #activityLeaseMs: number;
  readonly #expectWakeWaitMs: number;
  readonly #runningHardCapMs: number;

  constructor(private readonly options: AntigravityWakeObserverOptions) {
    this.#cursor = options.cursor;
    this.#pollIntervalMs = options.pollIntervalMs ?? COMMIT_POLL_MS;
    this.#commitWaitMs = options.commitWaitMs ?? COMMIT_WAIT_MS;
    this.#activityLeaseMs = options.activityLeaseMs ?? ACTIVITY_LEASE_MS;
    this.#expectWakeWaitMs = options.expectWakeWaitMs ?? EXPECT_WAKE_WAIT_MS;
    this.#runningHardCapMs = options.runningHardCapMs ?? RUNNING_HARD_CAP_MS;
  }

  get observing(): boolean {
    return this.#work !== undefined || this.#timer !== undefined;
  }

  observe(): void {
    if (this.#closed) return;
    const now = Date.now();
    this.#revision++;
    this.#deadline = Math.max(this.#deadline, now + this.#activityLeaseMs);
    if (this.#expectedWake) {
      this.#expectedWake.deadline = Math.max(
        this.#expectedWake.deadline,
        now + this.#activityLeaseMs,
      );
    }
    this.#runningCapDeadline = Math.max(this.#runningCapDeadline, now + this.#runningHardCapMs);
    if (!this.observing) void this.#startRead();
  }

  /** Hold observation across the handoff from a finished background task to agy's autonomous wake. */
  expectWake(input?: { stepIndex?: number; taskId?: string }): void {
    if (this.#closed) return;
    const now = Date.now();
    this.#revision++;
    const deadline = now + this.#expectWakeWaitMs;
    const stepIndex = input?.stepIndex ?? -1;
    const taskId = input?.taskId ?? this.#expectedWake?.taskId;
    this.#expectedWake = {
      stepIndex: Math.max(this.#expectedWake?.stepIndex ?? -1, stepIndex),
      ...(taskId ? { taskId } : {}),
      cursorAtStart: this.#expectedWake?.cursorAtStart ?? this.#cursor,
      pendingCount: (this.#expectedWake?.pendingCount ?? 0) + 1,
      deadline: Math.max(this.#expectedWake?.deadline ?? 0, deadline),
    };
    this.#deadline = Math.max(this.#deadline, deadline);
    this.#runningCapDeadline = Math.max(this.#runningCapDeadline, now + this.#runningHardCapMs);
    if (!this.observing) void this.#startRead();
  }

  /** Clear pending wake-timeout expectations when a foreground user Turn takes over. */
  cancelExpectedWake(): void {
    this.#expectedWake = undefined;
  }

  /** Probe once before submitting a successor, without waiting on a pending native wake. */
  async flush(): Promise<void> {
    if (this.#closed || !this.observing) return;
    if (this.#work) return this.#work;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    return this.#startRead();
  }

  #syncObserving(): void {
    const active = this.observing;
    if (active === this.#wasObserving) return;
    this.#wasObserving = active;
    this.options.onObservingChange?.(active);
  }

  #startRead(): Promise<void> {
    const work = this.#read().finally(() => {
      if (this.#work === work) this.#work = undefined;
      this.#syncObserving();
    });
    this.#work = work;
    this.#syncObserving();
    return work;
  }

  async #read(): Promise<void> {
    const revisionAtStart = this.#revision;
    let publishedCount = 0;
    let publishedMaxIdx = -1;
    let nativeStatus: "running" | "idle" | null = null;
    let timedOutExpected: { stepIndex: number; taskId?: string } | undefined;
    try {
      const { nativeSessionId, home, cwd, outputLimit } = this.options;
      nativeStatus = await readNativeConversationStatus(home, nativeSessionId);
      if (this.#closed) return;

      const now = Date.now();
      if (nativeStatus === "running") {
        this.#sawNativeRunning = true;
        if (now < this.#runningCapDeadline) {
          this.#deadline = Math.max(this.#deadline, now + this.#commitWaitMs);
          if (this.#expectedWake) {
            this.#expectedWake.deadline = Math.max(
              this.#expectedWake.deadline,
              now + this.#commitWaitMs,
            );
          }
        }
      } else if (nativeStatus === "idle" && this.#sawNativeRunning) {
        this.#sawNativeRunning = false;
        this.#deadline = Math.min(this.#deadline, now + this.#commitWaitMs);
        if (this.#expectedWake) {
          this.#expectedWake.deadline = Math.min(
            this.#expectedWake.deadline,
            now + this.#commitWaitMs,
          );
        }
      }

      const { events, wakeWatermark } = await readNativeHistory(nativeSessionId, home);
      if (this.#closed || !this.options.canPublish()) return;
      if (wakeWatermark <= this.#cursor) return;
      const turns = projectReplayedEventsToTurns({
        nativeSessionId,
        cwd,
        events,
        ...(outputLimit !== undefined ? { outputLimit } : {}),
      });
      const startedAt = new Map(
        events.flatMap((event) =>
          event.type === "history.autonomous"
            ? [[event.stepIndex, event.createdAtMs] as const]
            : [],
        ),
      );
      for (const turn of turns) {
        const key = turn.nativeTurnRef.nativeTurnKey;
        if (!key.startsWith("wake-")) continue;
        const idx = Number(key.slice(5));
        if (idx <= this.#cursor) continue;
        // A wake that ran inside a live prompt is already part of that user Turn.
        if (!this.options.streamedIntoPrompt?.(startedAt.get(idx))) this.options.publish(turn);
        this.#cursor = idx;
        publishedCount++;
        publishedMaxIdx = Math.max(publishedMaxIdx, idx);
      }
    } catch {
      // A history read remains the recovery path if the commit outlives this window.
    } finally {
      const now = Date.now();
      const noNewNotifications = this.#revision === revisionAtStart;
      let expectedFulfilled = false;
      if (this.#expectedWake && publishedCount > 0) {
        this.#expectedWake.pendingCount = Math.max(
          0,
          this.#expectedWake.pendingCount - publishedCount,
        );
        const reachedStep =
          this.#expectedWake.stepIndex >= 0 && publishedMaxIdx >= this.#expectedWake.stepIndex;
        const reachedCount =
          this.#expectedWake.pendingCount === 0 &&
          publishedMaxIdx > this.#expectedWake.cursorAtStart;
        if (reachedStep || reachedCount) {
          expectedFulfilled = true;
          this.#expectedWake = undefined;
        }
      }

      if (publishedCount > 0 && noNewNotifications && !this.#expectedWake) {
        if (nativeStatus === "running") {
          this.#settledRevision = revisionAtStart;
        } else if (nativeStatus === "idle" || expectedFulfilled) {
          this.#deadline = 0;
          this.#settledRevision = -1;
          this.#sawNativeRunning = false;
        }
      } else if (
        this.#settledRevision === this.#revision &&
        !this.#expectedWake &&
        nativeStatus === "idle"
      ) {
        this.#deadline = 0;
        this.#settledRevision = -1;
        this.#sawNativeRunning = false;
      } else if (
        this.#expectedWake &&
        nativeStatus !== "running" &&
        now >= this.#expectedWake.deadline
      ) {
        timedOutExpected = {
          stepIndex: this.#expectedWake.stepIndex,
          ...(this.#expectedWake.taskId ? { taskId: this.#expectedWake.taskId } : {}),
        };
        this.#expectedWake = undefined;
      }

      // A notification carries no run ID. Finding a committed wake does not prove the
      // notified wake is already in SQLite; keep polling until the deadline unless native
      // status confirms idle or the expected wake settled.
      if (!this.#closed && now < this.#deadline) {
        this.#timer = setTimeout(() => {
          this.#timer = undefined;
          void this.#startRead();
        }, this.#pollIntervalMs);
        this.#timer.unref();
      } else {
        this.#sawNativeRunning = false;
      }
    }
    if (!this.#closed && timedOutExpected) {
      this.options.onExpectedWakeTimeout?.(timedOutExpected);
    }
  }

  close(): void {
    this.#closed = true;
    this.#expectedWake = undefined;
    this.#settledRevision = -1;
    this.#sawNativeRunning = false;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#syncObserving();
  }
}
