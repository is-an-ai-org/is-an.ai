import { promises as fs } from "fs";
import path from "path";
import axios, { AxiosInstance } from "axios";
import punycode from "punycode";

// --- PowerDNS API 5.0 Interfaces ---

interface PdnsApiGetRecord {
  content: string;
  disabled: boolean;
}

interface PdnsApiGetRRSet {
  name: string; // FQDN
  type: string;
  ttl: number;
  records: PdnsApiGetRecord[];
}

interface PdnsApiPatchRecord {
  content: string;
  disabled: boolean;
}

interface PdnsApiPatchRRSet {
  name: string;
  type: string;
  ttl: number;
  changetype: "REPLACE" | "DELETE";
  records: PdnsApiPatchRecord[];
}

// --- Repository Record Interfaces ---

interface MxRecordValue {
  priority: number;
  exchange: string;
}

interface RecordDefinition {
  type: string;
  value: string | MxRecordValue;
}

interface RecordFileContent {
  description?: string;
  owner: {
    github_username?: string;
    email: string;
  };
  record: RecordDefinition[];
}

interface RecordSignature {
  subdomain: string;
  type: string;
  content: string;
  priority?: number;
}

// --- Environment Variables ---
function getEnvVariable(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Error: ${name} environment variable not set.`);
    process.exit(1);
  }
  return value;
}

// 워크플로우는 파일 목록을 개행으로 구분해 넘긴다.
// 공백으로 자르면 안 된다 - records/"y\u2006t\u2006k.json" 처럼
// 유니코드 공백이 든 파일명이 실제로 존재하고, /\s+/ 는 그것까지 쪼갠다.
function getEnvList(name: string): string[] {
  return (process.env[name] || "")
    .split(/\r?\n/)
    .filter((f) => f.length > 0);
}

const PDNS_API_KEY: string = getEnvVariable("PDNS_API_KEY");
const PDNS_API_URL: string = getEnvVariable("PDNS_API_URL");
const PDNS_ZONE: string = getEnvVariable("PDNS_ZONE"); // e.g., "is-an.ai"

// PDNS_ZONE 시크릿은 끝점(trailing dot)이 있을 수도 없을 수도 있다.
// 이름 비교/변환은 전부 아래 두 정규형만 쓴다.
// (API URL의 zone id에는 PDNS_ZONE 원본을 그대로 유지한다 - 서버가 그 형식으로 받고 있다)
const ZONE = PDNS_ZONE.replace(/\.$/, "").toLowerCase(); // "is-an.ai"
const ZONE_FQDN = `${ZONE}.`; // "is-an.ai."
const WORKSPACE_PATH: string = getEnvVariable("GITHUB_WORKSPACE");

const ADDED_FILES: string[] = getEnvList("ADDED_FILES");
const MODIFIED_FILES: string[] = getEnvList("MODIFIED_FILES");
const DELETED_FILES: string[] = getEnvList("DELETED_FILES");

const DEFAULT_TTL = 300; // Default TTL
const SOA_MIN_TTL = 300; // Negative Cache TTL (5 minutes)

// --- PowerDNS API Client ---
const pdnsClient: AxiosInstance = axios.create({
  baseURL: PDNS_API_URL,
  headers: {
    "X-API-Key": PDNS_API_KEY,
    "Content-Type": "application/json",
  },
  timeout: 30000,
});

// --- Helper Functions (Robust Version) ---

/**
 * Extract subdomain from file path (with punycode conversion)
 */
function getSubdomainFromPath(filePath: string): string {
  const filename = path.basename(filePath, ".json");
  const baseDomainPattern = `.${ZONE}`;

  let subdomain = filename;
  if (filename.endsWith(baseDomainPattern)) {
    subdomain = filename.slice(0, -baseDomainPattern.length);
  } else if (filename === ZONE) {
    subdomain = "@";
  }

  return punycode.toASCII(subdomain).toLowerCase();
}

function isMxRecordValue(value: any): value is MxRecordValue {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.priority === "number" &&
    typeof value.exchange === "string"
  );
}

/**
 * Convert subdomain to FQDN (append trailing dot, remove duplicate dots)
 */
function subdomainToFqdn(subdomain: string): string {
  // Strip leading and trailing dots
  while (subdomain.startsWith(".")) subdomain = subdomain.slice(1);
  while (subdomain.endsWith(".")) subdomain = subdomain.slice(0, -1);

  if (!subdomain || subdomain === "@" || subdomain.trim() === "") {
    return ZONE_FQDN;
  }
  return `${subdomain}.${ZONE_FQDN}`.toLowerCase();
}

/**
 * Normalize record value (append dots, handle quotes, strip leading zeros from IPs, etc.)
 */
function normalizeContent(type: string, content: string): string {
  const upperType = type.toUpperCase();
  const typesNeedingDot = ["CNAME", "MX", "NS", "SRV", "PTR"];

  if (typesNeedingDot.includes(upperType)) {
    if (!content.endsWith(".")) return content + ".";
  }

  if (upperType === "TXT") {
    let clean = content;
    if (clean.includes(" IN TXT ")) {
      clean = clean.split(" IN TXT ")[1].trim();
    }
    if (clean.startsWith('"') && clean.endsWith('"')) {
      clean = clean.slice(1, -1);
    }
    return `"${clean}"`;
  }

  if (upperType === "A") {
    if (content.includes(".") && content.split(".").length === 4) {
      const parts = content.split(".");
      if (parts.every((p) => /^\d+$/.test(p))) {
        return parts.map((o) => parseInt(o, 10)).join(".");
      }
    }
  }

  return content;
}

// --- PowerDNS Data Fetching ---

/**
 * 존 스냅샷.
 *
 * 이전 구현은 변경된 파일 하나마다 존 전체(~3800 RRSet, 약 1MB)를 다시 받아
 * 클라이언트에서 필터링했다. 파일 N개면 N+1회 전체 다운로드라 배치 머지가
 * 커질수록 5분 타임아웃에 그대로 걸렸다. 이제 존을 딱 한 번만 받아 인덱싱한다.
 */
interface ZoneSnapshot {
  /** 소문자 FQDN(끝점 포함) -> RRSet 목록. SOA/NS는 제외된다. */
  byName: Map<string, PdnsApiGetRRSet[]>;
  soaSerial: number;
}

let zoneSnapshotPromise: Promise<ZoneSnapshot> | null = null;

async function fetchZoneSnapshot(): Promise<ZoneSnapshot> {
  const response = await pdnsClient.get(
    `/api/v1/servers/localhost/zones/${PDNS_ZONE}`
  );
  const allRRSets: PdnsApiGetRRSet[] = response.data.rrsets || [];

  const byName = new Map<string, PdnsApiGetRRSet[]>();
  let soaSerial = 0;

  for (const rr of allRRSets) {
    if (rr.type === "SOA") {
      const content = rr.records?.[0]?.content;
      if (content) {
        // SOA format: ns1.xxx email.xxx SERIAL refresh retry expire min_ttl
        const parts = content.split(/\s+/);
        if (parts.length >= 3) {
          const parsed = parseInt(parts[2], 10);
          if (Number.isFinite(parsed)) soaSerial = parsed;
        }
      }
      continue;
    }
    if (rr.type === "NS") continue;

    const key = rr.name.toLowerCase();
    const bucket = byName.get(key);
    if (bucket) bucket.push(rr);
    else byName.set(key, [rr]);
  }

  console.log(
    `Zone snapshot loaded: ${allRRSets.length} RRSets, current SOA serial ${soaSerial}`
  );
  return { byName, soaSerial };
}

/** 한 번만 받아서 재사용한다(요청 중복 제거). */
function loadZoneSnapshot(): Promise<ZoneSnapshot> {
  if (!zoneSnapshotPromise) zoneSnapshotPromise = fetchZoneSnapshot();
  return zoneSnapshotPromise;
}

/**
 * 특정 서브도메인의 현재 RRSet 조회.
 *
 * 실패를 조용히 빈 배열로 넘기지 않는다. 예전에는 존 조회 실패가
 * "이 서브도메인에 레코드가 없음"과 구분되지 않아, 스테일 타입 정리가
 * 조용히 스킵되고 CNAME->ALIAS 분기가 잘못된 길로 갔다.
 */
async function getSubdomainRRSets(
  subdomain: string
): Promise<PdnsApiGetRRSet[]> {
  const { byName } = await loadZoneSnapshot();
  return byName.get(subdomainToFqdn(subdomain)) || [];
}

/** 현재 SOA serial. 확정할 수 없으면 0을 반환하지 않고 중단한다. */
async function getCurrentSoaSerial(): Promise<number> {
  const { soaSerial } = await loadZoneSnapshot();
  if (!soaSerial) {
    // 0을 반환하면 새 serial이 YYYYMMDD01로 계산돼 현재 값보다 낮아질 수 있고,
    // 그러면 세컨더리(HE 등)가 존 갱신을 무시한다. 낮추느니 실패하는 편이 낫다.
    throw new Error(
      "현재 SOA serial을 읽지 못했습니다. serial 역행을 막기 위해 중단합니다."
    );
  }
  return soaSerial;
}

// --- File Loading ---

async function loadRecordFile(filePath: string): Promise<RecordSignature[]> {
  try {
    const fileContent = await fs.readFile(filePath, "utf-8");
    const data: any = JSON.parse(fileContent);

    if (
      !data ||
      typeof data !== "object" ||
      !("record" in data) ||
      !Array.isArray(data.record)
    ) {
      console.warn(`Skipping invalid structure: ${filePath}`);
      return [];
    }

    const subdomain = getSubdomainFromPath(filePath);

    // Subdomain is already lowercased by getSubdomainFromPath

    const signatures: RecordSignature[] = [];
    const ipv4Regex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;

    for (const def of data.record) {
      const type = def.type.toUpperCase();

      // Validate A record
      if (type === "A" && typeof def.value === "string") {
        if (!ipv4Regex.test(def.value)) {
          console.warn(`⚠️ Invalid IP in ${filePath}: ${def.value}`);
          continue;
        }
      }

      if (type === "MX" && isMxRecordValue(def.value)) {
        signatures.push({
          subdomain,
          type,
          content: def.value.exchange,
          priority: def.value.priority,
        });
      } else if (typeof def.value === "string") {
        signatures.push({
          subdomain,
          type,
          content: def.value,
        });
      }
    }
    return signatures;
  } catch (error) {
    console.error(`Error loading file ${filePath}: ${error}`);
    return [];
  }
}

// --- Main Logic ---

async function processChanges(): Promise<void> {
  console.log("=== Starting Incremental DNS Update Process ===");
  console.log(
    `Added: ${ADDED_FILES.length}, Modified: ${MODIFIED_FILES.length}, Deleted: ${DELETED_FILES.length}`
  );

  const patchPayload: PdnsApiPatchRRSet[] = [];
  const processedSubdomains = new Set<string>();

  // 1. Handle DELETEs
  for (const file of DELETED_FILES) {
    const subdomain = getSubdomainFromPath(file);
    if (processedSubdomains.has(subdomain)) continue;

    console.log(`Processing Deletion for: ${subdomain}`);
    // Fetch existing records and create delete requests
    const existingRRSets = await getSubdomainRRSets(subdomain);
    for (const rrset of existingRRSets) {
      patchPayload.push({
        name: rrset.name,
        type: rrset.type,
        ttl: DEFAULT_TTL,
        changetype: "DELETE",
        records: [],
      });
    }
    processedSubdomains.add(subdomain);
  }

  // 2. Handle ADDs / MODIFYs
  const filesToProcess = [...new Set([...ADDED_FILES, ...MODIFIED_FILES])];

  // Query target subdomains on demand rather than fetching everything
  // (full fetch is inefficient for incremental updates)

  for (const file of filesToProcess) {
    const filePath = path.join(WORKSPACE_PATH, file);
    const subdomain = getSubdomainFromPath(file);

    if (processedSubdomains.has(subdomain)) continue;

    const newRecords = await loadRecordFile(filePath);
    if (newRecords.length === 0) continue;

    const fqdn = subdomainToFqdn(subdomain);
    console.log(`Processing Update for: ${fqdn}`);

    // Fetch existing records from PowerDNS (for conflict prevention and ALIAS detection)
    const existingRRSets = await getSubdomainRRSets(subdomain);
    const existingTypes = new Set(existingRRSets.map((r) => r.type));

    // Group records by type
    const recordsByType = new Map<string, RecordSignature[]>();
    for (const r of newRecords) {
      if (!recordsByType.has(r.type)) recordsByType.set(r.type, []);
      recordsByType.get(r.type)!.push(r);
    }

    // Process each type
    for (const [type, records] of recordsByType.entries()) {
      let finalType = type;
      let finalRecords = records;

      // 2-1. CNAME logic
      if (type === "CNAME") {
        // (A) Deduplicate CNAMEs
        if (records.length > 1) {
          console.warn(`⚠️ Multiple CNAMEs for ${fqdn}. Using first.`);
          finalRecords = [records[0]];
        }

        const hasIPInFile = recordsByType.has("A") || recordsByType.has("AAAA");

        // (B) If A records exist in the same file, ignore CNAME (A takes priority)
        if (hasIPInFile) {
          console.warn(`⚠️ Conflict: CNAME & IP in ${file}. Ignoring CNAME.`);
          continue;
        }

        // (C) CNAME -> ALIAS conversion conditions
        // 1. Root domain
        if (subdomain === "@") {
          console.log(`✨ Root CNAME -> ALIAS for ${fqdn}`);
          finalType = "ALIAS";
        }
        // 2. Mixed with other types (TXT, MX, etc.) - check existing PDNS state
        else if (existingTypes.size > 0 && !existingTypes.has("CNAME")) {
          // Other records (A, TXT, etc.) already exist but we're adding a CNAME -> convert to ALIAS for coexistence
          console.log(`✨ CNAME -> ALIAS (Mixed types) for ${fqdn}`);
          finalType = "ALIAS";
        }

        // Stale type cleanup is handled after the type loop below
      }

      patchPayload.push({
        name: fqdn,
        type: finalType,
        ttl: DEFAULT_TTL,
        changetype: "REPLACE",
        records: finalRecords.map((r) => {
          let content = normalizeContent(r.type, r.content);
          if (r.type === "MX" && r.priority !== undefined) {
            content = `${r.priority} ${content}`;
          }
          return { content, disabled: false };
        }),
      });
    }

    // Delete existing record types that are no longer in the record file
    // This ensures the subdomain is fully synced (e.g., old CNAME removed when switching to A)
    const newTypes = new Set(
      Array.from(recordsByType.keys()).map((t) => {
        // Account for CNAME -> ALIAS conversion
        if (t === "CNAME") {
          const hasIP = recordsByType.has("A") || recordsByType.has("AAAA");
          if (hasIP) return null; // CNAME was ignored
          if (subdomain === "@") return "ALIAS";
        }
        return t;
      }).filter((t): t is string => t !== null)
    );

    for (const existType of existingTypes) {
      if (!newTypes.has(existType)) {
        console.log(`🧹 Cleanup: Deleting stale ${existType} for ${fqdn}`);
        patchPayload.push({
          name: fqdn,
          type: existType,
          ttl: DEFAULT_TTL,
          changetype: "DELETE",
          records: [],
        });
      }
    }

    processedSubdomains.add(subdomain);
  }

  // 3. Merge vendor subdomain files (_{vendor}.{X}.json -> _{vendor}.is-an.ai RRSet)
  await mergeVendorEntries(patchPayload);

  // 4. Filter and send
  if (patchPayload.length === 0) {
    console.log("✓ No changes detected.");
    return;
  }

  // [Protection] Infrastructure subdomains that must not be deleted by incremental updates
  const PROTECTED_SUBDOMAINS = new Set([
    "@", "www", "ns1", "ns2", "api",
    "_acme-challenge",
    "_vercel", "_domainkey", "_dmarc", "_github-challenge-is-an-ai",
    "_github-challenge-is-an-ai-org",
  ]);

  const normName = (n: string) => n.toLowerCase().replace(/\.$/, "");

  const finalPayload = patchPayload.filter((item) => {
    const subdomain = normName(item.name).replace(`.${ZONE}`, "") || "@";
    const isProtected = PROTECTED_SUBDOMAINS.has(subdomain);
    if (isProtected && item.changetype === "DELETE") {
      console.log(`🛡️ Protected record filtered: ${item.name} (${item.type})`);
      return false;
    }
    return true;
  });

  if (finalPayload.length === 0) {
    console.log("✓ No changes after filtering protected domains.");
    return;
  }

  // Sort: DELETEs before REPLACEs to avoid conflicts (e.g., CNAME must be removed before adding A)
  finalPayload.sort((a, b) => {
    if (a.changetype === "DELETE" && b.changetype !== "DELETE") return -1;
    if (a.changetype !== "DELETE" && b.changetype === "DELETE") return 1;
    return 0;
  });

  // 4. [Core] Smart SOA serial update
  // Changes are finalized, so update the SOA.
  console.log("🔄 Calculating new SOA Serial...");

  const currentSerial = await getCurrentSoaSerial();
  const today = new Date();
  const YYYY = today.getFullYear();
  const MM = String(today.getMonth() + 1).padStart(2, "0");
  const DD = String(today.getDate()).padStart(2, "0");
  const todayBase = parseInt(`${YYYY}${MM}${DD}01`, 10);

  // serial은 반드시 단조 증가해야 한다. 새 값이 현재 값 이하이면
  // 세컨더리(HE 등)가 존 갱신을 통째로 무시한다.
  //   - 오늘 첫 배포     -> YYYYMMDD01
  //   - 오늘 N번째 배포  -> current + 1
  //   - 하루 99회 초과   -> current + 1 (날짜 인코딩은 의미를 잃지만 단조성은 유지)
  const newSerial = currentSerial >= todayBase ? currentSerial + 1 : todayBase;
  console.log(`📆 SOA serial: ${currentSerial} -> ${newSerial}`);

  // Add SOA record
  finalPayload.push({
    name: ZONE_FQDN,
    type: "SOA",
    ttl: 3600,
    changetype: "REPLACE",
    records: [
      {
        // Note: ns1, hostmaster, etc. should be adjusted to match your environment
        // [Important] The last number (300) is the Negative Cache TTL (keep it short)
        content: `ns1.is-an.ai. hostmaster.is-an.ai. ${newSerial} 10800 3600 604800 ${SOA_MIN_TTL}`,
        disabled: false,
      },
    ],
  });

  // 5. Execute
  const success = await executePdnsPatch(finalPayload);
  if (!success) process.exit(1);

  // 6. Send NOTIFY - trigger immediate zone transfer to secondaries (HE, etc.)
  await sendPdnsNotify();

  console.log("\n✓ Incremental update completed successfully!");
}

/**
 * Send PowerDNS NOTIFY to trigger immediate AXFR on secondary nameservers (HE, etc.).
 * Without NOTIFY, secondaries may wait hours or a full day to pick up SOA serial changes.
 */
async function sendPdnsNotify(): Promise<void> {
  try {
    await pdnsClient.put(
      `/api/v1/servers/localhost/zones/${PDNS_ZONE}/notify`
    );
    console.log("✓ NOTIFY sent to secondaries (HE, etc.) - zone propagation triggered");
  } catch (error: any) {
    // NOTIFY failure is non-fatal - secondaries will sync via AXFR later
    console.warn(
      "⚠️ Failed to send NOTIFY (zone is already updated):",
      error.response?.data?.error || error.message
    );
  }
}

async function executePdnsPatch(
  payload: PdnsApiPatchRRSet[]
): Promise<boolean> {
  console.log(`\n=== Executing PowerDNS PATCH (${payload.length} items) ===`);
  try {
    await pdnsClient.patch(`/api/v1/servers/localhost/zones/${PDNS_ZONE}`, {
      rrsets: payload,
    });
    console.log("✓ Update successful!");
    return true;
  } catch (error: any) {
    console.error(
      "✗ PATCH Failed:",
      error.response?.data?.error || error.message
    );
    return false;
  }
}

// --- Vendor Subdomain Merge Logic ---

// Regex to match _{vendor}.{base}.is-an.ai. pattern
const VENDOR_PATTERN = /^_([a-z0-9]+)\..+$/;

/**
 * _{vendor}.{X}.json 파일들을 공유 RRSet _{vendor}.is-an.ai 하나로 합친다.
 *
 * 중요: 병합 대상은 "이번 푸시에 포함된 파일"이 아니라 "디스크에 있는 형제 파일 전체"다.
 * 예전에는 푸시에 들어온 파일만 모아서 REPLACE 했기 때문에,
 * _vercel.blink.json 하나만 수정해도 _vercel.is-an.ai 의 나머지 형제
 * TXT 레코드(ayisha/rodex/seron)가 통째로 날아갔다(다음 full sync 때까지).
 */
async function loadVendorRecordsFromDisk(
  vendorName: string
): Promise<PdnsApiPatchRecord[]> {
  const recordsDir = path.join(WORKSPACE_PATH, "records");
  const prefix = `_${vendorName}.`.toLowerCase();

  const files = await fs.readdir(recordsDir);
  const siblings = files.filter(
    (f) => f.toLowerCase().startsWith(prefix) && f.toLowerCase().endsWith(".json")
  );

  const seen = new Set<string>();
  const merged: PdnsApiPatchRecord[] = [];
  for (const file of siblings) {
    const records = await loadRecordFile(path.join(recordsDir, file));
    for (const r of records) {
      if (r.type.toUpperCase() !== "TXT") continue;
      const content = normalizeContent("TXT", r.content);
      if (seen.has(content)) continue;
      seen.add(content);
      merged.push({ content, disabled: false });
    }
  }
  return merged;
}

async function mergeVendorEntries(payload: PdnsApiPatchRRSet[]): Promise<void> {
  const zoneSuffix = `.${ZONE}`;
  const indicesToRemove: number[] = [];
  const touchedVendors = new Set<string>();

  for (let i = 0; i < payload.length; i++) {
    const item = payload[i];
    const normName = item.name.toLowerCase().replace(/\.$/, "");

    // _vercel.myapp.is-an.ai 같은 이름에서 vendor 를 뽑는다.
    // 정확히 _{vendor}.is-an.ai 인 병합 대상 자체는 건너뛴다.
    const withoutZone = normName.endsWith(zoneSuffix)
      ? normName.slice(0, -zoneSuffix.length)
      : null;
    if (!withoutZone) continue;

    const vendorMatch = withoutZone.match(VENDOR_PATTERN);
    if (!vendorMatch) continue;

    indicesToRemove.push(i);
    touchedVendors.add(vendorMatch[1]);
  }

  if (indicesToRemove.length === 0) return;

  // 개별 항목을 payload 에서 제거 (뒤에서부터)
  for (let i = indicesToRemove.length - 1; i >= 0; i--) {
    payload.splice(indicesToRemove[i], 1);
  }

  for (const vendorName of touchedVendors) {
    const vendorFqdn = subdomainToFqdn(`_${vendorName}`);
    const records = await loadVendorRecordsFromDisk(vendorName);

    if (records.length > 0) {
      payload.push({
        name: vendorFqdn,
        type: "TXT",
        ttl: DEFAULT_TTL,
        changetype: "REPLACE",
        records,
      });
      console.log(
        `✨ ${vendorFqdn}: 디스크의 형제 파일 전체에서 TXT ${records.length}건 병합`
      );
    } else {
      payload.push({
        name: vendorFqdn,
        type: "TXT",
        ttl: DEFAULT_TTL,
        changetype: "DELETE",
        records: [],
      });
      console.log(`🧹 ${vendorFqdn}: 남은 형제 파일이 없어 RRSet 삭제`);
    }
  }
}

// --- Run ---
processChanges().catch((err) => {
  console.error(err);
  process.exit(1);
});
