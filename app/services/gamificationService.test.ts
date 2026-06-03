import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import {
  calculateLevel,
  awardLessonXp,
  getUserStats,
  getPointsLog,
} from "./gamificationService";

function createModuleWithLessons(
  courseId: number,
  moduleTitle: string,
  position: number,
  lessonCount: number,
) {
  const mod = testDb
    .insert(schema.modules)
    .values({
      courseId,
      title: moduleTitle,
      position,
    })
    .returning()
    .get();

  const createdLessons = [];
  for (let i = 0; i < lessonCount; i++) {
    const lesson = testDb
      .insert(schema.lessons)
      .values({
        moduleId: mod.id,
        title: `Lesson ${i + 1}`,
        position: i + 1,
      })
      .returning()
      .get();
    createdLessons.push(lesson);
  }

  return { module: mod, lessons: createdLessons };
}

describe("calculateLevel", () => {
  it("returns level 1 for 0 XP", () => {
    expect(calculateLevel(0)).toBe(1);
  });

  it("returns level 1 for less than 100 XP", () => {
    expect(calculateLevel(50)).toBe(1);
    expect(calculateLevel(99)).toBe(1);
  });

  it("returns level 2 at 100 XP", () => {
    expect(calculateLevel(100)).toBe(2);
  });

  it("returns level 3 at 400 XP", () => {
    expect(calculateLevel(400)).toBe(3);
  });

  it("returns level 5 at 1600 XP", () => {
    expect(calculateLevel(1600)).toBe(5);
  });

  it("returns level 10 at 8100 XP", () => {
    expect(calculateLevel(8100)).toBe(10);
  });

  it("returns correct level at boundary between 5 and 6", () => {
    expect(calculateLevel(2499)).toBe(5);
    expect(calculateLevel(2500)).toBe(6);
  });
});

describe("awardLessonXp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("awards 10 XP for completing a lesson", () => {
    const { lessons } = createModuleWithLessons(base.course.id, "Module 1", 1, 1);

    const result = awardLessonXp(base.user.id, lessons[0].id, base.course.id);

    expect(result.xpAwarded).toBe(10);
  });

  it("updates user total_points", () => {
    const { lessons } = createModuleWithLessons(base.course.id, "Module 1", 1, 1);

    awardLessonXp(base.user.id, lessons[0].id, base.course.id);

    const updated = testDb
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, base.user.id))
      .get();

    expect(updated?.totalPoints).toBe(10);
  });

  it("inserts a user_points_log entry", () => {
    const { lessons } = createModuleWithLessons(base.course.id, "Module 1", 1, 1);

    awardLessonXp(base.user.id, lessons[0].id, base.course.id);

    const log = testDb.select().from(schema.userPointsLog).all();
    expect(log).toHaveLength(1);
    expect(log[0].userId).toBe(base.user.id);
    expect(log[0].points).toBe(10);
    expect(log[0].reason).toBe(schema.PointsReason.LessonComplete);
    expect(log[0].referenceId).toBe(lessons[0].id);
  });

  it("is idempotent - awarding XP for the same lesson twice is a no-op", () => {
    const { lessons } = createModuleWithLessons(base.course.id, "Module 1", 1, 1);

    const first = awardLessonXp(base.user.id, lessons[0].id, base.course.id);
    const second = awardLessonXp(base.user.id, lessons[0].id, base.course.id);

    expect(first.xpAwarded).toBe(10);
    expect(second.xpAwarded).toBe(0);

    const log = testDb.select().from(schema.userPointsLog).all();
    expect(log).toHaveLength(1);

    const user = testDb
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, base.user.id))
      .get();
    expect(user?.totalPoints).toBe(10);
  });

  it("updates streakCount to 1 on first completion", () => {
    const { lessons } = createModuleWithLessons(base.course.id, "Module 1", 1, 1);

    const result = awardLessonXp(base.user.id, lessons[0].id, base.course.id);

    expect(result.streakCount).toBe(1);
    const user = testDb
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, base.user.id))
      .get();
    expect(user?.streakCount).toBe(1);
    expect(user?.lastActivityDate).toBe("2026-06-01");
  });

  it("returns levelUp false when XP does not cross a level boundary", () => {
    const { lessons } = createModuleWithLessons(base.course.id, "Module 1", 1, 1);

    const result = awardLessonXp(base.user.id, lessons[0].id, base.course.id);

    expect(result.levelUp).toBe(false);
    expect(result.newLevel).toBe(1);
  });

  it("returns levelUp true when XP crosses a level boundary", () => {
    const { lessons } = createModuleWithLessons(base.course.id, "Module 1", 2, 2);

    testDb
      .update(schema.users)
      .set({ totalPoints: 95 })
      .where(eq(schema.users.id, base.user.id))
      .run();

    const result = awardLessonXp(base.user.id, lessons[0].id, base.course.id);

    expect(result.levelUp).toBe(true);
    expect(result.newLevel).toBe(2);
  });

  it("returns courseCompleted false (handled in later issue)", () => {
    const { lessons } = createModuleWithLessons(base.course.id, "Module 1", 1, 1);

    const result = awardLessonXp(base.user.id, lessons[0].id, base.course.id);

    expect(result.courseCompleted).toBe(false);
  });
});

