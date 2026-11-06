import axios, { AxiosInstance } from "axios";
import { Resolver } from "node:dns/promises";
import { setTimeout } from "node:timers/promises";
import { domainToASCII } from "node:url";

const nameservers = [1, 2, 3, 4, 5].map((n) => `ns${n}.he.net`);
const recordTypes = ["A", "AAAA", "CNAME"] as const;
type RecordType = (typeof recordTypes)[number];
interface RRSet {
  name: string;
  type: string;
  records: { content: string; disabled: boolean }[];
}
interface Zone {
  serial: number;
  rrsets: RRSet[];
}

function hostname(value: string): string {
  const name = domainToASCII(value.toLowerCase().replace(/\.$/, ""));
  if (
    !name ||
    name.length > 253 ||
    name
      .split(".")
      .some((label) => !/^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label))
  )
    throw new Error("Invalid DNS hostname");
  return name;
}

function normalize(type: RecordType, values: string[]): string[] {
  return values
    .map((value) => {
      if (type === "CNAME") return hostname(value);
      if (type === "AAAA") return new URL(`http://[${value}]/`).hostname;
      return value;
    })
    .sort();
}

export async function notifySecondaries(
  client: AxiosInstance,
  zone: string,
): Promise<void> {
  try {
    await client.put(
      `/api/v1/servers/localhost/zones/${encodeURIComponent(zone)}/notify`,
    );
    console.log(
      "PowerDNS accepted NOTIFY; public DNS verification is still required.",
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`PowerDNS NOTIFY failed: ${message}`);
  }
}

export async function verifyDns(
  client: AxiosInstance,
  zoneValue: string,
  probeValue: string,
  recover: boolean | "repair-he-notify",
): Promise<void> {
  const zone = hostname(zoneValue);
  const probe = hostname(probeValue);
  if (probe !== zone && !probe.endsWith(`.${zone}`)) {
    throw new Error("Probe hostname must belong to the managed zone");
  }
  const load = async () => {
    const { data } = await client.get<Zone>(
      `/api/v1/servers/localhost/zones/${encodeURIComponent(zone + ".")}`,
      { params: { rrset_name: probe + "." } },
    );
    if (
      !Number.isInteger(data.serial) ||
      data.serial < 0 ||
      data.serial > 0xffffffff ||
      !Array.isArray(data.rrsets)
    ) {
      throw new Error("PowerDNS returned an invalid zone snapshot");
    }
    for (const type of recordTypes) {
      const rrset = data.rrsets.find(
        (r) =>
          r.name.toLowerCase().replace(/\.$/, "") === probe &&
          r.type === type &&
          r.records.some((record) => !record.disabled),
      );
      if (rrset)
        return {
          serial: data.serial,
          type,
          records: normalize(
            type,
            rrset.records.filter((r) => !r.disabled).map((r) => r.content),
          ),
        };
    }
    throw new Error(
      "Probe must have an enabled A, AAAA, or CNAME record in PowerDNS",
    );
  };
  let expected = await load();
  if (recover === "repair-he-notify") {
    const path = `/api/v1/servers/localhost/zones/${encodeURIComponent(zone + ".")}/metadata/ALSO-NOTIFY`;
    const { data } = await client.get<{ metadata: string[] }>(path);
    if (
      !Array.isArray(data.metadata) ||
      data.metadata.some((value) => typeof value !== "string")
    )
      throw new Error("PowerDNS returned invalid ALSO-NOTIFY metadata");
    // HE receives transfer notifications at its collector, separately from public NS addresses.
    const collector = "216.218.133.2";
    if (!data.metadata.includes(collector)) {
      await client.put(path, {
        kind: "ALSO-NOTIFY",
        metadata: [...data.metadata, collector],
      });
      const check = await client.get<{ metadata: string[] }>(path);
      if (!check.data.metadata.includes(collector))
        throw new Error("PowerDNS did not persist the HE NOTIFY target");
    }
    console.log(`HE transfer collector ${collector} is in ALSO-NOTIFY.`);
  }
  if (recover) await notifySecondaries(client, zone + ".");
  let failures: string[] = [];
  for (let attempt = 1; attempt <= 60; attempt++) {
    const results = await Promise.all(
      nameservers.map(async (nameserver) => {
        try {
          const bootstrap = new Resolver({ timeout: 2000, tries: 1 });
          const addresses = await bootstrap.resolve4(nameserver);
          if (!addresses.length)
            throw new Error("Nameserver has no IPv4 address");
          const resolver = new Resolver({ timeout: 2000, tries: 1 });
          resolver.setServers([addresses[0]]);
          const [soa, records] = await Promise.all([
            resolver.resolveSoa(zone),
            expected.type === "A"
              ? resolver.resolve4(probe)
              : expected.type === "AAAA"
                ? resolver.resolve6(probe)
                : resolver.resolveCname(probe),
          ]);
          if (soa.serial !== expected.serial)
            return `${nameserver}: serial ${soa.serial}, expected ${expected.serial}`;
          if (
            JSON.stringify(normalize(expected.type, records)) !==
            JSON.stringify(expected.records)
          ) {
            return `${nameserver}: ${expected.type} ${probe} differs from PowerDNS`;
          }
          return null;
        } catch (error: unknown) {
          return `${nameserver}: ${error instanceof Error ? error.message : String(error)}`;
        }
      }),
    );
    failures = results.filter((result): result is string => result !== null);
    if (!failures.length) {
      console.log(
        `Verified all 5 public nameservers: serial ${expected.serial}, ${expected.type} ${probe}.`,
      );
      return;
    }
    console.log(
      `Public DNS check ${attempt}/60 (primary serial ${expected.serial}, ${expected.type} ${probe}): ${failures.join("; ")}`,
    );
    if (attempt < 60) {
      await setTimeout(5000);
      expected = await load();
    }
  }
  throw new Error(`Public DNS did not converge: ${failures.join("; ")}`);
}

async function main(): Promise<void> {
  const key = process.env.PDNS_API_KEY;
  const url = process.env.PDNS_API_URL;
  const zone = process.env.PDNS_ZONE;
  if (!key || !url || !zone)
    throw new Error("PDNS_API_KEY, PDNS_API_URL and PDNS_ZONE are required");
  const recover = process.env.NOTIFY_ONLY === "true";
  const repair = process.env.REPAIR_HE_NOTIFY === "true";
  if (repair && !recover)
    throw new Error("HE NOTIFY repair requires NOTIFY_ONLY=true");
  if (process.env.DRY_RUN === "true")
    throw new Error(
      "Public DNS recovery/verification cannot run in dry-run mode",
    );
  const client = axios.create({
    baseURL: url,
    headers: { "X-API-Key": key },
    timeout: 30000,
  });
  const probe = process.env.DNS_PROBE_NAME || `www.${hostname(zone)}`;
  await verifyDns(client, zone, probe, repair ? "repair-he-notify" : recover);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
