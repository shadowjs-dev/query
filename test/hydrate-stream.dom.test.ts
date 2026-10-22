import { flush, renderHook } from "@shadow-js/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hydration } from "../src/hydration";
import { createQueryClient, useQuery } from "../src/index";
import { createDehydrationStream, hydrateFromStream } from "../src/server";
import { probe } from "./support/probe";

/** Pretends the document is still being parsed (or not), as `document.readyState` reports it. */
function setReadyState(state: "loading" | "interactive" | "complete"): void {
  Object.defineProperty(document, "readyState", { configurable: true, get: () => state });
}

/** A server client with a stream; `fill` writes queries and returns the chunk `next()` gave. */
function serverChunk(
  fill: (client: ReturnType<typeof createQueryClient>) => void,
  id?: string,
): string {
  const client = createQueryClient({ features: [hydration] });
  const stream = createDehydrationStream(client, id === undefined ? {} : { id });
  fill(client);
  return stream.next();
}

/** Appends markup the way a streaming parser would: node by node, at the end of the body. */
function append(markup: string): void {
  const holder = document.createElement("div");
  holder.innerHTML = markup;
  for (const node of [...holder.childNodes]) document.body.append(node);
}

afterEach(() => {
  document.body.innerHTML = "";
  Reflect.deleteProperty(document, "readyState");
  vi.useRealTimers();
});

describe("hydrateFromStream", () => {
  it("[QRY-W7] chunks already in the page seed the client, and a mounted query does not fetch while fresh", async () => {
    document.body.innerHTML = `${serverChunk((client) => client.setCache(["user", 1], { name: "Ada" }))}<main></main>`;
    const browser = createQueryClient({ features: [hydration] });
    const stop = hydrateFromStream(browser);
    const fn = probe<{ name: string }>();
    const view = renderHook(() =>
      useQuery(["user", 1], fn.fetch, { client: browser, staleTime: 60_000 }),
    );
    expect(view.result.current.data()).toEqual({ name: "Ada" });
    expect(view.result.current.status()).toBe("success");
    expect(fn.calls()).toBe(0);
    view.dispose();
    stop();
  });

  it("[QRY-W8] chunks the parser adds later are applied as they complete, the last one at DOMContentLoaded at the latest", async () => {
    setReadyState("loading");
    const browser = createQueryClient({ features: [hydration] });
    const stop = hydrateFromStream(browser);
    expect(browser.getCache(["early"])).toBeUndefined();
    // The shell chunk, followed by app markup: complete once something follows it.
    append(serverChunk((client) => client.setCache(["early"], "shell")));
    append("<main>app</main>");
    await flush();
    expect(browser.getCache(["early"])).toBe("shell");
    // A chunk streamed later with nothing after it yet: its newline is the sibling that marks it complete.
    append(serverChunk((client) => client.setCache(["late"], "streamed")));
    await flush();
    expect(browser.getCache(["late"])).toBe("streamed");
    // An element whose end tag the parser has not seen: no sibling at all, so it is not read half-received.
    const open = document.createElement("script");
    open.setAttribute("type", "application/json");
    open.setAttribute("data-shadow-query", "__shadow_query_state__");
    document.body.append(open);
    const half = serverChunk((client) => client.setCache(["last"], "tail"));
    open.textContent = half.slice(half.indexOf(">") + 1, half.lastIndexOf("</script>"));
    await flush();
    expect(browser.getCache(["last"])).toBeUndefined();
    setReadyState("interactive");
    document.dispatchEvent(new Event("DOMContentLoaded"));
    expect(browser.getCache(["last"])).toBe("tail");
    stop();
  });

  it("[QRY-W9] a stale chunk is shown at once and refetched, a newer chunk replaces an older one, and one chunk is read once", async () => {
    document.body.innerHTML = "";
    const browser = createQueryClient({ features: [hydration] });
    browser.setCache(["fresh"], "browser-newer", { updatedAt: Date.now() + 1000 });
    const chunk = serverChunk((client) => {
      client.setCache(["fresh"], "server-older");
      client.setCache(["old"], "stale-server", { updatedAt: Date.now() - 120_000 });
    });
    append(chunk);
    const stop = hydrateFromStream(browser);
    expect(browser.getCache(["fresh"])).toBe("browser-newer");
    const fn = probe<string>();
    const view = renderHook(() =>
      useQuery(["old"], fn.fetch, { client: browser, staleTime: 60_000 }),
    );
    expect(view.result.current.data()).toBe("stale-server");
    expect(fn.calls()).toBe(1);
    // A second sweep (another mutation) does not read the same element again.
    const hydrate = vi.spyOn(browser, "hydrate");
    append("<p>more</p>");
    await flush();
    expect(hydrate).not.toHaveBeenCalled();
    fn.resolve(0, "refetched");
    await flush();
    view.dispose();
    stop();
  });

  it("[QRY-W10] a chunk that is not valid is reported on a microtask, not thrown, and the chunks after it still apply", async () => {
    const good = serverChunk((client) => client.setCache(["ok"], 1));
    append(
      '<script type="application/json" data-shadow-query="__shadow_query_state__">{not json</script>\n',
    );
    append(good);
    const failures: unknown[] = [];
    const queue = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((task) => {
      try {
        task();
      } catch (error) {
        failures.push(error);
      }
    });
    const browser = createQueryClient({ features: [hydration] });
    expect(() => hydrateFromStream(browser)).not.toThrow();
    queue.mockRestore();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(SyntaxError);
    expect(browser.getCache(["ok"])).toBe(1);
  });

  it("[QRY-W11] stop removes the observer and the listener; another name is a separate stream; a bad name is refused", async () => {
    setReadyState("loading");
    const removed = vi.spyOn(document, "removeEventListener");
    const browser = createQueryClient({ features: [hydration] });
    const stop = hydrateFromStream(browser, { id: "mine" });
    stop();
    expect(removed.mock.calls.some((call) => call[0] === "DOMContentLoaded")).toBe(true);
    append(serverChunk((client) => client.setCache(["after-stop"], 1), "mine"));
    append("<p>x</p>");
    await flush();
    expect(browser.getCache(["after-stop"])).toBeUndefined();
    const other = createQueryClient({ features: [hydration] });
    append(serverChunk((client) => client.setCache(["theirs"], 1), "theirs"));
    append("<p>y</p>");
    const stopOther = hydrateFromStream(other, { id: "mine" });
    expect(other.getCache(["theirs"])).toBeUndefined();
    stopOther();
    expect(() => hydrateFromStream(other, { id: 'x"]' })).toThrow(TypeError);
  });

  it("[QRY-W12] a document that is already parsed is read once and no observer is left behind", () => {
    setReadyState("complete");
    const add = vi.spyOn(document, "addEventListener");
    append(serverChunk((client) => client.setCache(["done"], 2)));
    const browser = createQueryClient({ features: [hydration] });
    const stop = hydrateFromStream(browser);
    expect(browser.getCache(["done"])).toBe(2);
    expect(add.mock.calls.some((call) => call[0] === "DOMContentLoaded")).toBe(false);
    stop();
  });
});
