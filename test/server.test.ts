import { describe, expect, it } from "vitest";
import { hydration } from "../src/hydration";
import { createQueryClient } from "../src/index";
import { createDehydrationStream, dehydrateScript } from "../src/server";

describe("dehydrateScript", () => {
  it("[QRY-W3] the JSON cannot close its script element or open a comment, and parses back equal", () => {
    const client = createQueryClient({ features: [hydration] });
    const hostile = { text: "</script><script>alert(1)</script><!-- & \u2028\u2029" };
    client.setCache(["hostile"], hostile);
    const html = dehydrateScript(client.dehydrate());
    const body = html.slice(html.indexOf(">") + 1, html.lastIndexOf("</script>"));
    expect(body.includes("<")).toBe(false);
    expect(body.includes(">")).toBe(false);
    expect(body.includes("&")).toBe(false);
    expect(body.includes("\u2028")).toBe(false);
    const parsed = JSON.parse(body) as { queries: Array<{ data: unknown }> };
    expect(parsed.queries[0]?.data).toEqual(hostile);
    expect(html.startsWith('<script type="application/json" id="__shadow_query_state__">')).toBe(
      true,
    );
  });

  it("[QRY-W4] an element id that is not a plain identifier is refused", () => {
    const client = createQueryClient({ features: [hydration] });
    expect(() => dehydrateScript(client.dehydrate(), 'x"><img src=x onerror=1>')).toThrow(
      TypeError,
    );
  });
});

describe("createDehydrationStream", () => {
  /** The JSON of the chunk elements in `html`, in order. */
  function chunksOf(html: string): Array<{ queries: Array<{ key: unknown[]; data: unknown }> }> {
    return [...html.matchAll(/<script [^>]*>([^<]*)<\/script>/g)].map(
      (match) =>
        JSON.parse(match[1] ?? "null") as { queries: Array<{ key: unknown[]; data: unknown }> },
    );
  }

  it("[QRY-W5] each call sends only what finished since the last one, and nothing when nothing did", async () => {
    const client = createQueryClient({ features: [hydration] });
    const stream = createDehydrationStream(client);
    expect(stream.next()).toBe("");
    client.setCache(["fast"], 1);
    const first = stream.next();
    expect(
      first.startsWith(
        '<script type="application/json" data-shadow-query="__shadow_query_state__">',
      ),
    ).toBe(true);
    expect(first).not.toContain(" id=");
    expect(chunksOf(first).map((chunk) => chunk.queries.map((query) => query.key))).toEqual([
      [["fast"]],
    ]);
    expect(stream.next()).toBe("");
    // A query that finishes after the shell is appended on its own.
    await client.prefetch(["slow"], () => Promise.resolve(2));
    const second = chunksOf(stream.next());
    expect(second.map((chunk) => chunk.queries.map((query) => query.key))).toEqual([[["slow"]]]);
    expect(stream.next()).toBe("");
    // The same query written again with newer data is sent again.
    client.setCache(["fast"], 3, { updatedAt: Date.now() + 10 });
    expect(chunksOf(stream.next())[0]?.queries[0]?.data).toBe(3);
  });

  it("[QRY-W6] the chunk cannot close its script element, an id must be an identifier, and a selection narrows the queries", () => {
    const client = createQueryClient({ features: [hydration] });
    client.setCache(["hostile"], { text: "</script><script>alert(1)</script><!--" });
    client.setCache(["private"], "secret");
    const stream = createDehydrationStream(client, {
      id: "my-state",
      shouldDehydrate: (query) => query.queryKey[0] !== "private",
    });
    const html = stream.next();
    expect(html).toContain('data-shadow-query="my-state"');
    expect(html).not.toContain("secret");
    expect(html.slice(html.indexOf(">") + 1, html.lastIndexOf("</script>"))).not.toContain("<");
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(() => createDehydrationStream(client, { id: 'x"><img src=x>' })).toThrow(TypeError);
  });
});
