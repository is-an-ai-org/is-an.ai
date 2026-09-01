import { promises as fs } from "fs";
import path from "path";
import https from "https";

// --- Environment Variables ---

const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";
const WORKER_API_URL = process.env.WORKER_API_URL || "https://api.is-an.ai";
const WORKSPACE_PATH = process.env.GITHUB_WORKSPACE || process.cwd();

// 파일 목록은 개행 구분이다. 공백으로 자르면 유니코드 공백이 든
// 파일명(records/"y\u2006t\u2006k.json")이 쪼개진다.
const ADDED_FILES = (process.env.ADDED_FILES || "").split(/\r?\n/).filter(Boolean);
const MODIFIED_FILES = (process.env.MODIFIED_FILES || "").split(/\r?\n/).filter(Boolean);
const DELETED_FILES = (process.env.DELETED_FILES || "").split(/\r?\n/).filter(Boolean);

// --- Types ---

interface RecordFile {
  description?: string;
  owner: {
    github_username?: string;
    email: string;
  };
  record: Array<{
    type: string;
    value: string | { priority: number; exchange: string };
  }>;
}

interface SyncRecord {
  name: string;
  content?: RecordFile;
}

// --- Helpers ---

function getSubdomainFromPath(filePath: string): string {
  return path.basename(filePath, ".json");
}

async function loadRecordFile(filePath: string): Promise<RecordFile | null> {
  try {
    const fullPath = path.join(WORKSPACE_PATH, filePath);
    const data = await fs.readFile(fullPath, "utf-8");
    return JSON.parse(data) as RecordFile;
  } catch {
    return null;
  }
}

// --- Main ---

async function syncDB(): Promise<void> {
  console.log("=== Syncing records to D1 database ===");

  if (!ADMIN_API_KEY) {
    console.log("ADMIN_API_KEY not set, skipping DB sync");
    return;
  }

  const added: SyncRecord[] = [];
  const modified: SyncRecord[] = [];
  const deleted: SyncRecord[] = [];

  for (const file of ADDED_FILES) {
    if (file === "records/schema.json") continue;
    const content = await loadRecordFile(file);
    if (content) {
      added.push({ name: getSubdomainFromPath(file), content });
    }
  }

  for (const file of MODIFIED_FILES) {
    if (file === "records/schema.json") continue;
    const content = await loadRecordFile(file);
    if (content) {
      modified.push({ name: getSubdomainFromPath(file), content });
    }
  }

  for (const file of DELETED_FILES) {
    if (file === "records/schema.json") continue;
    deleted.push({ name: getSubdomainFromPath(file) });
  }

  const total = added.length + modified.length + deleted.length;
  if (total === 0) {
    console.log("No records to sync");
    return;
  }

  console.log(`Syncing: ${added.length} added, ${modified.length} modified, ${deleted.length} deleted`);

  const body = JSON.stringify({ added, modified, deleted });

  const url = new URL("/admin/sync-records", WORKER_API_URL);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Key": ADMIN_API_KEY,
      "User-Agent": "is-an-ai-deploy",
    },
    body,
  });

  if (!res.ok) {
    const error = await res.text();
    // 4xx = 요청 자체가 잘못됨(재시도해도 그대로). 여기서 종료 코드를 1로 만들면
    // 배포 마커가 영영 전진하지 못해 DNS 배포 전체가 멈춘다. 크게 알리기만 한다.
    // 5xx / 네트워크 = 일시적. 실패로 처리해 다음 런이 같은 범위를 다시 시도하게 한다.
    const retryable = res.status >= 500;
    console.log(
      `::error::D1 동기화 실패 (${res.status}). PowerDNS 반영은 완료됐지만 대시보드 DB가 어긋났습니다. ${error}`
    );
    if (retryable) {
      throw new Error(`DB sync failed with retryable status ${res.status}`);
    }
    return;
  }

  const result = await res.json() as {
    added: number;
    modified: number;
    deleted: number;
    errors: string[];
  };

  console.log(`✓ DB sync complete: ${result.added} added, ${result.modified} modified, ${result.deleted} deleted`);
  if (result.errors.length > 0) {
    // 이전에는 console.warn 이라 로그에 묻혔다. 레코드 단위 실패는 곧 DNS<->D1 드리프트다.
    console.log(`::warning::D1 동기화 중 ${result.errors.length}건의 레코드 오류가 있었습니다`);
    for (const err of result.errors) {
      console.log(`::warning::  - ${err}`);
    }
  }
}

syncDB().catch((err) => {
  // 네트워크 오류 등 일시적 실패. 실패로 끝내면 배포 마커가 전진하지 않으므로
  // 다음 런이 같은 범위를 그대로 다시 배포한다(PATCH/upsert 모두 멱등).
  console.log(`::error::D1 동기화 오류: ${err?.message || err}`);
  process.exit(1);
});