describe("awardLessonXp — streak", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  it("increments streak on consecutive calendar days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));
    const { lessons } = createModuleWithLessons(base.course.id, "Module 1", 1, 3);

    // Day 1
    awardLessonXp(base.user.id, lessons[0].id, base.course.id);

    // Day 2
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const result2 = awardLessonXp(base.user.id, lessons[1].id, base.course.id);
    expect(result2.streakCount).toBe(2);

    // Day 3
    vi.setSystemTime(new Date("2026-06-03T12:00:00Z"));
    const result3 = awardLessonXp(base.user.id, lessons[2].id, base.course.id);
    expect(result3.streakCount).toBe(3);

    vi.useRealTimers();
  });

  it("does not increment streak on the same calendar day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));
    const { lessons } = createModuleWithLessons(base.course.id, "Module 1", 1, 2);

    const first = awardLessonXp(base.user.id, lessons[0].id, base.course.id);
    expect(first.streakCount).toBe(1);

    // Complete another lesson same day — streak stays 1
    const second = awardLessonXp(base.user.id, lessons[1].id, base.course.id);
    expect(second.streakCount).toBe(1);

    vi.useRealTimers();
  });

  it("resets streak to 1 after a gap of more than 1 day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));
    const { lessons } = createModuleWithLessons(base.course.id, "Module 1", 1, 2);

    // Day 1
    awardLessonXp(base.user.id, lessons[0].id, base.course.id);

    // Day 3 (skipped day 2)
    vi.setSystemTime(new Date("2026-06-03T12:00:00Z"));
    const result = awardLessonXp(base.user.id, lessons[1].id, base.course.id);
    expect(result.streakCount).toBe(1);

    vi.useRealTimers();
  });

  it("updates last_activity_date to the current UTC date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
    const { lessons } = createModuleWithLessons(base.course.id, "Module 1", 1, 1);

    awardLessonXp(base.user.id, lessons[0].id, base.course.id);

    const user = testDb
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, base.user.id))
      .get();
    expect(user?.lastActivityDate).toBe("2026-06-15");

    vi.useRealTimers();
  });

  it("awards 50 XP milestone bonus at 3-day streak", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));
    const { lessons } = createModuleWithLessons(base.course.id, "Module 1", 1, 3);

    awardLessonXp(base.user.id, lessons[0].id, base.course.id);

    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    awardLessonXp(base.user.id, lessons[1].id, base.course.id);

    vi.setSystemTime(new Date("2026-06-03T12:00:00Z"));
    const result = awardLessonXp(base.user.id, lessons[2].id, base.course.id);

    expect(result.xpAwarded).toBe(60); // 10 lesson + 50 milestone
    expect(result.streakMilestone).toEqual({ day: 3, bonusXp: 50 });

    const logs = testDb
      .select()
      .from(schema.userPointsLog)
      .where(eq(schema.userPointsLog.reason, schema.PointsReason.StreakMilestone))
      .all();
    expect(logs).toHaveLength(1);
    expect(logs[0].points).toBe(50);
    expect(logs[0].referenceId).toBe(3);

    const user = testDb
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, base.user.id))
      .get();
    expect(user?.totalPoints).toBe(10 + 10 + 60); // 80

    vi.useRealTimers();
  });

  it("awards 100 XP milestone bonus at 7-day streak", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));
    const { lessons } = createModuleWithLessons(base.course.id, "Module 1", 1, 7);

    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(new Date(`2026-06-${String(i + 1).padStart(2, "0")}T12:00:00Z`));
      awardLessonXp(base.user.id, lessons[i].id, base.course.id);
    }

    vi.setSystemTime(new Date("2026-06-07T12:00:00Z"));
    const result = awardLessonXp(base.user.id, lessons[6].id, base.course.id);

    expect(result.xpAwarded).toBe(110); // 10 lesson + 100 milestone
    expect(result.streakMilestone).toEqual({ day: 7, bonusXp: 100 });

    const user = testDb
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, base.user.id))
      .get();
    expect(user?.streakCount).toBe(7);
    expect(user?.totalPoints).toBe(10 * 7 + 50 + 100); // 220

    vi.useRealTimers();
  });

  it("awards 500 XP milestone bonus at 30-day streak", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));
    const { lessons } = createModuleWithLessons(base.course.id, "Module 1", 1, 30);

    for (let i = 0; i < 29; i++) {
      vi.setSystemTime(new Date(`2026-06-${String(i + 1).padStart(2, "0")}T12:00:00Z`));
      awardLessonXp(base.user.id, lessons[i].id, base.course.id);
    }

    vi.setSystemTime(new Date("2026-06-30T12:00:00Z"));
    const result = awardLessonXp(base.user.id, lessons[29].id, base.course.id);

    expect(result.xpAwarded).toBe(510); // 10 lesson + 500 milestone
    expect(result.streakMilestone).toEqual({ day: 30, bonusXp: 500 });

    const user = testDb
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, base.user.id))
      .get();
    expect(user?.streakCount).toBe(30);
    expect(user?.totalPoints).toBe(10 * 30 + 50 + 100 + 500); // 950

    vi.useRealTimers();
  });

  it("does not award milestone bonus again at same milestone in future streak", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));
    const { lessons } = createModuleWithLessons(base.course.id, "Module 1", 1, 6);

    // First streak: days 1, 2, 3 → milestone at day 3
    awardLessonXp(base.user.id, lessons[0].id, base.course.id);
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    awardLessonXp(base.user.id, lessons[1].id, base.course.id);
    vi.setSystemTime(new Date("2026-06-03T12:00:00Z"));
    const firstMilestone = awardLessonXp(base.user.id, lessons[2].id, base.course.id);
    expect(firstMilestone.streakMilestone).toEqual({ day: 3, bonusXp: 50 });

    // Reset streak with gap
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z"));
    const reset = awardLessonXp(base.user.id, lessons[3].id, base.course.id);
    expect(reset.streakCount).toBe(1);
    expect(reset.streakMilestone).toBeUndefined();

    // Build up to day 3 again
    vi.setSystemTime(new Date("2026-06-11T12:00:00Z"));
    awardLessonXp(base.user.id, lessons[4].id, base.course.id);
    vi.setSystemTime(new Date("2026-06-12T12:00:00Z"));
    const secondMilestone = awardLessonXp(base.user.id, lessons[5].id, base.course.id);
    expect(secondMilestone.streakCount).toBe(3);
    expect(secondMilestone.streakMilestone).toBeUndefined();

    // Only one milestone entry in the log
    const milestoneLogs = testDb
      .select()
      .from(schema.userPointsLog)
      .where(eq(schema.userPointsLog.reason, schema.PointsReason.StreakMilestone))
      .all();
    expect(milestoneLogs).toHaveLength(1);

    vi.useRealTimers();
  });

  it("does not award milestone bonus on days after the milestone (no double-count within streak)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));
    const { lessons } = createModuleWithLessons(base.course.id, "Module 1", 1, 5);

    awardLessonXp(base.user.id, lessons[0].id, base.course.id);
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    awardLessonXp(base.user.id, lessons[1].id, base.course.id);
    vi.setSystemTime(new Date("2026-06-03T12:00:00Z"));
    awardLessonXp(base.user.id, lessons[2].id, base.course.id);
    expect(
      testDb
        .select()
        .from(schema.userPointsLog)
        .where(eq(schema.userPointsLog.reason, schema.PointsReason.StreakMilestone))
        .all(),
    ).toHaveLength(1);

    // Day 4 — no milestone
    vi.setSystemTime(new Date("2026-06-04T12:00:00Z"));
    const day4 = awardLessonXp(base.user.id, lessons[3].id, base.course.id);
    expect(day4.xpAwarded).toBe(10);
    expect(day4.streakMilestone).toBeUndefined();

    // Day 5 — no milestone
    vi.setSystemTime(new Date("2026-06-05T12:00:00Z"));
    const day5 = awardLessonXp(base.user.id, lessons[4].id, base.course.id);
    expect(day5.xpAwarded).toBe(10);

    vi.useRealTimers();
  });
});

