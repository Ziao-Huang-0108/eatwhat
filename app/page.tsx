"use client";

/**
 * 今天吃什么 — app/page.tsx（完整版）
 * - 硬过滤：忌口 + 距离（人数仅舒适参考）
 * - 两层池：有明确偏好命中时只在命中子集排序，否则退回全候选
 * - 池内：场景 + 档案历史记忆（辅助）+ 基础星级；偏好靠进池体现，不加分
 * - 评分记忆绑定用餐人档案；多人共同经历写入所有已选成员
 * - 产品测试：usage log（localStorage）观察推荐过程，不改变算法
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  MapPin,
  Pencil,
  Plus,
  RotateCcw,
  Star,
  Trash2,
  Utensils,
  X,
} from "lucide-react";
import {
  appendUsageLog,
  deleteUsageLogs,
  exportUsageLogsToCSV,
  getUsageLogs,
  type UsageLog,
} from "@/lib/usageLog";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

type Profile = {
  id: string;
  name: string;
  rawStatus: string;
};

type DiningScene =
  | "一人食"
  | "情侣约会"
  | "朋友聚餐"
  | "同事聚餐"
  | "家人聚餐";

type Restaurant = {
  id: string;
  name: string;
  rating: number;
  distance: number;
  tags: string[];
  isOily: boolean;
  isSeafood: boolean;
  minPeople: number;
  maxPeople: number;
  scenes: DiningScene[];
};

/** 用餐人对餐厅的评分记忆（按档案绑定，存入 localStorage.restaurant_memory_v2） */
export type RestaurantMemory = {
  profileId: string;
  restaurantId: string;
  restaurantName: string;
  rating: number; // 1-5
  savedAt: number;
};

export type HardFilterResult = {
  candidates: Restaurant[];
  /** 严格距离下无结果时，是否已放宽距离限制 */
  relaxedDistance: boolean;
  /** 兜底 / 无结果时的友情提示 */
  tip: string | null;
};

/** 所选成员对某店的历史合并结果 */
export type GroupHistoryResult = {
  /** 任一成员最新分为 1 或 2 星 → 排除 */
  excluded: boolean;
  /** 有记录成员的平均星级；无人有记录则为 null */
  avgRating: number | null;
  /** 映射后的历史加分（0–10）；排除或无记录时为 0 */
  score: number;
  /** 参与平均的成员数（排除时为 0） */
  contributorCount: number;
  /** 有记录成员的最新评分（无记录不进数组；排除时仍列出已读到的分） */
  ratings: number[];
};

type ResultPhase = "idle" | "loading" | "ready";

const STORAGE_PROFILES = "eatwhat_profiles_v2";
const STORAGE_MEMORY = "restaurant_memory_v2";
const STEPS = 3;
const SCENE_SCORE = 30;
const HISTORY_SCORE_MAX = 10;

// ---------------------------------------------------------------------------
// 忌口 / 偏好
// ---------------------------------------------------------------------------

function normalizeToken(s: string): string {
  return s
    .replace(/[的了吗呢啊呀]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function mapAvoidSynonym(token: string): string {
  const t = normalizeToken(token);
  if (!t) return t;
  if (/辣|辣椒|辛辣|重口/.test(t)) return "辣";
  if (/海鲜|虾|蟹|鱼生|刺身/.test(t)) return "海鲜";
  if (/油|腻|油炸|烧烤|太油/.test(t)) return "油腻";
  return t;
}

function extractAvoidTags(raw: string): string[] {
  const s = raw.trim();
  if (!s) return [];
  const out = new Set<string>();

  for (const m of s.matchAll(/不(?:想)?吃([\u4e00-\u9fa5]{1,10})/g)) {
    if (m[1]) out.add(mapAvoidSynonym(m[1]));
  }
  for (const m of s.matchAll(/不能吃([\u4e00-\u9fa5]{1,10})/g)) {
    if (m[1]) out.add(mapAvoidSynonym(m[1]));
  }
  for (const m of s.matchAll(/不要([\u4e00-\u9fa5]{1,10})/g)) {
    if (m[1]) out.add(mapAvoidSynonym(m[1]));
  }
  for (const m of s.matchAll(/对([\u4e00-\u9fa5]{1,8})过敏/g)) {
    if (m[1]) out.add(mapAvoidSynonym(m[1]));
  }
  for (const m of s.matchAll(/([\u4e00-\u9fa5]{1,8})过敏/g)) {
    const w = m[1];
    if (w && !/^我|人|严|易|慢|急$/.test(w)) out.add(mapAvoidSynonym(w));
  }
  for (const m of s.matchAll(/忌(?:口|食)?[：:\s]*([\u4e00-\u9fa5]{1,10})/g)) {
    if (m[1]) out.add(mapAvoidSynonym(m[1]));
  }

  return Array.from(out).filter(Boolean);
}

function extractPreferTags(raw: string): string[] {
  const s = raw.trim();
  if (!s) return [];
  const out = new Set<string>();

  for (const m of s.matchAll(/想吃([\u4e00-\u9fa5]{1,10})/g)) {
    if (m[1]) out.add(normalizeToken(m[1]));
  }
  for (const m of s.matchAll(/喜欢([\u4e00-\u9fa5]{1,10})/g)) {
    if (m[1]) out.add(normalizeToken(m[1]));
  }
  if (/增肌/.test(s)) out.add("高蛋白");

  return Array.from(out).filter(Boolean);
}

export function inferDietSignals(rawStatus: string): {
  avoidTags: string[];
  preferTags: string[];
} {
  return {
    avoidTags: extractAvoidTags(rawStatus),
    preferTags: extractPreferTags(rawStatus),
  };
}

function mergeSignalsFromProfiles(
  profiles: Profile[],
  selectedIds: Set<string>
): { avoidTags: string[]; preferTags: string[] } {
  const avoid = new Set<string>();
  const prefer = new Set<string>();
  for (const p of profiles) {
    if (!selectedIds.has(p.id)) continue;
    const { avoidTags, preferTags } = inferDietSignals(p.rawStatus);
    for (const t of avoidTags) avoid.add(t);
    for (const t of preferTags) prefer.add(t);
  }
  return { avoidTags: Array.from(avoid), preferTags: Array.from(prefer) };
}

// ---------------------------------------------------------------------------
// Mock 餐厅
// ---------------------------------------------------------------------------

const RESTAURANTS: Restaurant[] = [
  {
    id: "r1",
    name: "云朵轻食碗",
    rating: 4.7,
    distance: 1.2,
    tags: ["轻食", "沙拉", "不辣"],
    isOily: false,
    isSeafood: false,
    minPeople: 1,
    maxPeople: 2,
    scenes: ["一人食"],
  },
  {
    id: "r2",
    name: "老灶火锅馆",
    rating: 4.5,
    distance: 3.0,
    tags: ["火锅", "聚餐", "辣"],
    isOily: true,
    isSeafood: false,
    minPeople: 2,
    maxPeople: 8,
    scenes: ["朋友聚餐", "同事聚餐"],
  },
  {
    id: "r3",
    name: "海港蒸汽海鲜",
    rating: 4.6,
    distance: 4.5,
    tags: ["海鲜", "蒸汽", "清淡"],
    isOily: false,
    isSeafood: true,
    minPeople: 2,
    maxPeople: 8,
    scenes: ["家人聚餐", "朋友聚餐", "情侣约会"],
  },
  {
    id: "r4",
    name: "牛记清汤牛肉面",
    rating: 4.4,
    distance: 0.8,
    tags: ["面食", "清淡", "不辣"],
    isOily: false,
    isSeafood: false,
    minPeople: 1,
    maxPeople: 4,
    scenes: ["一人食", "朋友聚餐"],
  },
  {
    id: "r5",
    name: "炙烤蛋白质工坊",
    rating: 4.8,
    distance: 2.1,
    tags: ["高蛋白", "轻食", "健身餐"],
    isOily: false,
    isSeafood: false,
    minPeople: 1,
    maxPeople: 2,
    scenes: ["一人食"],
  },
  {
    id: "r6",
    name: "西域清真烧烤",
    rating: 4.3,
    distance: 5.5,
    tags: ["烧烤", "清真", "聚餐", "辣"],
    isOily: true,
    isSeafood: false,
    minPeople: 2,
    maxPeople: 8,
    scenes: ["朋友聚餐", "同事聚餐"],
  },
  {
    id: "r7",
    name: "一叶素食自助",
    rating: 4.5,
    distance: 2.8,
    tags: ["素食", "自助", "轻食"],
    isOily: false,
    isSeafood: false,
    minPeople: 1,
    maxPeople: 6,
    scenes: ["一人食", "朋友聚餐", "家人聚餐"],
  },
  {
    id: "r8",
    name: "低糖甜品实验室",
    rating: 4.2,
    distance: 1.9,
    tags: ["甜品", "低糖", "轻食"],
    isOily: false,
    isSeafood: false,
    minPeople: 1,
    maxPeople: 4,
    scenes: ["一人食", "情侣约会"],
  },
  {
    id: "r9",
    name: "蜀味蜀香川渝火锅",
    rating: 4.7,
    distance: 2.3,
    tags: ["川菜", "火锅", "重油", "辣"],
    isOily: true,
    isSeafood: false,
    minPeople: 2,
    maxPeople: 8,
    scenes: ["朋友聚餐", "同事聚餐"],
  },
  {
    id: "r10",
    name: "巷子口老成都串串香",
    rating: 4.5,
    distance: 1.5,
    tags: ["串串", "川菜", "宵夜", "辣"],
    isOily: true,
    isSeafood: false,
    minPeople: 2,
    maxPeople: 6,
    scenes: ["朋友聚餐"],
  },
  {
    id: "r11",
    name: "滨寿司 (HAMA SUSHI)",
    rating: 4.3,
    distance: 3.1,
    tags: ["日料", "寿司", "海鲜", "清淡"],
    isOily: false,
    isSeafood: true,
    minPeople: 1,
    maxPeople: 6,
    scenes: ["一人食", "情侣约会", "家人聚餐"],
  },
  {
    id: "r12",
    name: "GREEN&FIT 绿动健身轻食",
    rating: 4.8,
    distance: 0.8,
    tags: ["轻食", "健身餐", "低卡", "清淡", "高蛋白"],
    isOily: false,
    isSeafood: false,
    minPeople: 1,
    maxPeople: 2,
    scenes: ["一人食"],
  },
  {
    id: "r13",
    name: "莫奈花园西餐厅",
    rating: 4.9,
    distance: 4.2,
    tags: ["西餐", "牛排", "精致", "甜品"],
    isOily: false,
    isSeafood: true,
    minPeople: 1,
    maxPeople: 4,
    scenes: ["情侣约会", "同事聚餐"],
  },
  {
    id: "r14",
    name: "老北京柴火烤鸭店",
    rating: 4.6,
    distance: 3.8,
    tags: ["北京菜", "烤鸭", "家常菜"],
    isOily: true,
    isSeafood: false,
    minPeople: 3,
    maxPeople: 12,
    scenes: ["家人聚餐", "同事聚餐"],
  },
  {
    id: "r15",
    name: "阿嬷海鲜沙茶面",
    rating: 4.4,
    distance: 1.2,
    tags: ["闽南菜", "小吃", "面食", "海鲜", "清淡"],
    isOily: false,
    isSeafood: true,
    minPeople: 1,
    maxPeople: 4,
    scenes: ["一人食", "朋友聚餐"],
  },
  {
    id: "r16",
    name: "九村烤脑花·江湖烧烤",
    rating: 4.6,
    distance: 2.8,
    tags: ["烧烤", "宵夜", "江湖菜", "辣"],
    isOily: true,
    isSeafood: false,
    minPeople: 2,
    maxPeople: 8,
    scenes: ["朋友聚餐"],
  },
  {
    id: "r17",
    name: "萨莉亚意式餐厅",
    rating: 4.2,
    distance: 1.9,
    tags: ["西餐", "意面", "披萨", "平价"],
    isOily: false,
    isSeafood: false,
    minPeople: 1,
    maxPeople: 8,
    scenes: ["一人食", "朋友聚餐", "家人聚餐"],
  },
  {
    id: "r18",
    name: "泰香米泰国正宗料理",
    rating: 4.7,
    distance: 4.8,
    tags: ["东南亚菜", "泰餐", "冬阴功", "海鲜"],
    isOily: false,
    isSeafood: true,
    minPeople: 2,
    maxPeople: 8,
    scenes: ["情侣约会", "朋友聚餐", "同事聚餐"],
  },
];

// ---------------------------------------------------------------------------
// localStorage：档案
// ---------------------------------------------------------------------------

function loadProfiles(): Profile[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_PROFILES);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is Profile =>
        typeof x === "object" &&
        x !== null &&
        typeof (x as Profile).id === "string" &&
        typeof (x as Profile).name === "string" &&
        typeof (x as Profile).rawStatus === "string"
    );
  } catch {
    return [];
  }
}

