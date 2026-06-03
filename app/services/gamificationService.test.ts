import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
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
    testDb = createTestDb();
    base = seedBaseData(testDb);
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

  it("returns streakCount from the user record", () => {
    const { lessons } = createModuleWithLessons(base.course.id, "Module 1", 1, 1);

    const result = awardLessonXp(base.user.id, lessons[0].id, base.course.id);

    expect(result.streakCount).toBe(0);
  });

  it("returns levelUp false when XP does not cross a level boundary", () => {
    const { lessons } = createModuleWithLessons(base.course.id, "Module 1", 1, 1);

    const result = awardLessonXp(base.user.id, lessons[0].id, base.course.id);

    expect(result.levelUp).toBe(false);
    expect(result.newLevel).toBe(1);
  });

  it("returns levelUp true when XP crosses a level boundary", () => {
    const { lessons } = createModuleWithLessons(base.course.id, "Module 1", 2, 2);

    // Give user 95 XP so 95 + 10 = 105 crosses to level 2
    testDb
      .update(schema.users)
      .set({ totalPoints: 95 })
      .where(eq(schema.users.id, base.user.id))
      .run();

    const result = awardLessonXp(base.user.id, lessons[0].id, base.course.id);
    // 95 + 10 = 105, sqrt(105/100) = sqrt(1.05) = 1.02, floor(1.02) + 1 = 2
    expect(result.levelUp).toBe(true);
    expect(result.newLevel).toBe(2);
  });

  it("returns courseCompleted false (handled in later issue)", () => {
    const { lessons } = createModuleWithLessons(base.course.id, "Module 1", 1, 1);

    const result = awardLessonXp(base.user.id, lessons[0].id, base.course.id);

    expect(result.courseCompleted).toBe(false);
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
    // level 3: floor(sqrt(400/100)) + 1 = floor(2) + 1 = 3
    // points at level 3 start: 100 * (3-1)^2 = 100 * 4 = 400
    // next level (4) at: 100 * 3^2 = 900
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
