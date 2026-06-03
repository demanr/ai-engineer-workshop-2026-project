import Database from "better-sqlite3";
import { eq, and, desc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import * as schema from "../app/db/schema";
import {
  PointsReason,
  LessonProgressStatus,
  userPointsLog,
  users,
  lessonProgress,
  lessons,
  modules,
  quizAttempts,
  enrollments,
} from "../app/db/schema";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsFolder = path.resolve(__dirname, "../drizzle");

export function backfillGamification(db: ReturnType<typeof drizzle>) {
  const allUsers = db.select().from(users).all();
  const results: Array<{ userId: number; lessonXp: number; quizXp: number; courseXp: number; totalXp: number; streak: number }> = [];

  for (const user of allUsers) {
    let totalXp = 0;
    let lessonXp = 0;
    let quizXp = 0;
    let courseXp = 0;

    // ── Lesson XP ──
    const completedLessons = db
      .select()
      .from(lessonProgress)
      .where(
        and(
          eq(lessonProgress.userId, user.id),
          eq(lessonProgress.status, LessonProgressStatus.Completed),
        ),
      )
      .all();

    for (const progress of completedLessons) {
      const existing = db
        .select()
        .from(userPointsLog)
        .where(
          and(
            eq(userPointsLog.userId, user.id),
            eq(userPointsLog.reason, PointsReason.LessonComplete),
            eq(userPointsLog.referenceId, progress.lessonId),
          ),
        )
        .get();

      if (!existing) {
        db.insert(userPointsLog)
          .values({
            userId: user.id,
            points: 10,
            reason: PointsReason.LessonComplete,
            referenceId: progress.lessonId,
            createdAt: progress.completedAt ?? undefined,
          })
          .run();
        lessonXp += 10;
        totalXp += 10;
      }
    }

    // ── Quiz XP ──
    const passedQuizzes = db
      .select()
      .from(quizAttempts)
      .where(
        and(
          eq(quizAttempts.userId, user.id),
          eq(quizAttempts.passed, true),
        ),
      )
      .orderBy(quizAttempts.attemptedAt)
      .all();

    // Track first attempts per quiz
    const seenQuizzes = new Set<number>();

    for (const attempt of passedQuizzes) {
      const existing = db
        .select()
        .from(userPointsLog)
        .where(
          and(
            eq(userPointsLog.userId, user.id),
            eq(userPointsLog.reason, PointsReason.QuizPass),
            eq(userPointsLog.referenceId, attempt.quizId),
          ),
        )
        .get();

      if (!existing) {
        db.insert(userPointsLog)
          .values({
            userId: user.id,
            points: 25,
            reason: PointsReason.QuizPass,
            referenceId: attempt.quizId,
            createdAt: attempt.attemptedAt,
          })
          .run();
        quizXp += 25;
        totalXp += 25;

        // First-try bonus: if this is the first attempt for this quiz
        if (!seenQuizzes.has(attempt.quizId)) {
          const existingBonus = db
            .select()
            .from(userPointsLog)
            .where(
              and(
                eq(userPointsLog.userId, user.id),
                eq(userPointsLog.reason, PointsReason.FirstTryBonus),
                eq(userPointsLog.referenceId, attempt.quizId),
              ),
            )
            .get();

          if (!existingBonus) {
            db.insert(userPointsLog)
              .values({
                userId: user.id,
                points: 15,
                reason: PointsReason.FirstTryBonus,
                referenceId: attempt.quizId,
                createdAt: attempt.attemptedAt,
              })
              .run();
            quizXp += 15;
            totalXp += 15;
          }
        }
      }
      seenQuizzes.add(attempt.quizId);
    }

    // ── Course completion XP ──
    const completedCourses = db
      .select()
      .from(enrollments)
      .where(
        and(
          eq(enrollments.userId, user.id),
          sql`${enrollments.completedAt} IS NOT NULL`,
        ),
      )
      .all();

    for (const enrollment of completedCourses) {
      const existing = db
        .select()
        .from(userPointsLog)
        .where(
          and(
            eq(userPointsLog.userId, user.id),
            eq(userPointsLog.reason, PointsReason.CourseComplete),
            eq(userPointsLog.referenceId, enrollment.courseId),
          ),
        )
        .get();

      if (!existing) {
        db.insert(userPointsLog)
          .values({
            userId: user.id,
            points: 200,
            reason: PointsReason.CourseComplete,
            referenceId: enrollment.courseId,
            createdAt: enrollment.completedAt ?? undefined,
          })
          .run();
        courseXp += 200;
        totalXp += 200;
      }
    }

    // ── Streak from completed lesson dates ──
    const dates = completedLessons
      .map((p) => p.completedAt?.split("T")[0])
      .filter((d): d is string => !!d);

    const uniqueDates = [...new Set(dates)].sort().reverse();
    let streak = 0;

    if (uniqueDates.length > 0) {
      const today = new Date().toISOString().split("T")[0];
      let expectedDate = today;

      // Start from the most recent date; if it's not today or yesterday, streak is 0
      const mostRecentDate = uniqueDates[0];
      const msPerDay = 86_400_000;
      const diffFromToday =
        (new Date(today + "T00:00:00Z").getTime() -
          new Date(mostRecentDate + "T00:00:00Z").getTime()) /
        msPerDay;

      if (diffFromToday > 1) {
        // Most recent activity is more than 1 day ago — streak is 0
        streak = 0;
      } else {
        // Count consecutive days from mostRecentDate backwards
        expectedDate = mostRecentDate;
        for (const date of uniqueDates) {
          const expectedTs = new Date(expectedDate + "T00:00:00Z").getTime();
          const dateTs = new Date(date + "T00:00:00Z").getTime();
          if (expectedTs - dateTs === 0) {
            streak++;
            // Move expected date back by 1 day
            const prev = new Date(expectedTs - msPerDay);
            expectedDate = prev.toISOString().split("T")[0];
          } else {
            break;
          }
        }
      }
    }

    // ── Update user ──
    db.update(users)
      .set({
        totalPoints: totalXp,
        streakCount: streak,
      })
      .where(eq(users.id, user.id))
      .run();

    results.push({
      userId: user.id,
      lessonXp,
      quizXp,
      courseXp,
      totalXp,
      streak,
    });
  }

  return results;
}

// Run directly when executed as a script
if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  const sqlite = new Database("data.db");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });

  console.log("Starting gamification backfill...");
  const res = backfillGamification(db);
  console.log(`Processed ${res.length} users:`);
  for (const r of res) {
    console.log(
      `  User ${r.userId}: +${r.totalXp} XP total (${r.lessonXp} lesson, ${r.quizXp} quiz, ${r.courseXp} course), streak=${r.streak} days`,
    );
  }
  console.log("Backfill complete.");
}
