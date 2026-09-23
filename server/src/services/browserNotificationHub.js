const { randomUUID } = require("crypto");

const PILOT_FLAG = "MTI_BROWSER_CERTIFICATE_NOTIFICATIONS";
const ALLOWED_EVENTS = new Set(["CERTIFICATE_REQUEST_CREATED", "CERTIFICATE_RELEASED"]);
const MAX_CONNECTIONS = 100;

function isEnabled(env = process.env) {
  return String(env[PILOT_FLAG] || "").trim() === "1";
}

function createBrowserNotificationHub({ env = process.env, maxConnections = MAX_CONNECTIONS } = {}) {
  const subscribers = new Set();

  function publish(scope, eventType) {
    if (!isEnabled(env) || !ALLOWED_EVENTS.has(eventType)) return null;
    const event = Object.freeze({ eventId: randomUUID(), eventType });
    for (const subscriber of subscribers) {
      if (subscriber.scope !== scope) continue;
      try {
        if (!subscriber.authorize()) {
          subscribers.delete(subscriber);
          continue;
        }
      } catch {
        subscribers.delete(subscriber);
        continue;
      }
      try {
        subscriber.write(event);
      } catch {
        subscribers.delete(subscriber);
      }
    }
    return event.eventId;
  }

  function subscribe(scope, write, authorize = () => true) {
    if (!isEnabled(env)) return () => {};
    if (subscribers.size >= maxConnections) throw Object.assign(new Error("BROWSER_NOTIFICATION_CONNECTION_LIMIT"), { code: "BROWSER_NOTIFICATION_CONNECTION_LIMIT" });
    const subscriber = { scope, write, authorize };
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  }

  return {
    isEnabled: () => isEnabled(env),
    publishAdmin: (eventType) => publish("admin", eventType),
    publishComputer: (computerId, eventType) => publish(`computer:${Number(computerId)}`, eventType),
    subscribe,
    connectionCount: () => subscribers.size,
    PILOT_FLAG,
    ALLOWED_EVENTS
  };
}

const browserNotificationHub = createBrowserNotificationHub();

module.exports = { PILOT_FLAG, ALLOWED_EVENTS, isEnabled, createBrowserNotificationHub, browserNotificationHub };
