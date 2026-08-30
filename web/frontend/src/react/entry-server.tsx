/**
 * Server entry for the public SSR routes. Built as a separate Vite SSR
 * bundle (vite.ssr.config.ts → dist-ssr/) and imported by the Pages Function
 * functions/comp/[[path]].ts, which runs the route loader, calls render() with
 * the URL + loader data, and splices the streamed markup into the /app shell.
 *
 * No `window`/`document`/CSS side effects here — this runs in workerd. The
 * toaster (a body-level portal) and the dark-mode listener live in the client
 * entry only; omitting them server-side changes no #root markup.
 */
import { renderToReadableStream } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { InitialDataProvider, type InitialData } from "./lib/initial-data";
import { AppProviders, AppRoutes } from "./routes";

/**
 * Render one of the public routes to an HTML stream. `initialData` is the
 * loader result for `url`; it is both handed to the React tree (so the server
 * markup matches) and, by the caller, serialized into `window.__SSR_DATA__`
 * for the client to hydrate from.
 */
export async function render(
  url: string,
  initialData: InitialData
): Promise<ReadableStream<Uint8Array>> {
  // Pathname AND search: several public pages read view state from the query
  // (`?class=` on both analysis pages, `?thermal=` on the thermals section,
  // `?metric=` on the strategies ranking, `?task=` on the scores page), and the
  // client's first render always sees it. Rendering the pathname alone made
  // the server pick the default view and the client hydrate a different one —
  // a mismatch on every shared deep link. The fragment never reaches a
  // server, so there is nothing to carry there.
  const { pathname, search } = new URL(url, "http://ssr.local");
  return renderToReadableStream(
    <AppProviders initialUser={initialData.user}>
      <StaticRouter location={pathname + search}>
        <InitialDataProvider value={initialData}>
          <AppRoutes />
        </InitialDataProvider>
      </StaticRouter>
    </AppProviders>,
    {
      onError(error) {
        // Surface render errors in the Function logs; the caller still falls
        // back to the plain SPA shell so the page is never worse than today.
        console.error("SSR render error:", error);
      },
    }
  );
}
