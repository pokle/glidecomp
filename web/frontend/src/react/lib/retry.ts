// Moved to @glidecomp/client: the app's transport follows the same retry
// rules (issue #481; mobile plan, stage 2). Re-exported here so the website's
// imports do not change.
export { retry } from "@glidecomp/client/retry";
