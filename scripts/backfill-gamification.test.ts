import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { backfillGamification } from "./backfill-gamification";
import {
  LessonProgressStatus,
  PointsReason,
  lessonProgress,
  quizAttempts,
  quizzes,
  quizQuestions,
  quizOptions,
  enrollments,
  users,
  userPointsLog,
  QuestionType,
} from "~/db/schema";

function createModuleWithLessons(
  testDb: ReturnType<typeof createTestDb>,
  courseId: number,
  moduleTitle: string,
  position: number,
  lessonCount: number,
) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title: moduleTitle, position })
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

function createQuiz(
  testDb: ReturnType<typeof createTestDb>,
  lessonId: number,
) {
  const quiz = testDb
    .insert(quizzes)
    .values({ lessonId, title: "Test Quiz", passingScore: 0.7 })
    .returning()
    .get();

  const question = testDb
    .insert(quizQuestions)
    .values({ quizId: quiz.id, questionText: "Q1", questionType: QuestionType.MultipleChoice, position: 1 })
    .returning()
    .get();

  const correct = testDb
    .insert(quizOptions)
    .values({ questionId: question.id, optionText: "Correct", isCorrect: true })
    .returning()
    .get();

  testDb
    .insert(quizOptions)
    .values({ questionId: question.id, optionText: "Wrong", isCorrect: false })
    .returning()
    .get();

  return { quiz, question, correctOption: correct };
}

