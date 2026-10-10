import { createApi } from "@glidecomp/client/api";

export const api = createApi("/", (input, init) =>
  fetch(input, { ...init, credentials: "include" })
);
