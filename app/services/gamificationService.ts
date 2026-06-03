import { eq, and, desc } from "drizzle-orm";
import { db } from "~/db";
import { users, userPointsLog, PointsReason } from "~/db/schema";

export function calculateLevel(totalPoints: number): number {
  return Math.floor(Math.sqrt(totalPoints / 100)) + 1;
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
  const xpAwarded = 10;
  const newTotalPoints = user.totalPoints + xpAwarded;

  db.insert(userPointsLog)
    .values({
      userId,
      points: xpAwarded,
      reason: PointsReason.LessonComplete,
      referenceId: lessonId,
    })
    .run();

  db.update(users)
    .set({ totalPoints: newTotalPoints })
    .where(eq(users.id, userId))
    .run();

  const afterLevel = calculateLevel(newTotalPoints);

  return {
    xpAwarded,
    streakCount: user.streakCount,
    levelUp: afterLevel > beforeLevel,
    newLevel: afterLevel,
    courseCompleted: false,
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
