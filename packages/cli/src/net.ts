/**
 * Third-party media URLs (Openverse, Wikimedia Commons, Pexels) come from API
 * responses: before CutKiller or FFmpeg downloads one, it must be https and
 * point at a public address — never this machine, its network or a cloud
 * metadata service (SSRF).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { tr } from "@cutkiller/core";

export type HostResolver = (host: string) => Promise<string[]>;

const resolveAll: HostResolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/** Loopback, private, link-local, carrier-grade NAT, multicast, unspecified (IPv4 and IPv6). */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a = 0, b = 0] = v4.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe8") ||
    v6.startsWith("fe9") ||
    v6.startsWith("fea") ||
    v6.startsWith("feb") ||
    v6.startsWith("ff")
  );
}

/** The URL, if it is https and every address of its host is public; throws otherwise. */
export async function publicHttpsUrl(url: string, resolveHost: HostResolver = resolveAll): Promise<string> {
  const u = new URL(url);
  const refuse = (why: string) => {
    throw new Error(tr(`refused download ${u.origin}: ${why}`, `téléchargement refusé ${u.origin} : ${why}`));
  };
  if (u.protocol !== "https:") refuse("https only");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await resolveHost(host);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) refuse("private or local address");
  return u.toString();
}

/** FFmpeg reading a remote media: https only, never local files or other protocols. */
export const REMOTE_INPUT_GUARD = ["-protocol_whitelist", "https,tls,tcp,crypto"];

/** fetch() of a third-party URL, every redirect checked again (at most 5). */
export async function fetchPublic(
  url: string,
  opts: { fetchImpl?: typeof fetch; resolveHost?: HostResolver; init?: RequestInit } = {},
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    const target = await publicHttpsUrl(current, opts.resolveHost);
    const res = await (opts.fetchImpl ?? fetch)(target, { ...opts.init, redirect: "manual" });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    current = new URL(location, target).toString();
  }
  throw new Error(tr(`too many redirects: ${url}`, `trop de redirections : ${url}`));
}
