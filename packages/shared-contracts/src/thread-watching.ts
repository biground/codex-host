import { z } from "zod";

export const THREAD_WATCHING_READ_METHOD = "codexhost/thread/watching/read";
export const THREAD_WATCHING_UPDATED_METHOD = "codexhost/thread/watching/updated";
export const THREAD_WATCHING_TARGETS_MAX = 3;

export const threadWatchingEntrySchema = z
  .object({
    watchCount: z.number().int().nonnegative(),
    watchTargets: z.array(z.string().min(1)).max(THREAD_WATCHING_TARGETS_MAX).optional(),
    backgroundWork: z.boolean(),
  })
  .strict();
export type ThreadWatchingEntry = z.infer<typeof threadWatchingEntrySchema>;

export const threadWatchingReadParamsSchema = z.object({}).strict();
export type ThreadWatchingReadParams = z.infer<typeof threadWatchingReadParamsSchema>;

export const threadWatchingReadResultSchema = z
  .object({
    threads: z.record(z.string().min(1), threadWatchingEntrySchema),
  })
  .strict();
export type ThreadWatchingReadResult = z.infer<typeof threadWatchingReadResultSchema>;

export const threadWatchingUpdatedNotificationSchema = threadWatchingReadResultSchema;
export type ThreadWatchingUpdatedNotification = ThreadWatchingReadResult;
