// src/utils/payments/index.js
//
// Provider bootstrap.
//
// Registration happens on import, so WHICH modules are imported decides which
// providers exist. The mock is deliberately excluded from production: a test
// provider that pays on command must not be one configuration mistake away from
// a live customer.
//
// Real providers are added here as they are built; each one is inert until the
// client has filled in its credentials, because config.ready gates it.
//
import { listProviders, getProvider } from "./provider.js";

const allowMock =
  process.env.PAYMENT_ALLOW_MOCK === "1" || process.env.NODE_ENV !== "production";

if (allowMock) {
  await import("./mock.js");
}

export { listProviders, getProvider };
export * from "./provider.js";
export * from "./stateMachine.js";
export * from "./config.js";
