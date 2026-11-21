import { describe, expect, it } from "vitest";
import { isPrivateAddress, publicHttpsUrl } from "../src/net";

describe("third-party URL guard", () => {
  it("knows private, local and metadata addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "172.66.153.86", "2606:4700::6810:1101"])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("accepts https to a public host, refuses everything else", async () => {
    const publicDns = async () => ["93.184.216.34"];
    const privateDns = async () => ["10.0.0.7"];
    await expect(publicHttpsUrl("https://upload.wikimedia.org/a.webm", publicDns)).resolves.toContain(
      "wikimedia",
    );
    await expect(publicHttpsUrl("http://upload.wikimedia.org/a.webm", publicDns)).rejects.toThrow();
    await expect(publicHttpsUrl("file:///etc/passwd", publicDns)).rejects.toThrow();
    await expect(publicHttpsUrl("https://intranet.example/a.mp4", privateDns)).rejects.toThrow();
    await expect(publicHttpsUrl("https://127.0.0.1/a.mp4", publicDns)).rejects.toThrow();
  });
});