describe("backfillGamification", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("awards XP for completed lessons", () => {
    const testDb = createTestDb();
    const base = seedBaseData(testDb);
    const { lessons } = createModuleWithLessons(testDb, base.course.id, "M1", 1, 2);

    testDb.insert(lessonProgress).values({
      userId: base.user.id,
      lessonId: lessons[0].id,
      status: LessonProgressStatus.Completed,
      completedAt: "2026-06-10T12:00:00Z",
    }).run();

    testDb.insert(lessonProgress).values({
      userId: base.user.id,
      lessonId: lessons[1].id,
      status: LessonProgressStatus.Completed,
      completedAt: "2026-06-12T12:00:00Z",
    }).run();

    const results = backfillGamification(testDb);

    const userResult = results.find((r) => r.userId === base.user.id);
    expect(userResult).toBeDefined();
    expect(userResult!.lessonXp).toBe(20); // 2 lessons × 10 XP
    expect(userResult!.totalXp).toBe(20);

    const logs = testDb.select().from(userPointsLog).all();
    expect(logs).toHaveLength(2);
  });

  it("awards XP for passed quizzes", () => {
    const testDb = createTestDb();
    const base = seedBaseData(testDb);
    const { lessons } = createModuleWithLessons(testDb, base.course.id, "M1", 1, 1);
    const { quiz } = createQuiz(testDb, lessons[0].id);

    testDb.insert(quizAttempts).values({
      userId: base.user.id,
      quizId: quiz.id,
      score: 1.0,
      passed: true,
      attemptedAt: "2026-06-10T12:00:00Z",
    }).run();

    const results = backfillGamification(testDb);

    const userResult = results.find((r) => r.userId === base.user.id);
    expect(userResult).toBeDefined();
    expect(userResult!.quizXp).toBe(40); // 25 pass + 15 first-try
    expect(userResult!.totalXp).toBe(40);
  });

  it("awards course completion XP", () => {
    const testDb = createTestDb();
    const base = seedBaseData(testDb);

    testDb.insert(enrollments).values({
      userId: base.user.id,
      courseId: base.course.id,
      enrolledAt: "2026-06-01T12:00:00Z",
      completedAt: "2026-06-10T12:00:00Z",
    }).run();

    const results = backfillGamification(testDb);

    const userResult = results.find((r) => r.userId === base.user.id);
    expect(userResult).toBeDefined();
    expect(userResult!.courseXp).toBe(200);
    expect(userResult!.totalXp).toBe(200);
  });

  it("updates user total_points after backfill", () => {
    const testDb = createTestDb();
    const base = seedBaseData(testDb);
    const { lessons } = createModuleWithLessons(testDb, base.course.id, "M1", 1, 1);

    testDb.insert(lessonProgress).values({
      userId: base.user.id,
      lessonId: lessons[0].id,
      status: LessonProgressStatus.Completed,
      completedAt: "2026-06-10T12:00:00Z",
    }).run();

    backfillGamification(testDb);

    const user = testDb.select().from(users).where(eq(users.id, base.user.id)).get();
    expect(user?.totalPoints).toBe(10);
  });

  it("is idempotent — running twice does not create duplicates", () => {
    const testDb = createTestDb();
    const base = seedBaseData(testDb);
    const { lessons } = createModuleWithLessons(testDb, base.course.id, "M1", 1, 1);

    testDb.insert(lessonProgress).values({
      userId: base.user.id,
      lessonId: lessons[0].id,
      status: LessonProgressStatus.Completed,
      completedAt: "2026-06-10T12:00:00Z",
    }).run();

    backfillGamification(testDb);
    const logsAfterFirst = testDb.select().from(userPointsLog).all();

    backfillGamification(testDb);
    const logsAfterSecond = testDb.select().from(userPointsLog).all();

    expect(logsAfterSecond).toHaveLength(logsAfterFirst.length);
  });

  it("calculates streak from consecutive lesson completion dates", () => {
    const testDb = createTestDb();
    const base = seedBaseData(testDb);
    const { lessons } = createModuleWithLessons(testDb, base.course.id, "M1", 1, 4);

    // Consecutive days: June 10, 11, 12, 15 (gap on 13-14)
    const dates = ["2026-06-10", "2026-06-11", "2026-06-12", "2026-06-15"];
    for (let i = 0; i < dates.length; i++) {
      testDb.insert(lessonProgress).values({
        userId: base.user.id,
        lessonId: lessons[i].id,
        status: LessonProgressStatus.Completed,
        completedAt: `${dates[i]}T12:00:00Z`,
      }).run();
    }

    // Current date is 2026-06-15 (from beforeEach), so most recent date = today
    // Streak = 1 (just June 15 alone)
    const results = backfillGamification(testDb);
    const userResult = results.find((r) => r.userId === base.user.id);
    expect(userResult!.streak).toBe(1);
  });

  it("calculates streak of 3 from consecutive days ending yesterday", () => {
    const testDb = createTestDb();
    const base = seedBaseData(testDb);
    const { lessons } = createModuleWithLessons(testDb, base.course.id, "M1", 1, 3);

    // Consecutive days: June 13, 14, 15 (today is June 15)
    const dates = ["2026-06-13", "2026-06-14", "2026-06-15"];
    for (let i = 0; i < dates.length; i++) {
      testDb.insert(lessonProgress).values({
        userId: base.user.id,
        lessonId: lessons[i].id,
        status: LessonProgressStatus.Completed,
        completedAt: `${dates[i]}T12:00:00Z`,
      }).run();
    }

    const results = backfillGamification(testDb);
    const userResult = results.find((r) => r.userId === base.user.id);
    expect(userResult!.streak).toBe(3);
  });

  it("sets streak to 0 when most recent activity is more than 1 day ago", () => {
    const testDb = createTestDb();
    const base = seedBaseData(testDb);
    const { lessons } = createModuleWithLessons(testDb, base.course.id, "M1", 1, 1);

    // Activity 5 days ago
    testDb.insert(lessonProgress).values({
      userId: base.user.id,
      lessonId: lessons[0].id,
      status: LessonProgressStatus.Completed,
      completedAt: "2026-06-10T12:00:00Z",
    }).run();

    const results = backfillGamification(testDb);
    const userResult = results.find((r) => r.userId === base.user.id);
    expect(userResult!.streak).toBe(0);
  });

  it("handles users with no progress gracefully", () => {
    const testDb = createTestDb();
    const base = seedBaseData(testDb);

    const results = backfillGamification(testDb);
    const userResult = results.find((r) => r.userId === base.user.id);

    expect(userResult).toBeDefined();
    expect(userResult!.totalXp).toBe(0);
    expect(userResult!.lessonXp).toBe(0);
    expect(userResult!.quizXp).toBe(0);
    expect(userResult!.courseXp).toBe(0);
  });
});