function saveProfiles(next: Profile[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_PROFILES, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

function newId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

// ---------------------------------------------------------------------------
// localStorage：餐厅评分记忆（按用餐人档案）
// ---------------------------------------------------------------------------

function loadRestaurantMemory(): RestaurantMemory[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_MEMORY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is RestaurantMemory =>
        typeof x === "object" &&
        x !== null &&
        typeof (x as RestaurantMemory).profileId === "string" &&
        typeof (x as RestaurantMemory).restaurantId === "string" &&
        typeof (x as RestaurantMemory).restaurantName === "string" &&
        typeof (x as RestaurantMemory).rating === "number" &&
        typeof (x as RestaurantMemory).savedAt === "number"
    );
  } catch {
    return [];
  }
}

function saveRestaurantMemory(next: RestaurantMemory[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_MEMORY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

/** 将同一次用餐评分写入所有本次参与成员的档案 */
function appendRestaurantMemoryForProfiles(
  profileIds: string[],
  restaurantId: string,
  restaurantName: string,
  rating: number
) {
  if (profileIds.length === 0) return;
  const savedAt = Date.now();
  const prev = loadRestaurantMemory();
  const entries: RestaurantMemory[] = profileIds.map((profileId) => ({
    profileId,
    restaurantId,
    restaurantName,
    rating,
    savedAt,
  }));
  saveRestaurantMemory([...prev, ...entries]);
}

function memoryEntryKey(m: RestaurantMemory): string {
  return `${m.profileId}|${m.restaurantId}|${m.savedAt}`;
}

/** 删除指定餐厅历史评分条目（立即影响后续推荐） */
function deleteRestaurantMemoryEntries(keys: string[]): RestaurantMemory[] {
  const keySet = new Set(keys);
  const next = loadRestaurantMemory().filter(
    (m) => !keySet.has(memoryEntryKey(m))
  );
  saveRestaurantMemory(next);
  return next;
}

/** 某成员对某店的最新一条记忆 */
function getLatestMemoryForProfileRestaurant(
  memories: RestaurantMemory[],
  profileId: string,
  restaurantId: string
): RestaurantMemory | null {
  const list = memories
    .filter(
      (m) => m.profileId === profileId && m.restaurantId === restaurantId
    )
    .sort((a, b) => b.savedAt - a.savedAt);
  return list[0] ?? null;
}

/**
 * 多人历史合并：
 * - 只看本次已选成员
 * - 任一最新分为 1 或 2 星 → 排除
 * - 否则对「有记录的成员」取平均，映射为 (avg/5)*10；无人有记录 → 不加分
 * ratings 仅用于日志/展示，不改变排除与加分规则
 */
export function resolveGroupHistory(
  memories: RestaurantMemory[],
  selectedProfileIds: string[],
  restaurantId: string
): GroupHistoryResult {
  const ratings: number[] = [];
  let excluded = false;
  for (const profileId of selectedProfileIds) {
    const latest = getLatestMemoryForProfileRestaurant(
      memories,
      profileId,
      restaurantId
    );
    if (!latest) continue;
    ratings.push(latest.rating);
    if (Math.round(latest.rating) <= 2) excluded = true;
  }

  if (excluded) {
    return {
      excluded: true,
      avgRating: null,
      score: 0,
      contributorCount: 0,
      ratings,
    };
  }

  if (ratings.length === 0) {
    return {
      excluded: false,
      avgRating: null,
      score: 0,
      contributorCount: 0,
      ratings: [],
    };
  }

  const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
  const score = Math.min(HISTORY_SCORE_MAX, (avg / 5) * HISTORY_SCORE_MAX);
  return {
    excluded: false,
    avgRating: avg,
    score,
    contributorCount: ratings.length,
    ratings,
  };
}

// ---------------------------------------------------------------------------
// 硬性过滤（第一关：一票否决）
// ---------------------------------------------------------------------------

function violatesAvoid(r: Restaurant, avoidTags: string[]): boolean {
  for (const a of avoidTags) {
    if (!a) continue;
    if (a === "海鲜" || a.includes("海鲜")) {
      if (r.isSeafood || r.tags.some((t) => t.includes("海鲜"))) return true;
      continue;
    }
    if (a === "辣" || a.includes("辣")) {
      // 仅匹配真正含辣的标签；排除「不辣」等否定写法
      if (
        r.tags.some(
          (t) => t.includes("辣") && !t.includes("不辣") && !/^不.*辣/.test(t)
        )
      ) {
        return true;
      }
      continue;
    }
    if (a === "油腻" || a.includes("油腻")) {
      if (r.isOily) return true;
      continue;
    }
    if (r.tags.some((t) => t.includes(a) || a.includes(t))) return true;
  }
  return false;
}

function fitsComfortPartySize(r: Restaurant, partySize: number): boolean {
  return r.minPeople <= partySize && partySize <= r.maxPeople;
}

/**
 * 第一关硬过滤：仅忌口 + 距离。
 * 人数（min/maxPeople）只作舒适参考，不参与一票否决（人多可拼桌/换大桌，人少也可去火锅等）。
 * 若严格距离下无结果，则放宽距离限制并给出友情提示。
 */
export function getHardFilteredCandidates(
  list: Restaurant[],
  avoidTags: string[],
  maxDistanceKm: number
): HardFilterResult {
  const byAvoid = list.filter((r) => !violatesAvoid(r, avoidTags));

  if (byAvoid.length === 0) {
    return {
      candidates: [],
      relaxedDistance: false,
      tip: "当前忌口条件下没有合适餐厅，试试放宽成员忌口条件哦～",
    };
  }

  const withinDistance = byAvoid.filter((r) => r.distance <= maxDistanceKm);

  if (withinDistance.length > 0) {
    return {
      candidates: withinDistance,
      relaxedDistance: false,
      tip: null,
    };
  }

  // 兜底：放宽距离，按距离由近到远保留
  const relaxed = [...byAvoid].sort((a, b) => a.distance - b.distance);
  return {
    candidates: relaxed,
    relaxedDistance: true,
    tip: `附近 ${maxDistanceKm} km 内暂无完全匹配的店，已为你放宽距离限制，优先推荐更近的可选餐厅。`,
  };
}

// ---------------------------------------------------------------------------
// 偏好命中 + 两层池打分
// ---------------------------------------------------------------------------

function countPreferMatches(r: Restaurant, preferTags: string[]): number {
  return listMatchedPreferences(r, preferTags).length;
}

/** 列出命中的偏好标签（与打分同一套匹配规则，供日志复用） */
function listMatchedPreferences(
  r: Restaurant,
  preferTags: string[]
): string[] {
  if (preferTags.length === 0) return [];
  const hits: string[] = [];
  for (const p of preferTags) {
    if (!p) continue;
    if (
      p === "高蛋白" &&
      r.tags.some((t) => t.includes("高蛋白") || t.includes("健身餐"))
    ) {
      hits.push("高蛋白");
      continue;
    }
    if (r.tags.some((t) => t.includes(p) || p.includes(t))) hits.push(p);
  }
  return Array.from(new Set(hits));
}

/** 基础星级分（最高 10）：rating * 2 */
function baseScoreFromRating(rating: number): number {
  return Math.min(10, rating * 2);
}

export type ScoreBreakdown = {
  total: number;
  base: number;
  history: number;
  scene: number;
  sceneMatched: boolean;
  preferHits: number;
  /** 本次是否从「偏好命中池」选出 */
  fromPreferPool: boolean;
  historyAvg: number | null;
  historyContributors: number;
  comfortParty: boolean;
};

export function computeScoreBreakdown(
  r: Restaurant,
  preferTags: string[],
  memories: RestaurantMemory[],
  selectedProfileIds: string[],
  scene: DiningScene,
  fromPreferPool: boolean,
  partySize?: number
): ScoreBreakdown {
  const preferHits = countPreferMatches(r, preferTags);
  const base = baseScoreFromRating(r.rating);
  const group = resolveGroupHistory(memories, selectedProfileIds, r.id);
  const history = group.excluded ? 0 : group.score;
  const sceneMatched = r.scenes.includes(scene);
  const sceneScore = sceneMatched ? SCENE_SCORE : 0;
  const comfortParty =
    partySize == null ? true : fitsComfortPartySize(r, partySize);
  return {
    // 偏好靠进池体现，池内不再加偏好分
    total: base + history + sceneScore,
    base,
    history,
    scene: sceneScore,
    sceneMatched,
    preferHits,
    fromPreferPool,
    historyAvg: group.avgRating,
    historyContributors: group.contributorCount,
    comfortParty,
  };
}

export type RecommendationOptions = {
  excludeId?: string | null;
  scene: DiningScene;
  partySize?: number;
  selectedProfileIds: string[];
};

export type RecommendationDetailSnapshot = {
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

export type RecommendationResult = {
  restaurant: Restaurant | null;
  fromPreferPool: boolean;
  /** 硬过滤候选中偏好标签命中数（与 excludeId / 历史排除无关） */
  preferenceMatchedCandidateCount: number;
  /** 进入排序池的餐厅 */
  rankingPoolIds: string[];
  /** 与最终总分并列的餐厅（含最终选中） */
  tiedRestaurantIds: string[];
  /** 因历史 1/2 星未进排序池 */
  historyExcludedRestaurantIds: string[];
  /** 排序池内得分明细（按总分降序；最终推荐若存在则排在同分最前） */
  recommendationDetails: RecommendationDetailSnapshot[];
};

/**
 * 两层池推荐：
 * 1) 硬过滤候选上，若有偏好命中则只在命中子集排序，否则全候选
 * 2) 任一所选成员对该店最新分为 1/2 星 → 排除
 * 3) 池内按 场景 + 历史（均值映射）+ 基础星级；并列随机
 * 返回值中的 details / tied 等仅供日志观察，不改变抽取逻辑。
 */
export function getRecommendation(
  candidates: Restaurant[],
  preferTags: string[],
  memories: RestaurantMemory[],
  options: RecommendationOptions
): RecommendationResult {
  const selectedProfileIds = options.selectedProfileIds;
  const empty: RecommendationResult = {
    restaurant: null,
    fromPreferPool: false,
    preferenceMatchedCandidateCount: 0,
    rankingPoolIds: [],
    tiedRestaurantIds: [],
    historyExcludedRestaurantIds: [],
    recommendationDetails: [],
  };

  const preferenceMatchedCandidateCount = candidates.filter(
    (r) => countPreferMatches(r, preferTags) > 0
  ).length;

  const historyExcludedRestaurantIds = candidates
    .filter((r) => {
      if (options.excludeId && r.id === options.excludeId) return false;
      return resolveGroupHistory(memories, selectedProfileIds, r.id).excluded;
    })
    .map((r) => r.id);

  const notExcluded = candidates.filter((r) => {
    if (options.excludeId && r.id === options.excludeId) return false;
    const group = resolveGroupHistory(memories, selectedProfileIds, r.id);
    return !group.excluded;
  });
  if (notExcluded.length === 0) {
    return {
      ...empty,
      preferenceMatchedCandidateCount,
      historyExcludedRestaurantIds,
    };
  }

  const preferMatched = notExcluded.filter(
    (r) => countPreferMatches(r, preferTags) > 0
  );
  const fromPreferPool = preferMatched.length > 0;
  const pool = fromPreferPool ? preferMatched : notExcluded;

  const scored = pool.map((r) => {
    const breakdown = computeScoreBreakdown(
      r,
      preferTags,
      memories,
      selectedProfileIds,
      options.scene,
      fromPreferPool,
      options.partySize
    );
    const group = resolveGroupHistory(memories, selectedProfileIds, r.id);
    const detail: RecommendationDetailSnapshot = {
      restaurantId: r.id,
      restaurantName: r.name,
      baseScore: breakdown.base,
      sceneScore: breakdown.scene,
      historyScore: breakdown.history,
      totalScore: breakdown.total,
      matchedPreferences: listMatchedPreferences(r, preferTags),
      matchedScenes: breakdown.sceneMatched ? [options.scene] : [],
      historicalRatings: group.ratings,
      averageHistoricalRating: group.avgRating,
      excludedByHistory: false,
    };
    return { r, breakdown, detail };
  });

  const maxTotal = Math.max(...scored.map((x) => x.breakdown.total));
  const tops = scored.filter((x) => x.breakdown.total === maxTotal);
  const pick = tops[Math.floor(Math.random() * tops.length)];
  const winnerId = pick?.r.id ?? null;

  const recommendationDetails = [...scored]
    .map((x) => x.detail)
    .sort((a, b) => {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      if (winnerId && a.restaurantId === winnerId) return -1;
      if (winnerId && b.restaurantId === winnerId) return 1;
      return a.restaurantName.localeCompare(b.restaurantName, "zh");
    });

  return {
    restaurant: pick?.r ?? null,
    fromPreferPool,
    preferenceMatchedCandidateCount,
    rankingPoolIds: pool.map((r) => r.id),
    tiedRestaurantIds: tops.map((x) => x.r.id),
    historyExcludedRestaurantIds,
    recommendationDetails,
  };
}

// ---------------------------------------------------------------------------
// 推荐理由（中文句子，可多条拼接）
// ---------------------------------------------------------------------------

function buildRecommendReasons(
  r: Restaurant,
  preferTags: string[],
  memories: RestaurantMemory[],
  selectedProfileIds: string[],
  scene: DiningScene,
  fromPreferPool: boolean,
  partySize?: number
): string[] {
  const lines: string[] = [];
  const sceneMatched = r.scenes.includes(scene);
  const preferHits = countPreferMatches(r, preferTags);
  const group = resolveGroupHistory(memories, selectedProfileIds, r.id);

  if (fromPreferPool && preferHits > 0) {
    if (!sceneMatched) {
      lines.push(
        "已按你本次明确想吃的品类优先筛选；虽然场景不完全对应，但这家在同类里综合更合适。"
      );
    } else {
      lines.push(
        "已按你本次明确想吃的品类优先筛选，并适合当前用餐场景。"
      );
    }
  } else if (!sceneMatched) {
    lines.push(
      "虽然场景不完全匹配，但这家最符合大家的口味和忌口哦！"
    );
  } else {
    lines.push("已通过当前成员的忌口与距离等硬性条件，且适合当前用餐场景。");
  }

  const hits: string[] = [];
  for (const p of preferTags) {
    if (!p) continue;
    if (
      p === "高蛋白" &&
      r.tags.some((t) => t.includes("高蛋白") || t.includes("健身餐"))
    ) {
      hits.push("高蛋白 / 健身餐");
      continue;
    }
    if (r.tags.some((t) => t.includes(p) || p.includes(t))) hits.push(p);
  }
  const uniq = Array.from(new Set(hits));
  if (uniq.length > 0) {
    lines.push(`命中本次偏好：${uniq.join("、")}。`);
  }

  if (group.avgRating != null && group.contributorCount > 0) {
    lines.push(
      `本次已选成员中有 ${group.contributorCount} 人对该店有过评分，平均 ${group.avgRating.toFixed(1)} 星，已作为辅助排序。`
    );
  } else {
    lines.push(
      "本次已选成员尚无该店历史评分；打分后会记入每位参与成员的档案。"
    );
  }

  if (partySize != null) {
    const comfort = fitsComfortPartySize(r, partySize);
    lines.push(
      comfort
        ? `人数参考：当前 ${partySize} 人落在舒适接待区间（${r.minPeople}–${r.maxPeople} 人）。`
        : `人数参考：舒适接待约 ${r.minPeople}–${r.maxPeople} 人；人多可拼桌/换大桌，人少也完全可以去。`
    );
  }
  lines.push(`场景标签：${r.scenes.join("、")}。`);

  return lines;
}

function mapsUrlForRestaurant(name: string): string {
  const q = encodeURIComponent(name);
  return `https://maps.apple.com/?q=${q}`;
}

// ---------------------------------------------------------------------------
// UI：泡泡按钮
// ---------------------------------------------------------------------------

function BubbleButton({
  children,
  className = "",
  ...props
}: ComponentProps<typeof motion.button>) {
  return (
    <motion.button
      type="button"
      whileHover={{ scale: 1.06 }}
      whileTap={{ scale: 0.92 }}
      transition={{ type: "spring", stiffness: 420, damping: 18 }}
      className={`rounded-full px-4 py-2 text-sm font-medium shadow-md transition-colors ${className}`}
      {...props}
    >
      {children}
    </motion.button>
  );
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

export default function HomePage() {
  const [mounted, setMounted] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [memories, setMemories] = useState<RestaurantMemory[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [step, setStep] = useState(1);
  const [scene, setScene] = useState<DiningScene>("朋友聚餐");
  const [partySize, setPartySize] = useState(4);
  const [maxDistanceKm, setMaxDistanceKm] = useState(5);

  const [showAddModal, setShowAddModal] = useState(false);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [formName, setFormName] = useState("");
  const [formStatus, setFormStatus] = useState("");

  /** 结果流：完成 → loading 1s → ready */
  const [resultOpen, setResultOpen] = useState(false);
  const [resultPhase, setResultPhase] = useState<ResultPhase>("idle");
  const [picked, setPicked] = useState<Restaurant | null>(null);
  const [candidates, setCandidates] = useState<Restaurant[]>([]);
  const [reasonLines, setReasonLines] = useState<string[]>([]);
  const [breakdown, setBreakdown] = useState<ScoreBreakdown | null>(null);
  const [filterTip, setFilterTip] = useState<string | null>(null);
  const [distanceRelaxed, setDistanceRelaxed] = useState(false);
  const [lastUsageLog, setLastUsageLog] = useState<UsageLog | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);

  /** 测试记录面板 */
  const [testPanelOpen, setTestPanelOpen] = useState(false);
  const [usageLogs, setUsageLogs] = useState<UsageLog[]>([]);
  const [selectedLogIds, setSelectedLogIds] = useState<Set<string>>(new Set());
  const [selectedMemoryKeys, setSelectedMemoryKeys] = useState<Set<string>>(
    () => new Set()
  );

  /** 结果页：用户准备存入记忆的星级（1-5） */
  const [memoryRating, setMemoryRating] = useState<number>(0);
  const [memorySaved, setMemorySaved] = useState(false);

  const { avoidTags, preferTags } = useMemo(
    () => mergeSignalsFromProfiles(profiles, selectedIds),
    [profiles, selectedIds]
  );

  const hardFilter = useMemo(
    () => getHardFilteredCandidates(RESTAURANTS, avoidTags, maxDistanceKm),
    [avoidTags, maxDistanceKm]
  );
  const hardCandidates = hardFilter.candidates;

  useEffect(() => {
    setMounted(true);
    setProfiles(loadProfiles());
    setMemories(loadRestaurantMemory());
    setUsageLogs(getUsageLogs());
  }, []);

  const persist = useCallback((next: Profile[]) => {
    setProfiles(next);
    saveProfiles(next);
  }, []);

  const refreshMemories = useCallback(() => {
    setMemories(loadRestaurantMemory());
  }, []);

  const refreshUsageLogs = useCallback(() => {
    setUsageLogs(getUsageLogs());
  }, []);

  const recordUsageLog = useCallback(
    (
      trigger: "finish" | "reroll",
      hardList: Restaurant[],
      filterMeta: { relaxedDistance: boolean },
      result: RecommendationResult
    ) => {
      const selectedProfiles = profiles.filter((p) => selectedIds.has(p.id));
      const selectedProfileIds = selectedProfiles.map((p) => p.id);
      const entry = appendUsageLog({
        trigger,
        selectedProfileIds,
        selectedProfileNames: selectedProfiles.map((p) => p.name),
        partySize,
        diningScene: scene,
        rawStatus: selectedProfiles.map((p) => p.rawStatus),
        avoidTags: [...avoidTags],
        preferTags: [...preferTags],
        maxDistanceKm,
        hardFilterCandidateCount: hardList.length,
        preferenceMatchedCandidateCount:
          result.preferenceMatchedCandidateCount,
        usedPreferencePool: result.fromPreferPool,
        candidateRestaurantIds: result.rankingPoolIds,
        recommendedRestaurantIds: result.restaurant
          ? [result.restaurant.id]
          : [],
        recommendedRestaurantNames: result.restaurant
          ? [result.restaurant.name]
          : [],
        tiedRestaurantIds: result.tiedRestaurantIds,
        historyExcludedRestaurantIds: result.historyExcludedRestaurantIds,
        recommendationDetails: result.recommendationDetails,
        distanceRelaxed: filterMeta.relaxedDistance,
      });
      if (entry) {
        setLastUsageLog(entry);
        refreshUsageLogs();
      }
    },
    [
      profiles,
      selectedIds,
      partySize,
      scene,
      avoidTags,
      preferTags,
      maxDistanceKm,
      refreshUsageLogs,
    ]
  );

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const openAdd = () => {
    setEditing(null);
    setFormName("");
    setFormStatus("");
    setShowAddModal(true);
  };

  const openEdit = (p: Profile) => {
    setEditing(p);
    setFormName(p.name);
    setFormStatus(p.rawStatus);
    setShowAddModal(true);
  };

  const closeModal = () => {
    setShowAddModal(false);
    setEditing(null);
  };

  const submitProfile = () => {
    const name = formName.trim();
    const rawStatus = formStatus.trim();
    if (!name) return;

    if (editing) {
      persist(
        profiles.map((p) =>
          p.id === editing.id ? { ...p, name, rawStatus } : p
        )
      );
    } else {
      persist([...profiles, { id: newId(), name, rawStatus }]);
    }
    closeModal();
  };

  const deleteProfile = (id: string) => {
    if (!confirm("确定删除这位成员吗？")) return;
    persist(profiles.filter((p) => p.id !== id));
    setSelectedIds((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
  };

  const closeResult = () => {
    setResultOpen(false);
    setResultPhase("idle");
    setPicked(null);
    setCandidates([]);
    setReasonLines([]);
    setBreakdown(null);
    setFilterTip(null);
    setDistanceRelaxed(false);
    setLastUsageLog(null);
    setDebugOpen(false);
    setMemoryRating(0);
    setMemorySaved(false);
  };

  /** 在最新 memories 下完成一次抽取并更新展示 */
  const runPick = useCallback(
    (list: Restaurant[], excludeId?: string | null) => {
      const mem = loadRestaurantMemory();
      setMemories(mem);
      const selectedProfileIds = Array.from(selectedIds);
      const result = getRecommendation(list, preferTags, mem, {
        excludeId: excludeId ?? null,
        scene,
        partySize,
        selectedProfileIds,
      });
      const { restaurant: winner, fromPreferPool } = result;
      setPicked(winner);
      if (winner) {
        setReasonLines(
          buildRecommendReasons(
            winner,
            preferTags,
            mem,
            selectedProfileIds,
            scene,
            fromPreferPool,
            partySize
          )
        );
        setBreakdown(
          computeScoreBreakdown(
            winner,
            preferTags,
            mem,
            selectedProfileIds,
            scene,
            fromPreferPool,
            partySize
          )
        );
      } else {
        setReasonLines([]);
        setBreakdown(null);
      }
      setMemoryRating(0);
      setMemorySaved(false);
      recordUsageLog("reroll", list, { relaxedDistance: distanceRelaxed }, result);
    },
    [
      preferTags,
      scene,
      partySize,
      selectedIds,
      recordUsageLog,
      distanceRelaxed,
    ]
  );

  /** 第三步点击「完成」 */
  const onFinishStep3 = () => {
    const filter = getHardFilteredCandidates(
      RESTAURANTS,
      avoidTags,
      maxDistanceKm
    );
    const list = [...filter.candidates];
    setCandidates(list);
    setFilterTip(filter.tip);
    setDistanceRelaxed(filter.relaxedDistance);
    setResultOpen(true);
    setResultPhase("loading");
    setPicked(null);
    setReasonLines([]);
    setBreakdown(null);
    setLastUsageLog(null);
    setDebugOpen(false);
    setMemoryRating(0);
    setMemorySaved(false);

    window.setTimeout(() => {
      const mem = loadRestaurantMemory();
      setMemories(mem);
      const selectedProfileIds = Array.from(selectedIds);
      const result = getRecommendation(list, preferTags, mem, {
        scene,
        partySize,
        selectedProfileIds,
      });
      const { restaurant: winner, fromPreferPool } = result;
      setPicked(winner);
      if (winner) {
        setReasonLines(
          buildRecommendReasons(
            winner,
            preferTags,
            mem,
            selectedProfileIds,
            scene,
            fromPreferPool,
            partySize
          )
        );
        setBreakdown(
          computeScoreBreakdown(
            winner,
            preferTags,
            mem,
            selectedProfileIds,
            scene,
            fromPreferPool,
            partySize
          )
        );
      }
      recordUsageLog(
        "finish",
        list,
        { relaxedDistance: filter.relaxedDistance },
        result
      );
      setResultPhase("ready");
    }, 1000);
  };

  const onPickAgain = () => {
    if (candidates.length === 0) return;
    setResultPhase("loading");
    window.setTimeout(() => {
      runPick(candidates, picked?.id);
      setResultPhase("ready");
    }, 600);
  };

  const onSaveMemory = () => {
    if (!picked || memoryRating < 1 || memoryRating > 5) return;
    if (selectedIds.size === 0) return;
    appendRestaurantMemoryForProfiles(
      Array.from(selectedIds),
      picked.id,
      picked.name,
      memoryRating
    );
    refreshMemories();
    setMemorySaved(true);
  };

  const openTestPanel = () => {
    refreshUsageLogs();
    refreshMemories();
    setSelectedLogIds(new Set());
    setSelectedMemoryKeys(new Set());
    setTestPanelOpen(true);
  };

  const toggleLogSelect = (id: string) => {
    setSelectedLogIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const toggleAllLogs = () => {
    if (selectedLogIds.size === usageLogs.length) {
      setSelectedLogIds(new Set());
    } else {
      setSelectedLogIds(new Set(usageLogs.map((l) => l.id)));
    }
  };

  const deleteSelectedLogs = () => {
    if (selectedLogIds.size === 0) return;
    if (
      !confirm(
        `确定删除选中的 ${selectedLogIds.size} 条测试记录？此操作不影响餐厅历史评分与推荐算法。`
      )
    ) {
      return;
    }
    const next = deleteUsageLogs(Array.from(selectedLogIds));
    setUsageLogs(next);
    setSelectedLogIds(new Set());
    if (lastUsageLog && selectedLogIds.has(lastUsageLog.id)) {
      setLastUsageLog(null);
    }
  };

  const deleteOneLog = (id: string) => {
    if (!confirm("确定删除这条测试记录？不影响餐厅历史评分。")) return;
    const next = deleteUsageLogs([id]);
    setUsageLogs(next);
    setSelectedLogIds((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
    if (lastUsageLog?.id === id) setLastUsageLog(null);
  };

  const toggleMemorySelect = (key: string) => {
    setSelectedMemoryKeys((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  };

  const toggleAllMemories = () => {
    if (selectedMemoryKeys.size === memories.length) {
      setSelectedMemoryKeys(new Set());
    } else {
      setSelectedMemoryKeys(new Set(memories.map(memoryEntryKey)));
    }
  };

  const deleteSelectedMemories = () => {
    if (selectedMemoryKeys.size === 0) return;
    if (
      !confirm(
        `确定删除选中的 ${selectedMemoryKeys.size} 条餐厅历史评分？删除后将不再参与后续推荐。`
      )
    ) {
      return;
    }
    const next = deleteRestaurantMemoryEntries(Array.from(selectedMemoryKeys));
    setMemories(next);
    setSelectedMemoryKeys(new Set());
  };

  const deleteOneMemory = (key: string) => {
    if (!confirm("确定删除这条餐厅历史评分？删除后将不再参与后续推荐。")) {
      return;
    }
    const next = deleteRestaurantMemoryEntries([key]);
    setMemories(next);
    setSelectedMemoryKeys((prev) => {
      const n = new Set(prev);
      n.delete(key);
      return n;
    });
  };

  const profileNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of profiles) m.set(p.id, p.name);
    return m;
  }, [profiles]);

  const canNextFromStep1 = selectedIds.size > 0;
  const progress = (step - 1) / (STEPS - 1);
  const utensilLeftPercent = `${progress * 100}%`;

  if (!mounted) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F5F5DC] text-zinc-600">
        加载中…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F5F5DC] pb-16 text-zinc-800">
      <header className="sticky top-0 z-20 border-b border-amber-200/60 bg-[#F5F5DC]/95 backdrop-blur">
        <div className="mx-auto max-w-lg px-4 pt-4">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-lg font-bold tracking-tight text-amber-900">
              今天吃什么
            </h1>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={openTestPanel}
                className="rounded-full bg-zinc-800/90 px-3 py-1 text-xs text-white shadow-sm hover:bg-zinc-700"
              >
                测试记录
              </button>
              <span className="rounded-full bg-white/70 px-3 py-1 text-xs text-amber-900/80 shadow-sm">
                第 {step} / {STEPS} 步
              </span>
            </div>
          </div>

          <div className="relative mt-4 pb-8">
            <div className="h-3 overflow-hidden rounded-full bg-white/80 shadow-inner">
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-amber-300 to-orange-300"
                initial={false}
                animate={{ width: `${progress * 100}%` }}
                transition={{ type: "spring", stiffness: 120, damping: 18 }}
              />
            </div>

            <motion.div
              className="absolute -top-1 flex h-10 w-10 -translate-x-1/2 items-center justify-center rounded-full bg-white text-amber-700 shadow-lg ring-2 ring-amber-200"
              initial={false}
              animate={{ left: utensilLeftPercent }}
              transition={{ type: "spring", stiffness: 140, damping: 16 }}
            >
              <Utensils className="h-5 w-5" aria-hidden />
            </motion.div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-lg px-4 pt-2">
        <AnimatePresence mode="wait">
          {step === 1 && (
            <motion.section
              key="s1"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25 }}
              className="space-y-4"
            >
              <p className="text-sm leading-relaxed text-zinc-600">
                选择一起吃饭的成员（可多选）。忌口来自「不吃/忌/过敏」等；偏好来自「想吃/喜欢/增肌」。
              </p>

              <BubbleButton
                onClick={openAdd}
                className="w-full bg-amber-400 text-amber-950 hover:bg-amber-300"
              >
                <span className="inline-flex items-center justify-center gap-2">
                  <Plus className="h-4 w-4" />
                  添加新成员
                </span>
              </BubbleButton>

              <div className="space-y-3">
                {profiles.length === 0 && (
                  <p className="rounded-3xl bg-white/70 p-6 text-center text-sm text-zinc-500 shadow-md">
                    还没有成员档案，点上方按钮添加一位吧～
                  </p>
                )}

                {profiles.map((p) => {
                  const active = selectedIds.has(p.id);
                  const { avoidTags: av, preferTags: pr } = inferDietSignals(
                    p.rawStatus
                  );
                  return (
                    <motion.div
                      layout
                      key={p.id}
                      whileHover={{ scale: 1.01 }}
                      whileTap={{ scale: 0.99 }}
                      onClick={() => toggleSelect(p.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleSelect(p.id);
                        }
                      }}
                      className={`cursor-pointer rounded-3xl border-2 p-4 shadow-md transition-colors ${
                        active
                          ? "border-amber-400 bg-amber-50/90"
                          : "border-transparent bg-white/80 hover:border-amber-200"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-base font-semibold text-amber-950">
                            {p.name}
                          </p>
                          <p className="mt-1 text-xs text-zinc-500">
                            状况：{p.rawStatus || "（未填写）"}
                          </p>
                          {(av.length > 0 || pr.length > 0) && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {av.map((t) => (
                                <span
                                  key={`a-${t}`}
                                  className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] text-rose-900"
                                >
                                  忌 {t}
                                </span>
                              ))}
                              {pr.map((t) => (
                                <span
                                  key={`p-${t}`}
                                  className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] text-sky-900"
                                >
                                  偏 {t}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            active
                              ? "bg-amber-400 text-amber-950"
                              : "bg-zinc-100 text-zinc-500"
                          }`}
                        >
                          {active ? "已选" : "点选"}
                        </span>
                      </div>

                      <div
                        className="mt-3 flex gap-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <BubbleButton
                          className="flex-1 bg-white text-zinc-700 ring-1 ring-zinc-200 hover:bg-zinc-50"
                          onClick={() => openEdit(p)}
                        >
                          <span className="inline-flex items-center gap-1">
                            <Pencil className="h-3.5 w-3.5" />
                            编辑
                          </span>
                        </BubbleButton>
                        <BubbleButton
                          className="flex-1 bg-rose-100 text-rose-800 hover:bg-rose-200"
                          onClick={() => deleteProfile(p.id)}
                        >
                          <span className="inline-flex items-center gap-1">
                            <Trash2 className="h-3.5 w-3.5" />
                            删除
                          </span>
                        </BubbleButton>
                      </div>
                    </motion.div>
                  );
                })}
              </div>

              {selectedIds.size > 0 && (
                <div className="rounded-3xl bg-white/75 p-4 text-sm shadow-md">
                  <p className="font-medium text-amber-950">已选成员汇总</p>
                  <p className="mt-2 text-xs text-zinc-500">忌口（并集）</p>
                  {avoidTags.length === 0 ? (
                    <p className="text-zinc-500">无</p>
                  ) : (
                    <div className="mt-1 flex flex-wrap gap-2">
                      {avoidTags.map((t) => (
                        <span
                          key={t}
                          className="rounded-full bg-rose-100 px-3 py-1 text-xs text-rose-900"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="mt-3 text-xs text-zinc-500">偏好（并集）</p>
                  {preferTags.length === 0 ? (
                    <p className="text-zinc-500">无</p>
                  ) : (
                    <div className="mt-1 flex flex-wrap gap-2">
                      {preferTags.map((t) => (
                        <span
                          key={t}
                          className="rounded-full bg-sky-100 px-3 py-1 text-xs text-sky-900"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <BubbleButton
                disabled={!canNextFromStep1}
                onClick={() => setStep(2)}
                className={`w-full ${
                  canNextFromStep1
                    ? "bg-emerald-400 text-emerald-950 hover:bg-emerald-300"
                    : "cursor-not-allowed bg-zinc-200 text-zinc-500"
                }`}
              >
                下一步：用餐信息
              </BubbleButton>
            </motion.section>
          )}

          {step === 2 && (
            <motion.section
              key="s2"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25 }}
              className="space-y-5"
            >
              <p className="text-sm text-zinc-600">
                用餐场景参与加权评分；用餐人数仅作舒适参考，不会因为人数否决某家店。
              </p>

              <div className="rounded-3xl bg-white/80 p-4 shadow-md">
                <p className="text-sm font-semibold text-amber-950">用餐场景</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {(
                    [
                      "一人食",
                      "情侣约会",
                      "朋友聚餐",
                      "同事聚餐",
                      "家人聚餐",
                    ] as DiningScene[]
                  ).map((s) => (
                    <BubbleButton
                      key={s}
                      onClick={() => setScene(s)}
                      className={
                        scene === s
                          ? "bg-amber-400 text-amber-950"
                          : "bg-white text-zinc-700 ring-1 ring-zinc-200"
                      }
                    >
                      {s}
                    </BubbleButton>
                  ))}
                </div>
              </div>

              <div className="rounded-3xl bg-white/80 p-4 shadow-md">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-amber-950">用餐人数</p>
                  <span className="text-sm text-zinc-600">{partySize} 人</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={20}
                  value={partySize}
                  onChange={(e) => setPartySize(Number(e.target.value))}
                  className="mt-4 w-full accent-amber-500"
                />
              </div>

              <div className="flex gap-2">
                <BubbleButton
                  onClick={() => setStep(1)}
                  className="flex-1 bg-white text-zinc-700 ring-1 ring-zinc-200"
                >
                  上一步
                </BubbleButton>
                <BubbleButton
                  onClick={() => setStep(3)}
                  className="flex-1 bg-emerald-400 text-emerald-950 hover:bg-emerald-300"
                >
                  下一步：距离范围
                </BubbleButton>
              </div>
            </motion.section>
          )}

          {step === 3 && (
            <motion.section
              key="s3"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25 }}
              className="space-y-5"
            >
              <p className="text-sm text-zinc-600">
                设置可接受的最远距离，然后点击「完成」生成智能推荐。怎么去交给地图导航决定。
              </p>

              <div className="rounded-3xl bg-white/80 p-4 shadow-md">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-amber-950">最大距离</p>
                  <span className="text-sm text-zinc-600">{maxDistanceKm} km</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={1}
                  value={maxDistanceKm}
                  onChange={(e) => setMaxDistanceKm(Number(e.target.value))}
                  className="mt-4 w-full accent-amber-500"
                />
                <p className="mt-1 text-xs text-zinc-500">0 km - 10 km，默认 5 km</p>
              </div>

              <div className="rounded-3xl bg-amber-50/90 p-4 text-xs text-amber-900 shadow-md ring-1 ring-amber-200">
                <p className="font-semibold">当前条件摘要</p>
                <ul className="mt-2 list-inside list-disc space-y-1">
                  <li>成员：{selectedIds.size} 人</li>
                  <li>忌口：{avoidTags.length ? avoidTags.join("、") : "无"}</li>
                  <li>偏好：{preferTags.length ? preferTags.join("、") : "无"}</li>
                  <li>
                    场景：{scene}，{partySize} 人（人数不硬过滤）
                  </li>
                  <li>距离 ≤ {maxDistanceKm} km</li>
                  <li>硬性候选：{hardCandidates.length} 家</li>
                </ul>
                {hardFilter.tip && (
                  <p className="mt-3 rounded-2xl bg-white/70 px-3 py-2 text-amber-800">
                    {hardFilter.tip}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-2">
                <BubbleButton
                  onClick={() => setStep(2)}
                  className="w-full bg-white text-zinc-700 ring-1 ring-zinc-200"
                >
                  上一步
                </BubbleButton>
                <BubbleButton
                  onClick={onFinishStep3}
                  className="w-full bg-emerald-500 text-white hover:bg-emerald-400"
                >
                  完成并生成推荐
                </BubbleButton>
              </div>
            </motion.section>
          )}
        </AnimatePresence>
      </main>

      {/* 添加 / 编辑成员 */}
      <AnimatePresence>
        {showAddModal && (
          <motion.div
            className="fixed inset-0 z-40 flex items-end justify-center bg-black/30 sm:items-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={closeModal}
          >
            <motion.div
              initial={{ y: 40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 20, opacity: 0 }}
              transition={{ type: "spring", stiffness: 260, damping: 22 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-lg rounded-t-3xl bg-[#FFFDF6] p-5 shadow-2xl sm:rounded-3xl"
            >
              <div className="mb-3 flex items-center justify-between">
                <p className="text-base font-bold text-amber-950">
                  {editing ? "编辑成员" : "添加新成员"}
                </p>
                <button
                  type="button"
                  aria-label="关闭"
                  onClick={closeModal}
                  className="rounded-full p-2 text-zinc-500 hover:bg-zinc-100"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <label className="block text-sm font-medium text-zinc-700">昵称</label>
              <input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                className="mt-1 w-full rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none ring-amber-200 focus:ring-2"
                placeholder="例如：小圆"
              />

              <label className="mt-3 block text-sm font-medium text-zinc-700">
                健康 / 饮食状况
              </label>
              <textarea
                value={formStatus}
                onChange={(e) => setFormStatus(e.target.value)}
                rows={3}
                className="mt-1 w-full resize-none rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none ring-amber-200 focus:ring-2"
                placeholder="例：不吃海鲜；想吃火锅；增肌"
              />

              <div className="mt-4 flex gap-2">
                <BubbleButton
                  onClick={closeModal}
                  className="flex-1 bg-white text-zinc-700 ring-1 ring-zinc-200"
                >
                  取消
                </BubbleButton>
                <BubbleButton
                  onClick={submitProfile}
                  className="flex-1 bg-amber-400 text-amber-950 hover:bg-amber-300"
                >
                  保存
                </BubbleButton>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 全屏结果：加载 → 推荐卡片 */}
      <AnimatePresence>
        {resultOpen && (
          <motion.div
            className="fixed inset-0 z-50 flex flex-col bg-[#F5F5DC]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="flex items-center justify-between px-4 py-3">
              <p className="text-sm font-semibold text-amber-950">推荐结果</p>
              <button
                type="button"
                className="rounded-full p-2 text-zinc-500 hover:bg-white/70"
                aria-label="关闭结果"
                onClick={closeResult}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="flex min-h-full flex-col items-center justify-center px-5 py-6 pb-10">
              {resultPhase === "loading" && (
                <motion.div
                  key="loading"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="flex flex-col items-center text-center"
                >
                  <motion.div
                    animate={{ y: [0, -14, 0] }}
                    transition={{
                      repeat: Infinity,
                      duration: 0.75,
                      ease: "easeInOut",
                    }}
                    className="flex h-20 w-20 items-center justify-center rounded-full bg-white text-amber-700 shadow-xl ring-4 ring-amber-200"
                  >
                    <Utensils className="h-10 w-10" />
                  </motion.div>
                  <p className="mt-6 max-w-sm text-base font-medium text-amber-950">
                    正在为你挑选最匹配的餐厅...
                  </p>
                  <p className="mt-2 max-w-sm text-sm text-zinc-600">
                    先看忌口与距离，再按本次明确偏好进池，并结合场景与成员历史辅助排序
                  </p>
                </motion.div>
              )}

              {resultPhase === "ready" && !picked && (
                <div className="max-w-md rounded-3xl bg-white/90 p-8 text-center shadow-xl">
                  <p className="text-lg font-bold text-amber-950">暂时没有候选</p>
                  <p className="mt-2 text-sm text-zinc-600">
                    {filterTip ??
                      "当前距离、人数或忌口条件下没有可用餐厅，请返回上一步放宽条件。"}
                  </p>
                  {lastUsageLog && (
                    <p className="mt-3 text-left text-xs text-zinc-500">
                      硬过滤 {lastUsageLog.hardFilterCandidateCount} · 偏好命中{" "}
                      {lastUsageLog.preferenceMatchedCandidateCount} · 偏好池{" "}
                      {lastUsageLog.usedPreferencePool ? "是" : "否"} ·
                      历史排除{" "}
                      {lastUsageLog.historyExcludedRestaurantIds.length}
                    </p>
                  )}
                  <BubbleButton
                    onClick={closeResult}
                    className="mt-6 w-full bg-amber-400 text-amber-950"
                  >
                    知道了
                  </BubbleButton>
                </div>
              )}

              {resultPhase === "ready" && picked && (
                <motion.div
                  key="card"
                  initial={{ opacity: 0, y: 16, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ type: "spring", stiffness: 220, damping: 20 }}
                  className="w-full max-w-md"
                >
                  <div className="rounded-[2rem] bg-white p-8 shadow-2xl ring-1 ring-amber-100">
                    <p className="text-center text-xs font-medium uppercase tracking-widest text-amber-700/80">
                      今日推荐
                    </p>
                    <h2 className="mt-3 text-center text-4xl font-extrabold leading-tight text-amber-950 sm:text-5xl">
                      {picked.name}
                    </h2>

                    <div className="mt-5 flex items-center justify-center gap-1">
                      {Array.from({ length: 5 }).map((_, i) => {
                        const filled = i < Math.round(picked.rating);
                        return (
                          <Star
                            key={i}
                            className={`h-8 w-8 ${
                              filled
                                ? "fill-amber-400 text-amber-400"
                                : "text-amber-200"
                            }`}
                          />
                        );
                      })}
                      <span className="ml-2 text-lg font-semibold text-amber-950">
                        {picked.rating.toFixed(1)}
                      </span>
                    </div>

                    <p className="mt-2 text-center text-xs text-zinc-500">
                      {picked.distance.toFixed(1)} km · 舒适约 {picked.minPeople}–
                      {picked.maxPeople} 人 · {picked.scenes.join(" / ")}
                    </p>

                    {filterTip && (
                      <p className="mt-3 rounded-2xl bg-amber-50 px-3 py-2 text-center text-xs text-amber-900 ring-1 ring-amber-200">
                        {filterTip}
                      </p>
                    )}

                    {breakdown && (
                      <p className="mt-3 text-center text-xs text-zinc-500">
                        得分：场景 {breakdown.scene} + 历史{" "}
                        {breakdown.history.toFixed(1)} + 星级{" "}
                        {breakdown.base.toFixed(1)} ={" "}
                        <span className="font-semibold text-amber-900">
                          {breakdown.total.toFixed(1)}
                        </span>
                        {breakdown.fromPreferPool ? " · 已优先偏好池" : ""}
                      </p>
                    )}

                    <div className="mt-6 rounded-3xl bg-amber-50/90 p-4 text-left text-sm leading-relaxed text-amber-950 ring-1 ring-amber-200">
                      <p className="font-semibold">推荐理由</p>
                      <ul className="mt-2 list-inside list-disc space-y-1 text-zinc-700">
                        {reasonLines.map((line, idx) => (
                          <li key={idx}>{line}</li>
                        ))}
                      </ul>
                    </div>

                    <div className="mt-8">
                      <p className="text-center text-sm font-medium text-zinc-700">
                        给这家店打个分（1-5 星）
                      </p>
                      <p className="mt-1 text-center text-xs text-zinc-500">
                        将记入本次所有已选用餐人的档案（共同用餐经历）
                      </p>
                      <div className="mt-3 flex justify-center gap-2">
                        {[1, 2, 3, 4, 5].map((n) => {
                          const active = memoryRating === n;
                          return (
                            <motion.button
                              key={n}
                              type="button"
                              whileTap={{ scale: 0.9 }}
                              onClick={() => {
                                setMemoryRating(n);
                                setMemorySaved(false);
                              }}
                              className={`rounded-full p-2 ${
                                active ? "bg-amber-200" : "bg-white"
                              } ring-1 ring-amber-200`}
                              aria-label={`${n} 星`}
                            >
                              <Star
                                className={`h-7 w-7 ${
                                  n <= memoryRating
                                    ? "fill-amber-400 text-amber-400"
                                    : "text-amber-200"
                                }`}
                              />
                            </motion.button>
                          );
                        })}
                      </div>
                      <BubbleButton
                        disabled={memoryRating < 1 || memorySaved}
                        onClick={onSaveMemory}
                        className={`mt-4 w-full ${
                          memoryRating >= 1 && !memorySaved
                            ? "bg-emerald-500 text-white hover:bg-emerald-400"
                            : "cursor-not-allowed bg-zinc-200 text-zinc-500"
                        }`}
                      >
                        {memorySaved ? "已存入记忆" : "存入记忆"}
                      </BubbleButton>
                    </div>

                    <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                      <BubbleButton
                        onClick={onPickAgain}
                        disabled={candidates.length <= 1}
                        className={`flex-1 ${
                          candidates.length <= 1
                            ? "cursor-not-allowed bg-zinc-200 text-zinc-500"
                            : "bg-white text-amber-950 ring-1 ring-amber-300"
                        }`}
                      >
                        <span className="inline-flex items-center justify-center gap-2">
                          <RotateCcw className="h-4 w-4" />
                          再抽一次
                        </span>
                      </BubbleButton>
                      <BubbleButton
                        onClick={() => {
                          window.open(mapsUrlForRestaurant(picked.name), "_blank");
                        }}
                        className="flex-1 bg-amber-500 text-white hover:bg-amber-400"
                      >
                        <span className="inline-flex items-center justify-center gap-2">
                          <MapPin className="h-4 w-4" />
                          立即出发
                        </span>
                      </BubbleButton>
                    </div>

                    <p className="mt-4 text-center text-[11px] text-zinc-500">
                      「立即出发」使用 Apple 地图网页搜索店名；你也可以复制店名到常用地图 App。
                    </p>

                    {lastUsageLog && (
                      <div className="mt-6 border-t border-amber-100 pt-4 text-left">
                        <button
                          type="button"
                          onClick={() => setDebugOpen((v) => !v)}
                          className="w-full text-left text-xs font-semibold text-zinc-600 hover:text-amber-900"
                        >
                          {debugOpen ? "▼" : "▶"} 查看推荐计算详情
                        </button>
                        {debugOpen && (
                          <div className="mt-3 max-h-72 space-y-3 overflow-y-auto rounded-2xl bg-zinc-50 p-3 text-xs text-zinc-700">
                            <p>
                              时间：{lastUsageLog.createdAt}
                              <br />
                              触发：
                              {lastUsageLog.trigger === "reroll"
                                ? "再抽一次"
                                : "完成推荐"}
                              <br />
                              用餐成员：
                              {lastUsageLog.selectedProfileNames.join("、") ||
                                "—"}
                              <br />
                              人数：{lastUsageLog.partySize} · 场景：
                              {lastUsageLog.diningScene}
                              <br />
                              原始输入：
                              {lastUsageLog.rawStatus.join(" | ") || "—"}
                              <br />
                              忌口：{lastUsageLog.avoidTags.join("、") || "无"}
                              <br />
                              偏好：{lastUsageLog.preferTags.join("、") || "无"}
                              <br />
                              最大距离：{lastUsageLog.maxDistanceKm} km
                            </p>
                            <p>
                              硬过滤后：{lastUsageLog.hardFilterCandidateCount}{" "}
                              家
                              <br />
                              偏好命中：
                              {lastUsageLog.preferenceMatchedCandidateCount} 家
                              <br />
                              是否使用偏好池：
                              {lastUsageLog.usedPreferencePool ? "是" : "否"}
                              <br />
                              是否放宽距离：
                              {lastUsageLog.distanceRelaxed ? "是" : "否"}
                              <br />
                              排序池：
                              {lastUsageLog.candidateRestaurantIds.length} 家
                              <br />
                              并列同分：
                              {lastUsageLog.tiedRestaurantIds.length} 家
                            </p>
                            <div className="space-y-2">
                              <p className="font-semibold text-zinc-800">
                                推荐排序
                              </p>
                              {lastUsageLog.recommendationDetails.map(
                                (d, idx) => (
                                  <div
                                    key={d.restaurantId}
                                    className={`rounded-xl p-2 ${
                                      lastUsageLog.recommendedRestaurantIds.includes(
                                        d.restaurantId
                                      )
                                        ? "bg-amber-100 ring-1 ring-amber-300"
                                        : "bg-white"
                                    }`}
                                  >
                                    <p className="font-medium">
                                      {idx + 1}. {d.restaurantName}
                                      {lastUsageLog.tiedRestaurantIds.includes(
                                        d.restaurantId
                                      )
                                        ? "（并列）"
                                        : ""}
                                    </p>
                                    <p>
                                      基础 {d.baseScore.toFixed(1)} · 场景{" "}
                                      {d.sceneScore} · 历史{" "}
                                      {d.historyScore.toFixed(1)} · 总分{" "}
                                      {d.totalScore.toFixed(1)}
                                    </p>
                                    <p>
                                      偏好命中：
                                      {d.matchedPreferences.join("、") || "无"}
                                      {" · "}
                                      场景命中：
                                      {d.matchedScenes.join("、") || "无"}
                                    </p>
                                    <p>
                                      历史评分：
                                      {d.historicalRatings.length
                                        ? d.historicalRatings.join(", ")
                                        : "无"}
                                      {d.averageHistoricalRating != null
                                        ? `（均 ${d.averageHistoricalRating.toFixed(1)}）`
                                        : ""}
                                    </p>
                                  </div>
                                )
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 测试记录面板 */}
      <AnimatePresence>
        {testPanelOpen && (
          <motion.div
            className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 sm:items-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setTestPanelOpen(false)}
          >
            <motion.div
              initial={{ y: 40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 20, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-t-3xl bg-[#FFFDF6] shadow-2xl sm:rounded-3xl"
            >
              <div className="flex items-center justify-between border-b border-amber-100 px-4 py-3">
                <p className="text-sm font-bold text-amber-950">
                  测试记录 / Debug
                </p>
                <button
                  type="button"
                  aria-label="关闭"
                  onClick={() => setTestPanelOpen(false)}
                  className="rounded-full p-2 text-zinc-500 hover:bg-zinc-100"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4 text-sm">
                <section className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-amber-950">
                      Usage Logs（{usageLogs.length}）
                    </p>
                    <button
                      type="button"
                      onClick={() => exportUsageLogsToCSV(usageLogs)}
                      className="rounded-full bg-emerald-500 px-3 py-1 text-xs text-white"
                    >
                      导出 CSV
                    </button>
                    <button
                      type="button"
                      onClick={toggleAllLogs}
                      className="rounded-full bg-white px-3 py-1 text-xs ring-1 ring-zinc-200"
                    >
                      {selectedLogIds.size === usageLogs.length &&
                      usageLogs.length > 0
                        ? "取消全选"
                        : "全选"}
                    </button>
                    <button
                      type="button"
                      disabled={selectedLogIds.size === 0}
                      onClick={deleteSelectedLogs}
                      className={`rounded-full px-3 py-1 text-xs ${
                        selectedLogIds.size === 0
                          ? "bg-zinc-200 text-zinc-500"
                          : "bg-rose-500 text-white"
                      }`}
                    >
                      批量删除
                    </button>
                  </div>
                  <p className="text-xs text-zinc-500">
                    key: today_eat_usage_logs · 删除日志不影响推荐与餐厅记忆
                  </p>
                  {usageLogs.length === 0 ? (
                    <p className="rounded-2xl bg-white/80 p-4 text-xs text-zinc-500">
                      暂无测试记录。完成一次推荐后会自动写入。
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {[...usageLogs].reverse().map((log) => (
                        <li
                          key={log.id}
                          className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-amber-100"
                        >
                          <div className="flex items-start gap-2">
                            <input
                              type="checkbox"
                              className="mt-1"
                              checked={selectedLogIds.has(log.id)}
                              onChange={() => toggleLogSelect(log.id)}
                            />
                            <div className="min-w-0 flex-1 text-xs">
                              <p className="font-medium text-zinc-800">
                                {log.createdAt} ·{" "}
                                {log.trigger === "reroll"
                                  ? "再抽一次"
                                  : "完成推荐"}
                              </p>
                              <p className="text-zinc-600">
                                {log.selectedProfileNames.join("、")} ·{" "}
                                {log.diningScene} · {log.partySize}人 · 推荐：
                                {log.recommendedRestaurantNames.join("、") ||
                                  "无"}
                              </p>
                              <p className="text-zinc-500">
                                偏好池：
                                {log.usedPreferencePool ? "是" : "否"} ·
                                放宽距离：
                                {log.distanceRelaxed ? "是" : "否"} · 硬过滤
                                {log.hardFilterCandidateCount}/偏好命中
                                {log.preferenceMatchedCandidateCount}/排序池
                                {log.candidateRestaurantIds.length}
                              </p>
                            </div>
                            <button
                              type="button"
                              aria-label="删除该日志"
                              onClick={() => deleteOneLog(log.id)}
                              className="rounded-full p-1.5 text-rose-600 hover:bg-rose-50"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="space-y-2 border-t border-amber-100 pt-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-amber-950">
                      餐厅历史记忆（{memories.length}）
                    </p>
                    <button
                      type="button"
                      onClick={toggleAllMemories}
                      className="rounded-full bg-white px-3 py-1 text-xs ring-1 ring-zinc-200"
                    >
                      {selectedMemoryKeys.size === memories.length &&
                      memories.length > 0
                        ? "取消全选"
                        : "全选"}
                    </button>
                    <button
                      type="button"
                      disabled={selectedMemoryKeys.size === 0}
                      onClick={deleteSelectedMemories}
                      className={`rounded-full px-3 py-1 text-xs ${
                        selectedMemoryKeys.size === 0
                          ? "bg-zinc-200 text-zinc-500"
                          : "bg-rose-500 text-white"
                      }`}
                    >
                      批量删除
                    </button>
                  </div>
                  <p className="text-xs text-zinc-500">
                    key: restaurant_memory_v2 · 删除后该评分不再参与推荐
                  </p>
                  {memories.length === 0 ? (
                    <p className="rounded-2xl bg-white/80 p-4 text-xs text-zinc-500">
                      暂无餐厅历史评分。
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {[...memories]
                        .sort((a, b) => b.savedAt - a.savedAt)
                        .map((m) => {
                          const key = memoryEntryKey(m);
                          return (
                            <li
                              key={key}
                              className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-amber-100"
                            >
                              <div className="flex items-start gap-2">
                                <input
                                  type="checkbox"
                                  className="mt-1"
                                  checked={selectedMemoryKeys.has(key)}
                                  onChange={() => toggleMemorySelect(key)}
                                />
                                <div className="min-w-0 flex-1 text-xs">
                                  <p className="font-medium text-zinc-800">
                                    {m.restaurantName} · {m.rating} 星
                                  </p>
                                  <p className="text-zinc-600">
                                    档案：
                                    {profileNameById.get(m.profileId) ??
                                      m.profileId}
                                    <br />
                                    {new Date(m.savedAt).toISOString()}
                                  </p>
                                </div>
                                <button
                                  type="button"
                                  aria-label="删除该记忆"
                                  onClick={() => deleteOneMemory(key)}
                                  className="rounded-full p-1.5 text-rose-600 hover:bg-rose-50"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </div>
                            </li>
                          );
                        })}
                    </ul>
                  )}
                </section>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}