describe("getUserStats", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  it("returns totalPoints, level, pointsToNextLevel, streakCount, lastActivityDate", () => {
    const stats = getUserStats(base.user.id);

    expect(stats).toHaveProperty("totalPoints");
    expect(stats).toHaveProperty("level");
    expect(stats).toHaveProperty("pointsToNextLevel");
    expect(stats).toHaveProperty("streakCount");
    expect(stats).toHaveProperty("lastActivityDate");
  });

  it("returns correct values for a fresh user", () => {
    const stats = getUserStats(base.user.id);

    expect(stats.totalPoints).toBe(0);
    expect(stats.level).toBe(1);
    expect(stats.pointsToNextLevel).toBe(100);
    expect(stats.streakCount).toBe(0);
    expect(stats.lastActivityDate).toBeNull();
  });

  it("reflects points earned after awardLessonXp", () => {
    const { lessons } = createModuleWithLessons(base.course.id, "Module 1", 1, 1);

    awardLessonXp(base.user.id, lessons[0].id, base.course.id);

    const stats = getUserStats(base.user.id);
    expect(stats.totalPoints).toBe(10);
    expect(stats.level).toBe(1);
    expect(stats.pointsToNextLevel).toBe(90);
  });

  it("correctly calculates pointsToNextLevel for higher levels", () => {
    testDb
      .update(schema.users)
      .set({ totalPoints: 400 })
      .where(eq(schema.users.id, base.user.id))
      .run();

    const stats = getUserStats(base.user.id);
    expect(stats.totalPoints).toBe(400);
    expect(stats.level).toBe(3);
    expect(stats.pointsToNextLevel).toBe(500);
  });
});

describe("getPointsLog", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  it("returns an empty array for a user with no points", () => {
    const log = getPointsLog(base.user.id);
    expect(log).toEqual([]);
  });

  it("returns ordered point earnings for a user", () => {
    const { lessons } = createModuleWithLessons(base.course.id, "Module 1", 1, 2);

    awardLessonXp(base.user.id, lessons[0].id, base.course.id);
    awardLessonXp(base.user.id, lessons[1].id, base.course.id);

    const log = getPointsLog(base.user.id);
    expect(log).toHaveLength(2);
    expect(log[0].points).toBe(10);
    expect(log[0].reason).toBe(schema.PointsReason.LessonComplete);
  });
});
