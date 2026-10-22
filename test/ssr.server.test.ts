import { isServer } from "@shadow-js/core";
import { renderHook } from "@shadow-js/testing";
import { escape as escapeHtml, renderToString, ssr } from "@shadow-js/web/server";
import { describe, expect, it } from "vitest";
import { hydration } from "../src/hydration";
import { createQueryClient, useQuery } from "../src/index";
import { createDehydrationStream, dehydrateScript } from "../src/server";
import { probe } from "./support/probe";

describe("query on the server", () => {
  it("[QRY-SV1] the server build is the server build, and useQuery never fetches there", () => {
    expect(isServer).toBe(true);
    const qc = createQueryClient({ features: [hydration] });
    const fn = probe<number>();
    const view = renderHook(() => useQuery(["ssr-empty"], fn.fetch, { client: qc }));
    expect(fn.calls()).toBe(0);
    expect(view.result.current.data()).toBeUndefined();
    expect(view.result.current.status()).toBe("pending");
    view.dispose();
  });

  it("[QRY-SV2] data prefetched in the request is rendered, and dehydrated for the browser", async () => {
    const request = createQueryClient({
      features: [hydration],
      defaultOptions: { queries: { retry: false } },
    });
    await request.prefetch(["ssr-user", 7], () => ({ name: "Grace" }));
    const view = renderHook(() =>
      useQuery(["ssr-user", 7], () => Promise.resolve({ name: "other" }), { client: request }),
    );
    expect(view.result.current.data()).toEqual({ name: "Grace" });
    view.dispose();
    const html = dehydrateScript(request.dehydrate());
    expect(html).toContain("Grace");
  });

  it("[QRY-SV3] two requests get two clients: no data leaks between them", async () => {
    const first = createQueryClient({ features: [hydration] });
    const second = createQueryClient({ features: [hydration] });
    first.setCache(["private"], "alice");
    expect(second.getCache(["private"])).toBeUndefined();
    expect(second.dehydrate().queries).toEqual([]);
  });

  it("[QRY-SV4] a browser can be seeded from the state the server wrote", () => {
    const server = createQueryClient({ features: [hydration] });
    server.setCache(["list"], [1, 2, 3]);
    const html = dehydrateScript(server.dehydrate());
    const body = html.slice(html.indexOf(">") + 1, html.lastIndexOf("</script>"));
    const browser = createQueryClient({ features: [hydration] });
    browser.hydrate(JSON.parse(body));
    expect(browser.getCache(["list"])).toEqual([1, 2, 3]);
  });

  it("[QRY-SV5] with the real renderer: a query awaited before the shell is sent with it, one that finishes later is appended, and no data can close the script", async () => {
    const request = createQueryClient({
      features: [hydration],
      defaultOptions: { queries: { retry: false } },
    });
    await request.prefetch(["user", 1], () => ({ name: "Ada </script><b>" }));
    const slow = probe<{ n: number }>();
    const pending = request.prefetch(["stats"], slow.fetch);
    const stream = createDehydrationStream(request);
    const Page = () => {
      const user = useQuery(["user", 1], () => Promise.resolve({ name: "other" }), {
        client: request,
      });
      const stats = useQuery(["stats"], slow.fetch, { client: request });
      return ssr(
        ["<main><p>", "</p><p>", "</p></main>"],
        escapeHtml(user.data()?.name ?? "no user"),
        escapeHtml(String(stats.data()?.n ?? "loading")),
      );
    };
    const shell = renderToString(Page);
    const first = stream.next();
    // The slow query was not ready for the shell; the browser would show its loading state.
    expect(shell).toContain("Ada &lt;/script&gt;&lt;b&gt;");
    expect(shell).toContain("<p>loading</p>");
    expect(first).toContain('"user"');
    expect(first).not.toContain('"stats"');
    slow.resolve(0, { n: 5 });
    await pending;
    const second = stream.next();
    expect(second).toContain('"stats"');
    expect(second).not.toContain('"user"');
    expect(stream.next()).toBe("");
    // Nothing in the page can end a script element early: only our own elements close.
    const page = shell + first + second;
    expect(page.match(/<\/script>/g)).toHaveLength(2);
    expect(page.match(/<script/g)).toHaveLength(2);
    expect(page).not.toContain("<b>");
  });
});
