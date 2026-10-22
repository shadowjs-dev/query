/**
 * SSR helpers that carry a dehydrated query state from the server to the browser. The server writes
 * the state into the page as a JSON script element; the browser reads it back before the first
 * render. For a streamed response, `createDehydrationStream` appends the queries that finish after the
 * shell, and `hydrateFromStream` reads them as the browser parses them. This subpath does not import the
 * renderer, so it works with any server that can write a string.
 *
 * @packageDocumentation
 * @since 1.0.0
 */
import type {
  DehydratedState,
  DehydrationStream,
  DehydrationStreamOptions,
  HydrateStreamOptions,
  QueryClient,
  QueryInfo,
} from "./types";

export type { DehydrationStream, DehydrationStreamOptions, HydrateStreamOptions };

const DEFAULT_ID = "__shadow_query_state__";
const ID_PATTERN = /^[A-Za-z_][\w-]*$/;
const CHUNK_ATTRIBUTE = "data-shadow-query";

/** The JSON of a state with the characters that could end a script element or a comment escaped. */
function escapedJson(state: DehydratedState): string {
  return JSON.stringify(state)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Renders a dehydrated state as a `<script type="application/json">` element, for the server to put
 * in the page it sends. The JSON is escaped so that no value can close the script element or start
 * an HTML comment, and it parses back to an equal state. Runs anywhere; it needs no DOM.
 *
 * @param state The state from `client.dehydrate()`.
 * @param id The element id: a letter or `_`, then letters, digits, `_` or `-`. Undefined uses
 * `__shadow_query_state__`, the id {@link hydrateFromDocument} reads by default.
 * @returns The HTML of the element.
 * @throws TypeError (`dehydrateScript: invalid id`) when `id` is not such an identifier.
 * @example
 * import { createQueryClient } from "@shadow-js/query";
 * import { dehydrateScript } from "@shadow-js/query/server";
 *
 * // On the server, once per request:
 * async function stateScript(): Promise<string> {
 *   const client = createQueryClient();
 *   await client.prefetch(["todos"], () => Promise.resolve(["read the docs"]));
 *   return dehydrateScript(client.dehydrate()); // put it in the page before the app script
 * }
 * @see hydrateFromDocument
 * @since 1.0.0
 */
export function dehydrateScript(state: DehydratedState, id: string = DEFAULT_ID): string {
  if (!ID_PATTERN.test(id)) throw new TypeError(`dehydrateScript: invalid id "${id}"`);
  return `<script type="application/json" id="${id}">${escapedJson(state)}</script>`;
}

/**
 * Seeds `client` from the state element written by {@link dehydrateScript}. Call it in the browser
 * before the first render, so the first read finds the server data and does not fetch it while it
 * is fresh. Entries the client already holds with data at least as recent are kept.
 *
 * @param client The client to seed.
 * @param id The id of the element. Undefined uses `__shadow_query_state__`, the default of
 * {@link dehydrateScript}.
 * @throws Error when there is no `document` (on the server) or no element with that id.
 * @throws SyntaxError when the text of the element is not JSON.
 * @throws TypeError when the parsed value is not a dehydrated state (see `QueryClient.hydrate`).
 * @example
 * import { createQueryClient } from "@shadow-js/query";
 * import { hydrateFromDocument } from "@shadow-js/query/server";
 *
 * // In the browser, before the first render:
 * const client = createQueryClient();
 * hydrateFromDocument(client);
 * @see dehydrateScript
 * @since 1.0.0
 */
export function hydrateFromDocument(client: QueryClient, id: string = DEFAULT_ID): void {
  if (typeof document === "undefined") {
    throw new Error("hydrateFromDocument: no document; call it in the browser");
  }
  const element = document.getElementById(id);
  if (element === null) throw new Error(`hydrateFromDocument: no element #${id}`);
  client.hydrate(JSON.parse(element.textContent ?? "null"));
}

/**
 * Starts a streamed query state for one response: each `next()` returns the queries that finished since
 * the last call, as a `<script>` element to write into the page. The first call (before the shell is
 * sent) carries what the request awaited; later calls carry queries that finish while the page streams.
 * A query is sent once, and again only if its data changes. The browser reads the elements with
 * {@link hydrateFromStream}. The JSON is escaped as in {@link dehydrateScript}.
 *
 * @param client The request's client; it needs the `hydration` feature.
 * @param options The element name and the selection (see {@link DehydrationStreamOptions}). Undefined
 * uses the default name and the successful queries.
 * @returns The stream.
 * @throws TypeError (`createDehydrationStream: invalid id`) when `options.id` is not an identifier.
 * @example
 * import { createQueryClient } from "@shadow-js/query";
 * import { hydration } from "@shadow-js/query/hydration";
 * import { createDehydrationStream } from "@shadow-js/query/server";
 *
 * async function respond(write: (html: string) => void): Promise<void> {
 *   const client = createQueryClient({ features: [hydration] });
 *   const stream = createDehydrationStream(client);
 *   const slow = client.prefetch(["stats"], () => Promise.resolve({ visits: 3 }));
 *   write("<main>shell</main>");
 *   write(stream.next()); // what finished before the shell was sent: possibly nothing
 *   await slow;
 *   write(stream.next()); // appended when the slow query finishes
 * }
 * @see hydrateFromStream
 * @since 1.0.0
 */
export function createDehydrationStream(
  client: QueryClient,
  options: DehydrationStreamOptions = {},
): DehydrationStream {
  const id = options.id ?? DEFAULT_ID;
  if (!ID_PATTERN.test(id)) throw new TypeError(`createDehydrationStream: invalid id "${id}"`);
  const select =
    options.shouldDehydrate ??
    ((info: QueryInfo): boolean => info.status === "success" && info.data !== undefined);
  /** What was sent, by hash: sending the same data again is skipped. */
  const sent = new Map<string, { readonly data: unknown; readonly updatedAt: number }>();
  return {
    next(): string {
      const state = client.dehydrate({
        shouldDehydrate: (info) => {
          const before = sent.get(info.queryHash);
          const changed =
            before === undefined ||
            before.updatedAt !== info.dataUpdatedAt ||
            before.data !== info.data;
          return changed && select(info) !== false;
        },
      });
      if (state.queries.length === 0) return "";
      for (const query of state.queries) {
        sent.set(query.hash, { data: query.data, updatedAt: query.updatedAt });
      }
      return `<script type="application/json" ${CHUNK_ATTRIBUTE}="${id}">${escapedJson(state)}</script>\n`;
    },
  };
}

/**
 * Seeds `client` from the elements written by {@link createDehydrationStream}, the ones already in the
 * page and the ones the browser parses later while the response streams in. Call it in the browser
 * before the first render. An element is read once it is complete, so a half-received one is never
 * parsed; the last one is read at `DOMContentLoaded` at the latest. Entries the client already holds
 * with data at least as recent are kept, so a query is not fetched again while its `staleTime` allows.
 * A chunk that is not valid does not throw: the error is rethrown on a microtask and later chunks still
 * apply.
 *
 * @param client The client to seed; it needs the `hydration` feature.
 * @param options The element name (see {@link HydrateStreamOptions}). Undefined uses the default.
 * @returns A function that stops reading new elements. Call it when the app unmounts; the observer
 * also stops by itself once the document has loaded.
 * @throws Error when there is no `document` (on the server).
 * @throws TypeError (`hydrateFromStream: invalid id`) when `options.id` is not an identifier.
 * @example
 * import { createQueryClient } from "@shadow-js/query";
 * import { hydration } from "@shadow-js/query/hydration";
 * import { hydrateFromStream } from "@shadow-js/query/server";
 *
 * // In the browser, before the first render:
 * const client = createQueryClient({ features: [hydration] });
 * const stop = hydrateFromStream(client);
 * @see createDehydrationStream
 * @since 1.0.0
 */
export function hydrateFromStream(
  client: QueryClient,
  options: HydrateStreamOptions = {},
): () => void {
  if (typeof document === "undefined") {
    throw new Error("hydrateFromStream: no document; call it in the browser");
  }
  const id = options.id ?? DEFAULT_ID;
  if (!ID_PATTERN.test(id)) throw new TypeError(`hydrateFromStream: invalid id "${id}"`);
  const selector = `script[${CHUNK_ATTRIBUTE}="${id}"]`;
  const applied = new WeakSet<Element>();
  /** Reads every complete element that was not read yet. */
  const sweep = (): void => {
    for (const element of document.querySelectorAll(selector)) {
      // The parser has moved past an element once something follows it, or once the document is parsed.
      if (applied.has(element)) continue;
      if (element.nextSibling === null && document.readyState === "loading") continue;
      applied.add(element);
      try {
        client.hydrate(JSON.parse(element.textContent ?? "null"));
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  };
  sweep();
  if (document.readyState !== "loading") return () => undefined;
  const observer = new MutationObserver((records) => {
    if (records.some((record) => record.addedNodes.length > 0)) sweep();
  });
  observer.observe(document, { childList: true, subtree: true });
  const stop = (): void => {
    observer.disconnect();
    document.removeEventListener("DOMContentLoaded", loaded);
  };
  function loaded(): void {
    sweep();
    stop();
  }
  document.addEventListener("DOMContentLoaded", loaded);
  return stop;
}
