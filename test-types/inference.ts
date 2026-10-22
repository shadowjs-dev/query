/**
 * Type tests: compiled by `tsc -p tsconfig.test-types.json`, never executed. Each assignment checks
 * an inferred type; each `@ts-expect-error` checks that misuse is rejected.
 */
import {
  createQueryClient,
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
} from "../src/index";

const client = createQueryClient();

// [QRY-T1] the data type comes from the query function; the key must be an array.
const todos = useQuery(["todos"], () => Promise.resolve([{ id: 1, title: "a" }]), { client });
const list: { readonly id: number; readonly title: string }[] | undefined = todos.data();
void list;
// @ts-expect-error a query key is an array, not a string
useQuery("todos", () => 1, { client });

// [QRY-T2] select changes the type of data(), not of refetch().
const count = useQuery(["n"], () => [1, 2, 3], { client, select: (items) => items.length });
const size: number | undefined = count.data();
void size;
const refetched: Promise<number[] | undefined> = count.refetch();
void refetched;
// @ts-expect-error data() is the selected number, not the array
const wrong: string | undefined = count.data();
void wrong;

// [QRY-T3] useQueries keeps one result type per definition, in order.
const [first, second] = useQueries([
  { key: ["a"], queryFn: () => 1 },
  { key: ["b"], queryFn: () => Promise.resolve("two") },
] as const);
const firstValue: number | undefined = first.data();
const secondValue: string | undefined = second.data();
void firstValue;
void secondValue;

// [QRY-T4] mutateAsync resolves with the mutation's data; variables are typed.
const save = useMutation((title: string) => Promise.resolve({ id: title.length }), { client });
const saved: Promise<{ readonly id: number }> = save.mutateAsync("hi");
void saved;
// @ts-expect-error the variables are a string
save.mutate(42);

// [QRY-T5] infinite pages: the data is InfiniteData of the page type.
const feed = useInfiniteQuery(
  ["feed"],
  ({ pageParam }) => Promise.resolve({ items: [pageParam], next: pageParam + 1 }),
  {
    client,
    initialPageParam: 0,
    getNextPageParam: (last) => last.next,
  },
);
const pages: InfiniteData<{ readonly items: number[]; readonly next: number }, number> | undefined =
  feed.data();
void pages;
