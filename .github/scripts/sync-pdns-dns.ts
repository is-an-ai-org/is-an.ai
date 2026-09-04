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

const PDNS_API_KEY: string = getEnvVariable("PDNS_API_KEY");
const PDNS_API_URL: string = getEnvVariable("PDNS_API_URL");
const PDNS_ZONE: string = getEnvVariable("PDNS_ZONE");

// PDNS_ZONE 시크릿은 끝점(trailing dot)이 있을 수도 없을 수도 있다.
// 이름 비교/변환은 전부 아래 두 정규형만 쓴다.
// (API URL의 zone id에는 PDNS_ZONE 원본을 그대로 유지한다 - 서버가 그 형식으로 받고 있다)
const ZONE = PDNS_ZONE.replace(/\.$/, "").toLowerCase(); // "is-an.ai"
const ZONE_FQDN = `${ZONE}.`; // "is-an.ai."
const WORKSPACE_PATH: string = getEnvVariable("GITHUB_WORKSPACE");
const DRY_RUN: boolean = process.env.DRY_RUN === "true";

// Infrastructure records managed in code, always REPLACE'd during sync.
// These are NOT in the records/ directory — they are system-owned.
const INFRA_RECORDS: { subdomain: string; type: string; content: string; ttl?: number }[] = [
  // Root domain (Cloudflare Pages)
  { subdomain: "@", type: "A", content: "172.67.69.118" },
  { subdomain: "@", type: "A", content: "104.26.0.194" },
  { subdomain: "@", type: "A", content: "104.26.1.194" },
  // www -> root
  { subdomain: "www", type: "CNAME", content: "is-an.ai." },
  // API (AWS API Gateway)
  { subdomain: "api", type: "CNAME", content: "d-ubup8azes2.execute-api.ap-northeast-2.amazonaws.com." },
  // ACME challenge for Cloudflare Advanced Certificate (*.is-an.ai, is-an.ai)
  { subdomain: "_acme-challenge", type: "TXT", content: "b-CBgXqKCAzF12h9p8RL2G12xcH2Wwo7oSjaqCfGx8w" },
  { subdomain: "_acme-challenge", type: "TXT", content: "lx-WkBJPe1UFy7594psF5Uh-tHaKOizVSOytn9QMZRQ" },
  // AWS ACM certificate validation
  { subdomain: "_a9ab750e916935c7640fcc445b3d680e.api", type: "CNAME", content: "_1fdee9dd2fb5e5194a89789cd0eaeea5.jkddzztszm.acm-validations.aws." },
  { subdomain: "_5e4bd9003d776452019cfc956b117f9a", type: "CNAME", content: "_10d93bcec8bda96dcce155842175cc92.jkddzztszm.acm-validations.aws." },
];

const INFRA_SUBDOMAINS = new Set(INFRA_RECORDS.map((r) => r.subdomain));

// --- 대량 삭제 가드 -------------------------------------------------------
// 이 스크립트는 "레포에 없으면 PowerDNS에서 지운다"는 전체 동기화다.
// 레포가 불완전한 상태(체크아웃 실패, 브랜치 오지정, org 이전 중 부분 푸시)에서
// 한 번 돌면 사용자 레코드 전체가 지워지고, HE 세컨더리까지 전파된다.
// 지금까지 이걸 막는 장치가 없었다.
//
// 정상 운영에서 하루치 삭제는 한 자릿수다. 그보다 크게 벗어나면 데이터가 아니라
// 파이프라인을 의심해야 한다. 의도적 대량 정리는 ALLOW_BULK_DELETE=true 로 1회 허용한다.
const MAX_DELETE_RATIO = Number(process.env.MAX_DELETE_RATIO ?? "0.05"); // 5%
const MAX_DELETE_ABSOLUTE = Number(process.env.MAX_DELETE_ABSOLUTE ?? "50"); // 이하는 항상 허용
const ALLOW_BULK_DELETE: boolean = process.env.ALLOW_BULK_DELETE === "true";

