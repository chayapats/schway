import { expect, test } from "bun:test";
import { createWebFetchTool, webFetchTool, type WebFetchOptions } from "../src/tools/web-fetch.ts";
import { connectWebAddress } from "../src/tools/web-transport.ts";

const context = { workspace: { root: "/tmp/project", launchCwd: "/tmp/project", extraRoots: [] } };
const run = (url: string, options: WebFetchOptions = {}) => createWebFetchTool(options).execute({ url }, context);
const publicAddress = { address: "93.184.216.34", family: 4 as const };
const denied = [
  "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "127.0.0.1", "127.255.255.254",
  "100.64.0.0", "100.100.100.200", "100.127.255.255", "169.254.0.1", "169.254.169.254",
  "172.16.0.0", "172.31.255.255", "192.168.0.1", "192.168.255.255", "192.0.0.192",
  "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
  "[::]", "[::1]", "[fc00::1]", "[fdff::1]", "[fe80::1]", "[febf::1]", "[ff02::1]",
  "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::127.0.0.1]", "[::ffff:0:127.0.0.1]",
  "[64:ff9b::7f00:1]", "[64:ff9b:1::a00:1]", "[2002:7f00:1::]", "[2001::1]", "[2606:4700:1:2:0:5efe:127.0.0.1]",
  "2130706433", "0177.0.0.1", "0x7f000001", "127.1", "0x7f.1",
];
for (const host of denied) test(`default guard blocks ${host} before connecting`, async () => {
  const normalized = new URL(`http://${host}/`).hostname;
  const address = normalized.replace(/^\[|\]$/g, "");
  for (const url of [`http://${host}/`, "http://resolved.example/"]) {
    let connects = 0;
    const result = await run(url, {
      resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
      connect: async () => { connects++; return new Response("unexpected"); },
    });
    expect(result).toMatchObject({ isError: true, details: { errorKind: "blocked-address" } });
    expect(connects).toBe(0);
    expect(JSON.stringify(result)).not.toContain(address);
  }
});

for (const host of ["localhost", "LOCALHOST.", "api.localhost", "metadata", "metadata.google.internal", "metadata.google.internal.", "instance-data.ec2.internal"]) {
  test(`metadata/local alias ${host} is refused even with a public DNS fixture`, async () => {
    let calls = 0;
    const result = await run(`http://${host}/`, { resolve: async () => { calls++; return [publicAddress]; }, connect: async () => { calls++; return new Response("bad"); } });
    expect(result).toMatchObject({ isError: true, details: { errorKind: "blocked-address" } });
    expect(calls).toBe(0);
  });
}

test("resolved private addresses and mixed public/private answers fail closed without disclosure", async () => {
  for (const addresses of [[{ address: "10.1.2.3", family: 4 as const }], [publicAddress, { address: "10.1.2.3", family: 4 as const }]]) {
    const result = await run("https://private.example/", { resolve: async () => addresses, connect: async () => { throw Error("Must not connect"); } });
    expect(result).toMatchObject({ isError: true, details: { errorKind: "blocked-address" } });
    expect(JSON.stringify(result)).not.toContain("10.1.2.3");
  }
});

test("each redirect resolves again, so a rebinding name cannot reach its private second answer", async () => {
  let resolutions = 0, connects = 0;
  const result = await run("https://rebind.example/first", {
    resolve: async () => ++resolutions === 1 ? [publicAddress] : [{ address: "127.0.0.1", family: 4 }],
    connect: async (_url, _init, address) => {
      connects++; expect(address).toEqual(publicAddress);
      return new Response(null, { status: 302, headers: { Location: "/second" } });
    },
  });
  expect(result).toMatchObject({ isError: true, details: { errorKind: "blocked-address" } });
  expect([resolutions, connects]).toEqual([2, 1]);
  expect(JSON.stringify(result)).not.toContain("127.0.0.1");
});

test("a public response redirecting to private literal never connects to the second hop", async () => {
  const seen: string[] = [];
  const result = await run("https://public.example/", { resolve: async () => [publicAddress],
    connect: async url => { seen.push(url); return new Response(null, { status: 307, headers: { Location: "http://169.254.169.254/latest" } }); } });
  expect(result).toMatchObject({ isError: true, details: { errorKind: "blocked-address" } });
  expect(seen).toEqual(["https://public.example/"]);
  expect(JSON.stringify(result)).not.toContain("169.254.169.254");
});

test("public IPv4/IPv6 and range neighbors are allowed, and the selected address is passed to connect", async () => {
  for (const address of ["93.184.216.34", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "2606:4700:4700::1111"]) {
    let calls = 0;
    const result = await run("https://public.example/", { resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
      connect: async (_url, init, pinned) => { calls++; expect(pinned.address).toBe(address); expect(init.credentials).toBe("omit"); return new Response("ok"); } });
    expect(result.isError).toBeUndefined(); expect(calls).toBe(1);
  }
});

test("allowlist only tightens baseline; local access requires the named development opt-in", async () => {
  const connect = async () => new Response("ok");
  const resolve = async () => [publicAddress];
  expect(await run("https://public.example/", { allowHosts: [], resolve, connect })).toMatchObject({ isError: true });
  expect(await run("https://public.example/", { allowHosts: ["public.example"], resolve, connect })).not.toHaveProperty("isError");
  expect(await run("http://127.0.0.1/", { allowHosts: ["127.0.0.1"], connect })).toMatchObject({ isError: true });
  expect(await run("http://127.0.0.1/", { dangerouslyAllowPrivateAddressesForDevelopment: true, connect })).not.toHaveProperty("isError");
  expect(await webFetchTool.execute({ url: "http://127.0.0.1/" }, context)).toMatchObject({ isError: true, details: { errorKind: "blocked-address" } });
});

test("production transport connects to the supplied IP without resolving the URL hostname and preserves Host", async () => {
  const hosts: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { hosts.push(request.headers.get("host")!); return new Response("pinned"); } });
  try {
    const response = await connectWebAddress(`http://never-resolve.invalid:${server.port}/`, { signal: new AbortController().signal }, { address: "127.0.0.1", family: 4 });
    expect(await response.text()).toBe("pinned");
    expect(hosts).toEqual([`never-resolve.invalid:${server.port}`]);
  } finally { server.stop(true); }
});


test("malformed resolver families cannot bypass numeric-address validation, even in development", async () => {
  const result = await run("http://fixture.example/", {
    dangerouslyAllowPrivateAddressesForDevelopment: true,
    resolve: async () => [{ address: "unchecked.invalid", family: 0 }] as never,
    connect: async () => { throw Error("must not connect"); },
  });
  expect(result).toMatchObject({ isError: true, details: { errorKind: "blocked-address" } });
});


test("production transport accepts 204 and 205 without constructing a forbidden response body", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { return new Response(null, { status: Number(new URL(request.url).pathname.slice(1)) }); } });
  try {
    for (const status of [204, 205]) {
      const result = await run(`http://127.0.0.1:${server.port}/${status}`, { dangerouslyAllowPrivateAddressesForDevelopment: true });
      expect(result.isError).toBeUndefined(); expect(result.details).toMatchObject({ status, rawBytes: 0 });
    }
  } finally { server.stop(true); }
});
