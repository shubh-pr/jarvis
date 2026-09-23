import webpush from "web-push";
import { config } from "./config.js";
import { listPushSubscriptions, removePushSubscription } from "./db.js";
import type { PushSubscriptionRecord } from "./types.js";

webpush.setVapidDetails(
  config.vapidSubject,
  config.vapidPublicKey,
  config.vapidPrivateKey,
);

export interface PushPayload {
  title: string;
  body: string;
  sessionId?: string;
  url?: string;
}

async function sendToOne(
  sub: PushSubscriptionRecord,
  payload: PushPayload,
): Promise<void> {
  const subscription = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.p256dh, auth: sub.auth },
  };
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (err: any) {
    if (err?.statusCode === 404 || err?.statusCode === 410) {
      removePushSubscription(sub.endpoint);
    } else {
      console.error("Push send failed:", err?.message ?? err);
    }
  }
}

export async function broadcastPush(payload: PushPayload): Promise<void> {
  const subs = listPushSubscriptions();
  await Promise.all(subs.map((sub) => sendToOne(sub, payload)));
}