const DEFAULT_TTL = 300; // Default TTL for PDNS records
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

// --- Helper Functions ---
function getSubdomainFromPath(filePath: string): string {
  const filename = path.basename(filePath, ".json");
  const baseDomainPattern = `.${ZONE}`; // ".is-an.ai"

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
 * 비교 전용 타입 정규화.
 *
 * 저장소는 항상 CNAME으로 적지만, apex이거나 다른 타입과 공존하면
 * PowerDNS에는 ALIAS로 들어간다(아래 payload 빌더의 규칙). 이걸 정규화하지 않으면
 * 해당 레코드들이 매 실행 toCreate와 toDelete 양쪽에 영구히 걸린다.
 * signature 키에만 쓰고, RecordSignature.type 자체는 원본을 유지한다
 * (DELETE는 PowerDNS에 실제로 존재하는 타입으로 나가야 하므로).
 */
function signatureType(type: string): string {
  return type.toUpperCase() === "ALIAS" ? "CNAME" : type;
}

function createRecordSignature(record: RecordSignature): string {
  const { subdomain, priority } = record;
  const type = signatureType(record.type);
  // 콘텐츠 정규화를 시그니처 단계에서 적용한다.
  // 예전에는 payload를 만들 때만 정규화해서, 저장소의 "example.com" 과
  // PowerDNS의 "example.com." 이 영구히 다른 것으로 잡혔다
  // (CNAME/MX/NS/SRV/PTR/TXT/A 전부 해당).
  const content = normalizeContent(type, record.content);
  return priority !== undefined
    ? `${subdomain}:${type}:${content}:${priority}`
    : `${subdomain}:${type}:${content}`;
}

function fqdnToSubdomain(fqdn: string): string {
  // PowerDNS가 돌려주는 name은 항상 끝점이 있다("foo.is-an.ai.").
  // 예전 구현은 끝점 없는 PDNS_ZONE으로 잘라내 "foo." 를 만들었고,
  // 저장소 쪽 키 "foo" 와 전부 어긋나 diff가 통째로 무의미해졌다.
  const normalized = fqdn.toLowerCase().replace(/\.$/, "");
  if (normalized === ZONE) return "@";
  if (normalized.endsWith(`.${ZONE}`)) {
    return normalized.slice(0, -(ZONE.length + 1));
  }
  return normalized;
}

function subdomainToFqdn(subdomain: string): string {
  while (subdomain.startsWith(".")) {
    subdomain = subdomain.slice(1);
  }
  while (subdomain.endsWith(".")) {
    subdomain = subdomain.slice(0, -1);
  }

  if (!subdomain || subdomain === "@" || subdomain.trim() === "") {
    return ZONE_FQDN;
  }
  return `${subdomain}.${ZONE_FQDN}`.toLowerCase();
}

function normalizeContent(type: string, content: string): string {
  const typesNeedingDot = ["CNAME", "MX", "NS", "SRV", "PTR"];
  const upperType = type.toUpperCase();

  if (typesNeedingDot.includes(type.toUpperCase())) {
    if (!content.endsWith(".")) {
      return content + ".";
    }
  }
  if (upperType === "TXT") {
    let cleanContent = content;
    if (cleanContent.includes(" IN TXT ")) {
      const parts = cleanContent.split(" IN TXT ");
      if (parts.length > 1) {
        cleanContent = parts[1].trim();
      }
    }
    if (cleanContent.startsWith('"') && cleanContent.endsWith('"')) {
      cleanContent = cleanContent.slice(1, -1);
    }
    return `"${cleanContent}"`;
  }
  if (upperType === "A") {
    if (content.includes(".") && content.split(".").length === 4) {
      return content
        .split(".")
        .map((octet) => parseInt(octet, 10))
        .join(".");
    }
  }
  if (upperType === "AAAA") {
    return expandIpv6(content);
  }
  return content;
}

/**
 * IPv6를 8그룹 4자리 소문자로 펼친다.
 *
 * PowerDNS는 저장할 때 RFC 5952로 압축해서 돌려준다
 * ("2001:41d0:0303:643d:0000:0000:04c7:b145" -> "2001:41d0:303:643d::4c7:b145").
 * 저장소는 사용자가 적은 형태 그대로다. 시그니처가 원문 문자열이던 동안
 * 이 둘은 영원히 달랐고, AAAA 25건이 매 동기화마다 REPLACE로 잡혀
 * SOA serial이 올라갔다. 그러면 HE 세컨더리가 매일 전 존을 다시 받아간다.
 *
 * 압축(RFC 5952)이 아니라 펼치는 쪽을 고른 이유: 압축은 "가장 긴 0 구간"
 * 선택 규칙 때문에 구현이 틀리기 쉽고, 펼치기는 양쪽을 같은 형태로 만들기만
 * 하면 되므로 비교 목적에는 이걸로 충분하다.
 */
function expandIpv6(content: string): string {
  // IPv4 매핑 표기(::ffff:1.2.3.4)는 건드리지 않는다. 여기서 잘못 만지면
  // 조용히 다른 주소가 된다. 실사용 0건이라 현행 유지가 안전하다.
  if (content.includes(".")) return content;

  const halves = content.split("::");
  if (halves.length > 2) return content;

  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return content;

  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8) return content;
  if (!groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return content;

  return groups.map((g) => g.toLowerCase().padStart(4, "0")).join(":");
}

// --- PowerDNS API Functions ---

// 존을 받을 때 SOA serial도 같이 뽑아 둔다.
// 예전에는 getCurrentSoaSerial()이 오직 이 값 하나를 다시 읽으려고
// 존 전체(~1MB)를 두 번째로 내려받았다.
let cachedSoaSerial = 0;

async function fetchAllPdnsRRSets(): Promise<PdnsApiGetRRSet[]> {
  console.log("Fetching all DNS RRSet from PowerDNS...");
  try {
    const response = await pdnsClient.get(
      `/api/v1/servers/localhost/zones/${PDNS_ZONE}`
    );
    const rrsets: PdnsApiGetRRSet[] = response.data.rrsets || [];

    const soaRR = rrsets.find((rr) => rr.type === "SOA");
    const soaContent = soaRR?.records?.[0]?.content;
    if (soaContent) {
      // SOA format: ns1.xxx email.xxx SERIAL refresh retry expire min_ttl
      const parts = soaContent.split(/\s+/);
      if (parts.length >= 3) {
        const parsed = parseInt(parts[2], 10);
        if (Number.isFinite(parsed)) cachedSoaSerial = parsed;
      }
    }

    const managedRRSets = rrsets.filter(
      (rr) => rr.type !== "SOA" && rr.type !== "NS"
    );
    console.log(
      `Found ${managedRRSets.length} managed RRSets in PowerDNS (SOA serial ${cachedSoaSerial})`
    );
    return managedRRSets;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error fetching PowerDNS RRSet:", message);
    if (error && typeof error === "object" && axios.isAxiosError(error)) {
      if (error.code === "ECONNABORTED" || error.message.includes("timeout")) {
        console.error("❌ PowerDNS API request timed out (exceeded 30s)");
      } else if (error.response) {
        console.error("Response status:", error.response.status);
        console.error("Response data:", error.response.data);
      } else if (error.request) {
        console.error("❌ Unable to connect to PowerDNS server.");
      }
    }
    throw error;
  }
}

/**
 * 현재 SOA serial. fetchAllPdnsRRSets()가 캐시해 둔 값을 쓴다.
 * 확정할 수 없으면 0을 반환하지 않고 중단한다 - 0이면 새 serial이
 * YYYYMMDD01로 계산돼 현재 값보다 낮아질 수 있고, 그러면 세컨더리가
 * 존 갱신을 무시한다.
 */
async function getCurrentSoaSerial(): Promise<number> {
  if (!cachedSoaSerial) {
    throw new Error(
      "현재 SOA serial을 읽지 못했습니다. serial 역행을 막기 위해 중단합니다."
    );
  }
  return cachedSoaSerial;
}

/**
 * 한 이름에 CNAME이 여러 개면 첫 번째만 남긴다.
 *
 * payload를 만들 때는 이미 접고 있었지만(“Multiple CNAMEs found … Using only
 * the first one”), 비교용 시그니처는 접지 않아서 저장소 쪽에만 2~3개가 남았다.
 * 그러면 PowerDNS에 실제로 쓰인 1개와 영원히 어긋나 매 실행 REPLACE가 나간다.
 * 접는 위치를 payload 단계에서 적재 단계로 올려 양쪽이 같은 것을 보게 한다.
 */
function collapseExtraCnames(
  subdomain: string,
  signatures: RecordSignature[]
): RecordSignature[] {
  let seenCname = false;
  const kept: RecordSignature[] = [];
  for (const sig of signatures) {
    if (sig.type.toUpperCase() === "CNAME") {
      if (seenCname) continue;
      seenCname = true;
    }
    kept.push(sig);
  }
  if (kept.length !== signatures.length) {
    console.warn(
      `⚠️ Multiple CNAMEs for '${subdomain}': keeping the first, ignoring ${
        signatures.length - kept.length
      }.`
    );
  }
  return kept;
}

/**
 * Convert a PDNS API (GET) response RRSet into internal RecordSignature array.
 * (Replaces convertCloudflareToSignature)
 */
function convertPdnsRRSetToSignatures(
  rrset: PdnsApiGetRRSet
): RecordSignature[] {
  const signatures: RecordSignature[] = [];
  const subdomain = fqdnToSubdomain(rrset.name);

  for (const record of rrset.records) {
    let content = record.content;
    let priority: number | undefined;

    if (rrset.type === "MX" && record.content) {
      const parts = record.content.split(" ");
      if (parts.length === 2) {
        priority = parseInt(parts[0], 10);
        content = parts[1];
      }
    }
    signatures.push({
      subdomain,
      type: rrset.type,
      content,
      priority,
    });
  }
  return signatures;
}

async function loadAllRepositoryRecords(): Promise<
  Map<string, RecordSignature[]>
> {
  console.log("Loading all repository records...");
  const recordsDir = path.join(WORKSPACE_PATH, "records");
  const recordMap = new Map<string, RecordSignature[]>();

  try {
    const files = await fs.readdir(recordsDir);
    const jsonFiles = files.filter(
      (file) => file.endsWith(".json") && file !== "schema.json"
    );

    console.log(`Found ${jsonFiles.length} record files in repository`);

    // 파일당 순차 await 이었던 것을 동시성 제한 병렬 읽기로 바꾼다.
    // 3600개 넘는 파일을 하나씩 await 하면 마이크로태스크 왕복만으로도 무시 못 할 시간이 든다.
    const READ_CONCURRENCY = 32;
    const fileContents = new Map<string, string>();
    for (let i = 0; i < jsonFiles.length; i += READ_CONCURRENCY) {
      const chunk = jsonFiles.slice(i, i + READ_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (file): Promise<[string, string | null]> => {
          try {
            const content = await fs.readFile(
              path.join(recordsDir, file),
              "utf-8"
            );
            return [file, content];
          } catch (error: unknown) {
            const message =
              error instanceof Error ? error.message : String(error);
            console.error(`Error reading file ${file}:`, message);
            return [file, null];
          }
        })
      );
      for (const [file, content] of results) {
        if (content !== null) fileContents.set(file, content);
      }
    }

    for (const file of jsonFiles) {
      const subdomain = getSubdomainFromPath(file);

      if (!subdomain) {
        console.warn(`Could not determine subdomain for file ${file}, skipping`);
        continue;
      }
      if (subdomain !== subdomain.toLowerCase()) {
        console.log(
          `🔡 '${file}': Converting subdomain to lowercase: ${subdomain} → ${subdomain.toLowerCase()}`
        );
      }

      // _{vendor}.{X} files are mapped to "_{vendor}" subdomain
      // e.g., _vercel.myapp -> _vercel, _discord.myapp -> _discord
      const vendorMatch = subdomain.match(/^(_[a-z0-9]+)\..+$/);
      const effectiveSubdomain = vendorMatch ? vendorMatch[1] : subdomain;

      try {
        const fileContent = fileContents.get(file);
        if (fileContent === undefined) continue; // 읽기 실패는 위에서 이미 보고됨
        const data: unknown = JSON.parse(fileContent);

        if (
          !data ||
          typeof data !== "object" ||
          !("record" in data) ||
          !Array.isArray((data as RecordFileContent).record)
        ) {
          console.warn(`Invalid record structure in file ${file}, skipping`);
          continue;
        }

        const fileData = data as RecordFileContent;
        const signatures: RecordSignature[] = [];

        for (const recordDef of fileData.record) {
          const type = recordDef.type.toUpperCase();
          const ipv4Regex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;

          if (type === "A" && typeof recordDef.value === "string") {
            if (!ipv4Regex.test(recordDef.value)) {
              console.warn(
                `⚠️ Skipping invalid A record in '${file}': Value '${recordDef.value}' is not a valid IPv4 address.`
              );
              continue;
            }
          }
          if (type === "MX" && isMxRecordValue(recordDef.value)) {
            signatures.push({
              subdomain: effectiveSubdomain,
              type,
              content: recordDef.value.exchange,
              priority: recordDef.value.priority,
            });
          } else if (typeof recordDef.value === "string") {
            signatures.push({
              subdomain: effectiveSubdomain,
              type,
              content: recordDef.value,
            });
          } else {
            console.warn(
              `Invalid record value in ${file}: ${JSON.stringify(
                recordDef.value
              )}`
            );
          }
        }
        // Append to existing entries (multiple _{vendor}.* files merge into "_{vendor}")
        const existing = recordMap.get(effectiveSubdomain) || [];
        recordMap.set(
          effectiveSubdomain,
          collapseExtraCnames(effectiveSubdomain, [...existing, ...signatures])
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error processing file ${file}:`, message);
      }
    }
    return recordMap;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error loading repository records:", message);
    throw error;
  }
}

async function executePdnsPatch(
  payload: PdnsApiPatchRRSet[]
): Promise<boolean> {
  console.log(`\n=== Executing PowerDNS PATCH ===`);
  console.log(`Sending ${payload.length} RRSet changes...`);

  if (DRY_RUN) {
    console.log("[DRY RUN] Would send the following PATCH payload:");
    console.log(JSON.stringify({ rrsets: payload }, null, 2));
    return true;
  }

  try {
    await pdnsClient.patch(`/api/v1/servers/localhost/zones/${PDNS_ZONE}`, {
      rrsets: payload,
    });
    console.log("✓ PowerDNS update successful!");
    return true;
  } catch (error: unknown) {
    console.error("✗ Failed to execute PowerDNS PATCH:");
    if (error && typeof error === "object" && axios.isAxiosError(error)) {
      if (error.code === "ECONNABORTED" || error.message.includes("timeout")) {
        console.error("❌ PowerDNS API request timed out (exceeded 30s)");
      } else if (error.response) {
        console.error("Status:", error.response.status);
        console.error("Data:", JSON.stringify(error.response.data, null, 2));
      } else if (error.request) {
        console.error("❌ Unable to connect to PowerDNS server.");
      }
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Error:", message);
    }
    return false;
  }
}

// --- Main Sync Logic (Fixed Order) ---

async function syncDNSRecords(): Promise<void> {
  console.log("=== Starting DNS Sync Process for PowerDNS ===");

  // 1. Load state from both sides
  const [pdnsRRSets, repositoryRecordsMap] = await Promise.all([
    fetchAllPdnsRRSets(),
    loadAllRepositoryRecords(),
  ]);

  // 1.5. Inject infrastructure records into the repository map
  for (const infra of INFRA_RECORDS) {
    const existing = repositoryRecordsMap.get(infra.subdomain) || [];
    existing.push({
      subdomain: infra.subdomain,
      type: infra.type,
      content: infra.content,
    });
    repositoryRecordsMap.set(infra.subdomain, existing);
  }
  console.log(`Injected ${INFRA_RECORDS.length} infrastructure records`);

  // 2. Convert PDNS state into a comparable Map
  const pdnsSignatures = new Map<string, RecordSignature>();
  for (const rrset of pdnsRRSets) {
    const signatures = convertPdnsRRSetToSignatures(rrset);
    for (const sig of signatures) {
      pdnsSignatures.set(createRecordSignature(sig), sig);
    }
  }

  // 3. Convert Git repository state and track changed keys
  const repositorySignatures = new Map<string, RecordSignature>();
  const changedRrsetKeys = new Map<
    string,
    { subdomain: string; type: string }
  >();

  for (const [, records] of repositoryRecordsMap.entries()) {
    for (const record of records) {
      repositorySignatures.set(createRecordSignature(record), record);
    }
  }

  console.log(`Repository records (flattened): ${repositorySignatures.size}`);
  console.log(`PowerDNS records (flattened): ${pdnsSignatures.size}`);

  // 4. Calculate diff
  const toCreate: RecordSignature[] = [];
  const toDelete: RecordSignature[] = [];
  let protectedCount = 0;

  // Records to create
  for (const [key, signature] of repositorySignatures) {
    if (!pdnsSignatures.has(key)) {
      toCreate.push(signature);

      // 실제로 달라진 RRSet만 PATCH 대상이 된다.
      // 예전에는 이 맵이 저장소 전체로 채워져 있어서 변경이 0건인 밤에도
      // ~3700개 RRSet을 REPLACE하고 SOA serial을 올리고 NOTIFY까지 쐈다.
      const rrsetKey = `${signature.subdomain}:${signature.type}`;
      if (!changedRrsetKeys.has(rrsetKey)) {
        changedRrsetKeys.set(rrsetKey, {
          subdomain: signature.subdomain,
          type: signature.type,
        });
      }
    }
  }

  // Records to delete
  for (const [key, signature] of pdnsSignatures) {
    if (!repositorySignatures.has(key)) {
      if (INFRA_SUBDOMAINS.has(signature.subdomain)) {
        // Allow deletion of stale types for infra subdomains (e.g., ALIAS -> CNAME migration)
        const infraTypes = new Set(
          INFRA_RECORDS.filter((r) => r.subdomain === signature.subdomain).map((r) => r.type)
        );
        if (infraTypes.has(signature.type)) {
          // Same type exists in infra definition — this is just a content diff, protect it
          console.log(
            `🛡️ Protecting system subdomain: ${signature.subdomain} (${signature.type})`
          );
          protectedCount++;
          continue;
        }
        // Different type — allow deletion (stale record from previous config)
        console.log(
          `🧹 Allowing deletion of stale type for infra subdomain: ${signature.subdomain} (${signature.type})`
        );
      }
      toDelete.push(signature);

      const rrsetKey = `${signature.subdomain}:${signature.type}`;
      if (!changedRrsetKeys.has(rrsetKey)) {
        changedRrsetKeys.set(rrsetKey, {
          subdomain: signature.subdomain,
          type: signature.type,
        });
      }
    }
  }

  console.log(`\n=== Sync Summary ===`);
  console.log(`Individual records to create: ${toCreate.length}`);
  console.log(`Individual records to delete: ${toDelete.length}`);

  // --- 대량 삭제 가드 --------------------------------------------------------
  const pdnsTotal = pdnsSignatures.size;
  const deleteRatio = pdnsTotal > 0 ? toDelete.length / pdnsTotal : 0;
  const overAbsolute = toDelete.length > MAX_DELETE_ABSOLUTE;
  const overRatio = deleteRatio > MAX_DELETE_RATIO;

  if (overAbsolute && overRatio) {
    console.error("\n🛑 대량 삭제 감지 — 동기화를 중단한다.");
    console.error(
      `   삭제 예정 ${toDelete.length}건 / PowerDNS 전체 ${pdnsTotal}건 ` +
        `(${(deleteRatio * 100).toFixed(1)}%)`
    );
    console.error(
      `   임계: ${MAX_DELETE_ABSOLUTE}건 초과 AND ${(MAX_DELETE_RATIO * 100).toFixed(0)}% 초과`
    );
    console.error("   삭제 예정 표본 20건:");
    for (const sig of toDelete.slice(0, 20)) {
      console.error(`     - ${sig.subdomain} (${sig.type})`);
    }
    console.error("");
    console.error("   먼저 의심할 것: 레포 체크아웃이 비었거나 브랜치가 틀렸거나");
    console.error("   org 이전 중 부분 푸시 상태다. 데이터가 아니라 파이프라인을 보라.");
    console.error("   Repository records (flattened): " + repositorySignatures.size);
    console.error("");
    console.error("   의도한 대량 정리라면 ALLOW_BULK_DELETE=true 로 1회만 실행한다.");
    if (!ALLOW_BULK_DELETE) {
      process.exit(1);
    }
    console.error("⚠️ ALLOW_BULK_DELETE=true — 가드를 무시하고 진행한다.");
  }
  if (protectedCount > 0) {
    console.log(`Protected system records (ignored): ${protectedCount}`);
  }

  // 5. Build PowerDNS PATCH payload
  const patchPayload: PdnsApiPatchRRSet[] = [];

  for (const { subdomain, type } of changedRrsetKeys.values()) {
    const fqdn = subdomainToFqdn(subdomain);
    let repoRecordsForRrset =
      repositoryRecordsMap.get(subdomain)?.filter((r) => r.type === type) || [];

    if (repoRecordsForRrset.length > 0) {
      // --- REPLACE logic ---
      if (type === "CNAME" && repoRecordsForRrset.length > 1) {
        console.warn(
          `⚠️ Warning: Multiple CNAMEs found for ${fqdn}. Using only the first one.`
        );
        repoRecordsForRrset = [repoRecordsForRrset[0]];
      }

      let finalType = type;
      if (type === "CNAME") {
        const allRecords = repositoryRecordsMap.get(subdomain) || [];
        const hasIPRecords = allRecords.some(
          (r) => r.type === "A" || r.type === "AAAA"
        );

        if (hasIPRecords) {
          console.warn(
            `⚠️ Conflict: CNAME cannot coexist with A/AAAA. Ignoring CNAME.`
          );
          continue;
        }
        if (fqdn === ZONE_FQDN) finalType = "ALIAS";
        const hasOtherTypes = allRecords.some((r) => r.type !== "CNAME");
        if (hasOtherTypes && finalType === "CNAME") finalType = "ALIAS";
        // Note: child subdomains (e.g., _acme-challenge.api under api) do NOT
        // conflict with CNAME per RFC. Only same-name records conflict.
      }

      patchPayload.push({
        name: fqdn,
        type: finalType,
        ttl: DEFAULT_TTL,
        changetype: "REPLACE",
        records: repoRecordsForRrset.map((r) => {
          let content = normalizeContent(r.type, r.content);
          // MX: priority must be part of content, not a separate field
          if (r.type === "MX" && r.priority !== undefined) {
            content = `${r.priority} ${content}`;
          }
          return { content, disabled: false };
        }),
      });
    } else {
      // --- DELETE logic ---
      patchPayload.push({
        name: fqdn,
        type: type,
        ttl: DEFAULT_TTL,
        changetype: "DELETE",
        records: [],
      });
    }
  }

  if (patchPayload.length === 0) {
    console.log("✓ DNS records are already in sync!");
    return;
  }

  // ---------------------------------------------------------
  // [Core fix] Sort payload: DELETEs must come before REPLACEs
  // ---------------------------------------------------------
  patchPayload.sort((a, b) => {
    // DELETE(-1) comes before REPLACE(1)
    if (a.changetype === "DELETE" && b.changetype !== "DELETE") return -1;
    if (a.changetype !== "DELETE" && b.changetype === "DELETE") return 1;
    return 0;
  });

  // 6. Execute changes (with protection logic)
  // Auto-generate protected FQDNs from INFRA_RECORDS + additional system domains
  const EXTRA_PROTECTED = ["ns1", "ns2", "_vercel", "_domainkey",
    "_github-challenge-is-an-ai", "_github-challenge-is-an-ai-org"];
  const PROTECTED_FQDNS = new Set([
    ...Array.from(INFRA_SUBDOMAINS).map((s) => subdomainToFqdn(s)),
    ...EXTRA_PROTECTED.map((s) => subdomainToFqdn(s)),
  ]);

  const finalPayload = patchPayload.filter((item) => {
    const isProtected = PROTECTED_FQDNS.has(item.name);
    if (isProtected && item.changetype === "DELETE") {
      console.log(
        `🛡️ Protected record detected. Skipping deletion for: ${item.name}`
      );
      return false;
    }
    return true;
  });

  if (finalPayload.length === 0) {
    console.log(
      "✓ DNS records are already in sync (Protected records were skipped)."
    );
    return;
  }

  // [Core] Smart SOA serial update - changes exist, so update the SOA.
  // Do not rely on PowerDNS auto-incrementing SOA on zone PATCH;
  // explicitly update using the same logic as update-pdns-dns.ts.
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
        content: `ns1.is-an.ai. hostmaster.is-an.ai. ${newSerial} 10800 3600 604800 ${SOA_MIN_TTL}`,
        disabled: false,
      },
    ],
  });

  console.log(
    `=== Executing PowerDNS PATCH (${finalPayload.length} changes) ===`
  );

  // [Important] Pass the filtered finalPayload + SOA to the execution function, not patchPayload.
  const success = await executePdnsPatch(finalPayload);

  if (!success) {
    console.error("✗ DNS sync process failed during PowerDNS PATCH.");
    process.exit(1);
  }

  // Send NOTIFY - trigger immediate zone transfer to secondaries (HE, etc.)
  await sendPdnsNotify();

  console.log(`\n✓ DNS sync process completed!`);
}

/**
 * Send PowerDNS NOTIFY to trigger immediate AXFR on secondary nameservers (HE, etc.).
 */
async function sendPdnsNotify(): Promise<void> {
  try {
    await pdnsClient.put(
      `/api/v1/servers/localhost/zones/${PDNS_ZONE}/notify`
    );
    console.log("✓ NOTIFY sent to secondaries (HE, etc.) - zone propagation triggered");
  } catch (error: unknown) {
    console.warn(
      "⚠️ Failed to send NOTIFY (zone is already updated):",
      error && typeof error === "object" && "message" in error
        ? (error as Error).message
        : String(error)
    );
  }
}

// --- Main Execution ---
syncDNSRecords()
  .then(() => {
    console.log("\n✓ Script completed successfully");
    process.exit(0);
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("\n✗ Unhandled error during DNS sync process:", message);
    if (err instanceof Error && err.stack) {
      console.error("Stack trace:", err.stack);
    }
    process.exit(1);
  });
