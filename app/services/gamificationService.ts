import { eq, and, or, desc, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  users,
  userPointsLog,
  lessonProgress,
  lessons,
  modules,
  LessonProgressStatus,
  PointsReason,
} from "~/db/schema";

export function calculateLevel(totalPoints: number): number {
  return Math.floor(Math.sqrt(totalPoints / 100)) + 1;
}

function getTodayUTC(): string {
  return new Date().toISOString().split("T")[0];
}

function isConsecutiveDay(today: string, lastDate: string): boolean {
  const todayTs = new Date(today + "T00:00:00Z").getTime();
  const lastTs = new Date(lastDate + "T00:00:00Z").getTime();
  return todayTs - lastTs === 86_400_000;
}

function getLessonIdsForCourse(courseId: number): number[] {
  const courseModules = db
    .select({ id: modules.id })
    .from(modules)
    .where(eq(modules.courseId, courseId))
    .all();

  if (courseModules.length === 0) return [];

  const courseLessons = db
    .select({ id: lessons.id })
    .from(lessons)
    .where(
      or(...courseModules.map((m) => eq(lessons.moduleId, m.id)))!,
    )
    .all();

  return courseLessons.map((l) => l.id);
}

function isCourseCompleted(userId: number, courseId: number): boolean {
  const lessonIds = getLessonIdsForCourse(courseId);
  if (lessonIds.length === 0) return false;

  const completedCount = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        or(...lessonIds.map((id) => eq(lessonProgress.lessonId, id)))!,
      ),
    )
    .get();

  return (completedCount?.count ?? 0) >= lessonIds.length;
}

export function awardLessonXp(
  userId: number,
  lessonId: number,
  courseId: number,
) {
  const existing = db
    .select()
    .from(userPointsLog)
    .where(
      and(
        eq(userPointsLog.userId, userId),
        eq(userPointsLog.reason, PointsReason.LessonComplete),
        eq(userPointsLog.referenceId, lessonId),
      ),
    )
    .get();

  if (existing) {
    const user = db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .get()!;
    const level = calculateLevel(user.totalPoints);
    return {
      xpAwarded: 0,
      streakCount: user.streakCount,
      levelUp: false,
      newLevel: level,
      courseCompleted: false,
    };
  }

  const user = db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .get()!;

  const beforeLevel = calculateLevel(user.totalPoints);
  const today = getTodayUTC();
  const lastDate = user.lastActivityDate;
  let streakCount = user.streakCount;

  if (lastDate === today) {
    // Same day — do not increment
  } else if (lastDate && isConsecutiveDay(today, lastDate)) {
    streakCount += 1;
  } else {
    streakCount = 1;
  }

  let streakMilestone: { day: number; bonusXp: number } | undefined;
  let milestoneExtraXp = 0;

  if (streakCount === 3 || streakCount === 7 || streakCount === 30) {
    const milestoneXp = streakCount === 3 ? 50 : streakCount === 7 ? 100 : 500;

    const existingMilestone = db
      .select()
      .from(userPointsLog)
      .where(
        and(
          eq(userPointsLog.userId, userId),
          eq(userPointsLog.reason, PointsReason.StreakMilestone),
          eq(userPointsLog.referenceId, streakCount),
        ),
      )
      .get();

    if (!existingMilestone) {
      streakMilestone = { day: streakCount, bonusXp: milestoneXp };
      milestoneExtraXp = milestoneXp;
    }
  }

  const lessonXp = 10;
  let totalXpAwarded = lessonXp + milestoneExtraXp;
  let newTotalPoints = user.totalPoints + totalXpAwarded;
  let courseCompleted = false;
  let courseCompletedBonusXp = 0;

  db.insert(userPointsLog)
    .values({
      userId,
      points: lessonXp,
      reason: PointsReason.LessonComplete,
      referenceId: lessonId,
    })
    .run();

  if (streakMilestone) {
    db.insert(userPointsLog)
      .values({
        userId,
        points: streakMilestone.bonusXp,
        reason: PointsReason.StreakMilestone,
        referenceId: streakMilestone.day,
        metadata: JSON.stringify({ day: streakMilestone.day }),
      })
      .run();
  }

  // Check course completion after awarding lesson XP
  const existingCourseComplete = db
    .select()
    .from(userPointsLog)
    .where(
      and(
        eq(userPointsLog.userId, userId),
        eq(userPointsLog.reason, PointsReason.CourseComplete),
        eq(userPointsLog.referenceId, courseId),
      ),
    )
    .get();

  if (!existingCourseComplete && isCourseCompleted(userId, courseId)) {
    courseCompleted = true;
    courseCompletedBonusXp = 200;
    totalXpAwarded += courseCompletedBonusXp;
    newTotalPoints += courseCompletedBonusXp;

    db.insert(userPointsLog)
      .values({
        userId,
        points: courseCompletedBonusXp,
        reason: PointsReason.CourseComplete,
        referenceId: courseId,
      })
      .run();
  }

  db.update(users)
    .set({
      totalPoints: newTotalPoints,
      streakCount,
      lastActivityDate: today,
    })
    .where(eq(users.id, userId))
    .run();

  const afterLevel = calculateLevel(newTotalPoints);

  return {
    xpAwarded: totalXpAwarded,
    streakCount,
    levelUp: afterLevel > beforeLevel,
    newLevel: afterLevel,
    courseCompleted,
    courseCompletedBonusXp,
    streakMilestone,
  };
}

export function getUserStats(userId: number) {
  const user = db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .get()!;

  const level = calculateLevel(user.totalPoints);
  const pointsForNextLevel = 100 * Math.pow(level, 2);
  const pointsToNextLevel = pointsForNextLevel - user.totalPoints;

  return {
    totalPoints: user.totalPoints,
    level,
    pointsToNextLevel,
    streakCount: user.streakCount,
    lastActivityDate: user.lastActivityDate,
  };
}

export function getPointsLog(userId: number) {
  return db
    .select()
    .from(userPointsLog)
    .where(eq(userPointsLog.userId, userId))
    .orderBy(desc(userPointsLog.createdAt))
    .all();
}
