/**
 * 产品测试 / 使用记录：仅观察推荐过程，不改变推荐算法。
 * localStorage key 与档案、餐厅记忆完全独立。
 */

export const USAGE_LOG_STORAGE_KEY = "today_eat_usage_logs";

export type UsageRecommendationDetail = {
  restaurantId: string;
  restaurantName: string;
  baseScore: number;
  sceneScore: number;
  historyScore: number;
  totalScore: number;
  matchedPreferences: string[];
  matchedScenes: string[];
  historicalRatings: number[];
  averageHistoricalRating: number | null;
  excludedByHistory: boolean;
};

export type UsageLog = {
  id: string;
  createdAt: string;
  /** finish = 完成并生成推荐；reroll = 再抽一次 */
  trigger: "finish" | "reroll";

  selectedProfileIds: string[];
  selectedProfileNames: string[];

  partySize: number;
  diningScene: string;

  rawStatus: string[];
  avoidTags: string[];
  preferTags: string[];

  maxDistanceKm: number;

  hardFilterCandidateCount: number;
  preferenceMatchedCandidateCount: number;
  usedPreferencePool: boolean;

  /** 进入排序池的餐厅 id（非硬过滤全集） */
  candidateRestaurantIds: string[];

  recommendedRestaurantIds: string[];
  recommendedRestaurantNames: string[];

  /** 与最终推荐同分的并列项（含最终选中） */
  tiedRestaurantIds: string[];

  /** 硬过滤后因历史 1/2 星未进排序池的餐厅 */
  historyExcludedRestaurantIds: string[];

  recommendationDetails: UsageRecommendationDetail[];

  distanceRelaxed: boolean;
};

function newLogId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `log_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function isUsageLog(x: unknown): x is UsageLog {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.createdAt === "string" &&
    Array.isArray(o.selectedProfileIds) &&
    Array.isArray(o.recommendationDetails)
  );
}

export function getUsageLogs(): UsageLog[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(USAGE_LOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isUsageLog);
  } catch {
    return [];
  }
}

function saveUsageLogs(next: UsageLog[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(USAGE_LOG_STORAGE_KEY, JSON.stringify(next));
  } catch (e) {
    console.warn("[usageLog] save failed", e);
  }
}

export function appendUsageLog(
  partial: Omit<UsageLog, "id" | "createdAt">
): UsageLog | null {
  try {
    const entry: UsageLog = {
      ...partial,
      id: newLogId(),
      createdAt: new Date().toISOString(),
    };
    const prev = getUsageLogs();
    saveUsageLogs([...prev, entry]);
    return entry;
  } catch (e) {
    console.warn("[usageLog] append failed", e);
    return null;
  }
}

export function deleteUsageLogs(ids: string[]): UsageLog[] {
  const idSet = new Set(ids);
  const next = getUsageLogs().filter((l) => !idSet.has(l.id));
  saveUsageLogs(next);
  return next;
}

export function clearUsageLogs(): void {
  saveUsageLogs([]);
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function joinList(values: string[]): string {
  return values.join("；");
}

/**
 * 扁平导出；嵌套完整 details 仍在 localStorage。
 * CSV Top3 列；UTF-8 BOM 便于 Excel 打开中文。
 */
export function exportUsageLogsToCSV(logs: UsageLog[] = getUsageLogs()): void {
  if (typeof window === "undefined") return;

  const headers = [
    "时间",
    "触发",
    "用餐成员",
    "人数",
    "用餐场景",
    "原始输入",
    "忌口标签",
    "偏好标签",
    "最大距离",
    "硬过滤后餐厅数",
    "偏好命中餐厅数",
    "是否使用偏好池",
    "是否放宽距离",
    "并列同分餐厅数",
    "推荐1",
    "推荐1总分",
    "推荐1基础分",
    "推荐1场景分",
    "推荐1历史分",
    "推荐1历史评分",
    "推荐2",
    "推荐2总分",
    "推荐2基础分",
    "推荐2场景分",
    "推荐2历史分",
    "推荐2历史评分",
    "推荐3",
    "推荐3总分",
    "推荐3基础分",
    "推荐3场景分",
    "推荐3历史分",
    "推荐3历史评分",
  ];

  const rows = logs.map((log) => {
    const sorted = [...log.recommendationDetails].sort(
      (a, b) => b.totalScore - a.totalScore
    );
    const top = [0, 1, 2].map((i) => sorted[i] ?? null);

    const cells: string[] = [
      log.createdAt,
      log.trigger === "reroll" ? "再抽一次" : "完成推荐",
      joinList(log.selectedProfileNames),
      String(log.partySize),
      log.diningScene,
      joinList(log.rawStatus),
      joinList(log.avoidTags),
      joinList(log.preferTags),
      String(log.maxDistanceKm),
      String(log.hardFilterCandidateCount),
      String(log.preferenceMatchedCandidateCount),
      log.usedPreferencePool ? "是" : "否",
      log.distanceRelaxed ? "是" : "否",
      String(log.tiedRestaurantIds?.length ?? 0),
    ];

    for (const d of top) {
      if (!d) {
        cells.push("", "", "", "", "", "");
        continue;
      }
      cells.push(
        d.restaurantName,
        String(d.totalScore),
        String(d.baseScore),
        String(d.sceneScore),
        String(d.historyScore),
        d.historicalRatings.map(String).join("|")
      );
    }

    return cells.map(csvEscape).join(",");
  });

  const csv = `\ufeff${headers.join(",")}\n${rows.join("\n")}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "today_eat_usage_logs.csv";
  a.click();
  URL.revokeObjectURL(url);
}
