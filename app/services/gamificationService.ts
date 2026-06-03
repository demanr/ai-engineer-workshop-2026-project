import { eq, and, desc } from "drizzle-orm";
import { db } from "~/db";
import { users, userPointsLog, PointsReason } from "~/db/schema";

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
  const totalXpAwarded = lessonXp + milestoneExtraXp;
  const newTotalPoints = user.totalPoints + totalXpAwarded;

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
    courseCompleted: false,
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
